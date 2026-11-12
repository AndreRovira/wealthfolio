use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc};
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use rust_decimal::Decimal;
use uuid::Uuid;
use wealthfolio_core::accounts::{
    account_supports_purpose, AccountPurpose, AccountRepositoryTrait,
};
use wealthfolio_core::activities::{ActivityRepositoryTrait, ActivityServiceTrait, ActivityUpdate};
use wealthfolio_core::taxonomies::{Category, TaxonomyServiceTrait};
use wealthfolio_core::utils::time_utils::activity_date_in_user_timezone;

use super::model::*;
use super::traits::EnvelopeRepositoryTrait;
use crate::activity_allocations::{allocations_for_taxonomy, group_assignments, group_splits};
use crate::activity_assignments::ActivityTaxonomyAssignmentRepositoryTrait;
use crate::activity_classification::{
    activity_abs_amount, classify_activity_for_aggregation, within_spending_transfer_groups,
    SpendingClassification,
};
use crate::activity_splits::ActivitySplitRepositoryTrait;
use crate::fx::CalculationQuality;
use crate::settings::SpendingSettingsService;

const SPENDING_TAXONOMY: &str = "spending_categories";
const INCOME_TAXONOMY: &str = "income_sources";
const SAVINGS_TAXONOMY: &str = "savings_categories";

pub const ACTIVITY_ENVELOPE_KEY: &str = "envelope";

pub struct EnvelopeService {
    repo: Arc<dyn EnvelopeRepositoryTrait>,
    activity_repo: Arc<dyn ActivityRepositoryTrait>,
    activity_service: Arc<dyn ActivityServiceTrait + Send + Sync>,
    account_repo: Arc<dyn AccountRepositoryTrait>,
    assignment_repo: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
    split_repo: Arc<dyn ActivitySplitRepositoryTrait>,
    spending_settings: Arc<SpendingSettingsService>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    fx_service: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
}

/// (envelope_id, bill_id) — the pot an amount lands in.
type PotKey = (String, Option<String>);

/// Spend per pot, spend per envelope this month, spend per envelope this
/// quincena, income deposits, every dated flow of each bill pot, and the
/// conversions that found no rate.
type Flows = (
    HashMap<PotKey, Decimal>,
    HashMap<String, Decimal>,
    HashMap<String, Decimal>,
    Vec<(String, NaiveDate, String, Decimal)>,
    HashMap<PotKey, Vec<(NaiveDate, Decimal)>>,
    CalculationQuality,
);

/// A payment this many days before the due date still settles that due date.
const PAYMENT_WINDOW_DAYS: i64 = 10;
/// Share of the expected amount the charges near a due date must reach to
/// count as its payment; a fee or a partial charge below it settles nothing.
const PAYMENT_MIN_SHARE: f64 = 0.5;

/// Boolean flag stored in an account's JSON `meta`.
pub fn account_flag(meta: Option<&str>, key: &str) -> bool {
    meta.and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .and_then(|v| v.get(key).and_then(|f| f.as_bool()))
        .unwrap_or(false)
}

/// What the active rules put into each envelope (bill lines excluded) per
/// quincena. Monthly rules count half; biweekly and on-income fixed lines
/// count as a quincena, since the paycheck rule fires twice a month.
pub fn period_targets(rules: &[FundingRule]) -> HashMap<String, f64> {
    let mut out: HashMap<String, f64> = HashMap::new();
    for rule in rules.iter().filter(|r| r.active) {
        let factor = match rule.cadence {
            FundingCadence::Semimonthly | FundingCadence::Biweekly | FundingCadence::OnIncome => {
                1.0
            }
            FundingCadence::Monthly => 0.5,
        };
        for split in rule.splits.iter().filter(|s| s.bill_id.is_none()) {
            if let Some(amount) = split.amount {
                *out.entry(split.envelope_id.clone()).or_default() += amount * factor;
            }
        }
    }
    out
}

/// Per-quincena values the client wrote into the income plan on its last
/// save (`resolved`: plan line reference -> amount). The plan's formulas are
/// evaluated in the client only; the server reads the results.
pub fn plan_values(document: Option<&str>) -> HashMap<String, f64> {
    document
        .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
        .and_then(|v| v.get("resolved").and_then(|r| r.as_object()).cloned())
        .map(|map| {
            map.into_iter()
                .filter_map(|(k, v)| Some((k, v.as_f64()?)))
                .collect()
        })
        .unwrap_or_default()
}

/// Fill the amount of every line that has a `source`, so a change to a bill
/// or to the income plan reaches the next split without touching the rule.
/// A bill line of an archived or deleted bill resolves to zero; a plan line
/// or remainder the plan does not provide keeps its stored amount.
pub fn resolve_rules(
    mut rules: Vec<FundingRule>,
    bills: &[EnvelopeBill],
    plan: &HashMap<String, f64>,
) -> Vec<FundingRule> {
    for rule in &mut rules {
        let fundings_per_month = match rule.cadence {
            FundingCadence::Monthly => 1,
            _ => 2,
        };
        for split in &mut rule.splits {
            match split.source.as_deref() {
                None | Some(SOURCE_REMAINDER) => {}
                Some(SOURCE_BILL) => {
                    let share = bills
                        .iter()
                        .find(|b| !b.archived && Some(b.id.as_str()) == split.bill_id.as_deref())
                        .map(|b| {
                            dec(b.expected_amount)
                                / Decimal::from(cycle_months(&b.cycle) * fundings_per_month)
                        })
                        .unwrap_or_default();
                    split.amount = Some(round_half_up(share));
                }
                Some(reference) => {
                    let (sign, key) = match reference.strip_prefix('-') {
                        Some(key) => (-1.0, key),
                        None => (1.0, reference),
                    };
                    if let Some(value) = plan.get(key.trim()) {
                        split.amount = Some(f64_of(dec(sign * value)));
                    }
                }
            }
        }
        if let Some(expected) = plan.get(PLAN_EXPECTED_KEY) {
            let is_remainder = |s: &FundingSplit| s.source.as_deref() == Some(SOURCE_REMAINDER);
            let others: Decimal = rule
                .splits
                .iter()
                .filter(|s| !is_remainder(s))
                .filter_map(|s| s.amount)
                .map(dec)
                .sum();
            for split in rule.splits.iter_mut().filter(|s| is_remainder(s)) {
                split.amount = Some(f64_of(dec(*expected) - others));
            }
        }
    }
    rules
}

impl EnvelopeService {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        repo: Arc<dyn EnvelopeRepositoryTrait>,
        activity_repo: Arc<dyn ActivityRepositoryTrait>,
        activity_service: Arc<dyn ActivityServiceTrait + Send + Sync>,
        account_repo: Arc<dyn AccountRepositoryTrait>,
        assignment_repo: Arc<dyn ActivityTaxonomyAssignmentRepositoryTrait>,
        split_repo: Arc<dyn ActivitySplitRepositoryTrait>,
        spending_settings: Arc<SpendingSettingsService>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
        fx_service: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
    ) -> Self {
        Self {
            repo,
            activity_repo,
            activity_service,
            account_repo,
            assignment_repo,
            split_repo,
            spending_settings,
            taxonomy_service,
            fx_service,
        }
    }

    // ----------------------------- CRUD passthrough -----------------------------

    pub async fn list_envelopes(&self) -> Result<Vec<Envelope>> {
        self.repo.list_envelopes().await
    }
    pub async fn create_envelope(&self, input: EnvelopeInput) -> Result<Envelope> {
        require_name(&input.name)?;
        self.repo.create_envelope(input).await
    }
    pub async fn update_envelope(
        &self,
        id: &str,
        input: EnvelopeInput,
        currency: &str,
        timezone: &str,
    ) -> Result<Envelope> {
        require_name(&input.name)?;
        if input.archived == Some(true) {
            self.require_unused(id, currency, timezone).await?;
        }
        self.repo.update_envelope(id, input).await
    }
    pub async fn delete_envelope(&self, id: &str, currency: &str, timezone: &str) -> Result<()> {
        self.require_unused(id, currency, timezone).await?;
        self.repo.delete_envelope(id).await
    }
    /// An envelope leaves only once it is empty and no rule funds it: its
    /// ledger goes with it, and a rule line would keep paying into nothing.
    async fn require_unused(&self, id: &str, currency: &str, timezone: &str) -> Result<()> {
        let snapshot = self.snapshot(None, currency, timezone).await?;
        if let Some(row) = snapshot.envelopes.iter().find(|e| e.envelope.id == id) {
            if row.balance.abs() >= 0.01 {
                return Err(anyhow!(
                    "{} still holds {:.2}: move it to another envelope first",
                    row.envelope.name,
                    row.balance
                ));
            }
        }
        match snapshot.rules.iter().find(|r| {
            r.shortfall_envelope_id.as_deref() == Some(id)
                || r.splits.iter().any(|s| s.envelope_id == id)
        }) {
            Some(rule) => Err(anyhow!(
                "rule \"{}\" still funds this envelope: remove its line first",
                rule.name
            )),
            None => Ok(()),
        }
    }

    pub async fn list_bills(&self) -> Result<Vec<EnvelopeBill>> {
        self.repo.list_bills().await
    }
    pub async fn create_bill(&self, input: EnvelopeBillInput) -> Result<EnvelopeBill> {
        require_name(&input.name)?;
        if let Some(cycle) = &input.cycle {
            require_cycle(cycle)?;
        }
        self.repo.create_bill(input).await
    }
    pub async fn update_bill(&self, id: &str, input: EnvelopeBillInput) -> Result<EnvelopeBill> {
        require_name(&input.name)?;
        if let Some(cycle) = &input.cycle {
            require_cycle(cycle)?;
        }
        // The pot is (envelope, bill): entries and pins filed under the old
        // envelope would not follow the bill to a new one.
        if self
            .repo
            .list_bills()
            .await?
            .iter()
            .any(|b| b.id == id && b.envelope_id != input.envelope_id)
        {
            return Err(anyhow!(
                "a bill stays in its envelope: create it in the other one and move the money"
            ));
        }
        self.repo.update_bill(id, input).await
    }
    pub async fn delete_bill(&self, id: &str) -> Result<()> {
        self.repo.delete_bill(id).await
    }

    pub async fn list_links(&self) -> Result<Vec<EnvelopeCategoryLink>> {
        self.repo.list_links().await
    }
    /// A category that already fed another pot keeps its past spend there:
    /// both pots get an adjustment for the history that changed sides, so no
    /// balance moves and only spend from now on lands in the new pot. A
    /// category linked for the first time brings its history, as before.
    pub async fn replace_links(
        &self,
        envelope_id: &str,
        links: Vec<EnvelopeCategoryLink>,
        currency: &str,
        timezone: &str,
    ) -> Result<()> {
        if links.iter().any(|l| l.envelope_id != envelope_id) {
            return Err(anyhow!("every link must point at envelope {envelope_id}"));
        }
        let before = self.repo.list_links().await?;
        let mut categories = self.taxonomy_categories(SPENDING_TAXONOMY)?;
        categories.extend(self.taxonomy_categories(SAVINGS_TAXONOMY)?);
        let meta: HashMap<String, Category> =
            categories.into_iter().map(|c| (c.id.clone(), c)).collect();
        let moved = moved_links(&before, &links, &meta);
        if moved.is_empty() {
            return self.repo.replace_links(envelope_id, links).await;
        }
        // First the moves alone, measured by what each pot's spend becomes;
        // then the rest of the edit (first links, removals), which adjusts nothing.
        let moves_only = before
            .iter()
            .filter(|b| {
                b.envelope_id == envelope_id
                    && !moved.iter().any(|m| m.category_id == b.category_id)
            })
            .cloned()
            .chain(moved.iter().cloned())
            .collect();
        let spent_before = pot_spend(&self.snapshot(None, currency, timezone).await?);
        self.repo.replace_links(envelope_id, moves_only).await?;
        let spent_after = pot_spend(&self.snapshot(None, currency, timezone).await?);
        let today = activity_date_in_user_timezone(Utc::now(), timezone);
        let adjustments = relink_adjustments(&spent_before, &spent_after, today);
        if !adjustments.is_empty() {
            self.repo.insert_entries(adjustments).await?;
        }
        self.repo.replace_links(envelope_id, links).await
    }

    pub async fn list_entries(
        &self,
        envelope_id: Option<&str>,
        from: Option<NaiveDate>,
    ) -> Result<Vec<EnvelopeEntry>> {
        self.repo.list_entries(envelope_id, from).await
    }
    pub async fn add_entry(&self, input: EntryInput) -> Result<EnvelopeEntry> {
        if input.kind == EnvelopeEntryKind::Move {
            return Err(anyhow!("use move_money for moves"));
        }
        require_amount(input.amount)?;
        let rows = self
            .repo
            .insert_entries(vec![NewEnvelopeEntry {
                envelope_id: input.envelope_id,
                bill_id: input.bill_id,
                entry_date: input.entry_date,
                amount: input.amount,
                kind: input.kind,
                note: input.note,
                ..Default::default()
            }])
            .await?;
        rows.into_iter()
            .next()
            .ok_or_else(|| anyhow!("entry not inserted"))
    }
    pub async fn move_money(&self, input: MoveInput) -> Result<Vec<EnvelopeEntry>> {
        require_amount(input.amount)?;
        if input.amount <= 0.0 {
            return Err(anyhow!("move amount must be positive"));
        }
        if (&input.from_envelope_id, &input.from_bill_id)
            == (&input.to_envelope_id, &input.to_bill_id)
        {
            return Err(anyhow!("source and destination are the same pot"));
        }
        let move_id = Some(Uuid::new_v4().to_string());
        let leg = |envelope_id: String, bill_id: Option<String>, amount: f64| NewEnvelopeEntry {
            envelope_id,
            bill_id,
            entry_date: input.entry_date,
            amount,
            kind: EnvelopeEntryKind::Move,
            note: input.note.clone(),
            move_id: move_id.clone(),
            ..Default::default()
        };
        self.repo
            .insert_entries(vec![
                leg(
                    input.from_envelope_id.clone(),
                    input.from_bill_id.clone(),
                    -input.amount,
                ),
                leg(
                    input.to_envelope_id.clone(),
                    input.to_bill_id.clone(),
                    input.amount,
                ),
            ])
            .await
    }
    pub async fn delete_entry(&self, id: &str) -> Result<()> {
        let entries = self.repo.list_entries(None, None).await?;
        match entries
            .iter()
            .find(|e| e.id == id)
            .and_then(|e| e.move_id.clone())
        {
            Some(move_id) => self.repo.delete_move(&move_id).await,
            None => self.repo.delete_entry(id).await,
        }
    }

    pub async fn list_rules(&self) -> Result<Vec<FundingRule>> {
        self.repo.list_rules().await
    }
    pub async fn create_rule(&self, input: FundingRuleInput) -> Result<FundingRule> {
        validate_rule(&input)?;
        self.repo.create_rule(input).await
    }
    pub async fn update_rule(&self, id: &str, input: FundingRuleInput) -> Result<FundingRule> {
        validate_rule(&input)?;
        self.repo.update_rule(id, input).await
    }
    pub async fn delete_rule(&self, id: &str) -> Result<()> {
        self.repo.delete_rule(id).await
    }

    /// Record the funding entries for one income deposit, with the user's
    /// final amounts. Idempotent per (rule, deposit).
    pub async fn apply_income(&self, input: ApplyIncomeInput) -> Result<Vec<EnvelopeEntry>> {
        let rule = self
            .repo
            .list_rules()
            .await?
            .into_iter()
            .find(|r| r.id == input.rule_id)
            .ok_or_else(|| anyhow!("rule {} not found", input.rule_id))?;
        let existing = self.repo.list_entries(None, None).await?;
        if existing
            .iter()
            .any(|e| e.activity_id.as_deref() == Some(&input.activity_id))
        {
            return Err(anyhow!("deposit {} is already funded", input.activity_id));
        }
        let entries = input
            .splits
            .into_iter()
            .filter(|s| s.amount != 0.0)
            .map(|s| NewEnvelopeEntry {
                envelope_id: s.envelope_id,
                bill_id: s.bill_id,
                entry_date: input.entry_date,
                amount: s.amount,
                kind: EnvelopeEntryKind::Funding,
                note: Some(rule.name.clone()),
                rule_id: Some(rule.id.clone()),
                period_key: Some(input.activity_id.clone()),
                activity_id: Some(input.activity_id.clone()),
                ..Default::default()
            })
            .collect::<Vec<_>>();
        self.repo.insert_entries(entries).await
    }

    /// Register a payment made outside the linked categories: the bill moves
    /// to its next cycle. Nothing is posted to any account.
    pub async fn mark_bill_paid(
        &self,
        bill_id: &str,
        input: MarkPaidInput,
        timezone: &str,
    ) -> Result<EnvelopeBill> {
        let mut bill = self
            .repo
            .list_bills()
            .await?
            .into_iter()
            .find(|b| b.id == bill_id)
            .ok_or_else(|| anyhow!("bill {bill_id} not found"))?;
        let paid = input
            .date
            .unwrap_or_else(|| activity_date_in_user_timezone(Utc::now(), timezone));
        let next = bill
            .next_due
            .ok_or_else(|| anyhow!("bill has no next due date"))?;
        let advanced = advance_due(next, cycle_months(&bill.cycle), paid);
        let advanced = if advanced == next {
            add_months(next, cycle_months(&bill.cycle))
        } else {
            advanced
        };
        self.repo
            .set_bill_next_due(&bill.id, Some(advanced))
            .await?;
        bill.next_due = Some(advanced);
        Ok(bill)
    }

    /// Pin an activity to a pot, or remove the pin so its category decides.
    pub async fn set_activity_envelope(
        &self,
        activity_id: &str,
        input: ActivityEnvelopeInput,
    ) -> Result<()> {
        let existing = self
            .activity_service
            .get_activity(activity_id)
            .map_err(|e| anyhow!(e.to_string()))?;
        if let Some(ActivityEnvelope {
            envelope_id: Some(envelope_id),
            bill_id,
        }) = &input.envelope
        {
            if !self
                .repo
                .list_envelopes()
                .await?
                .iter()
                .any(|e| &e.id == envelope_id)
            {
                return Err(anyhow!("envelope {envelope_id} not found"));
            }
            if let Some(bill_id) = bill_id {
                if !self
                    .repo
                    .list_bills()
                    .await?
                    .iter()
                    .any(|b| &b.id == bill_id && &b.envelope_id == envelope_id)
                {
                    return Err(anyhow!("bill {bill_id} is not in envelope {envelope_id}"));
                }
            }
        }
        // The patch merges into the stored metadata; `null` keeps the key with
        // no value, which the snapshot reads as "follow the category".
        let patch = serde_json::json!({ ACTIVITY_ENVELOPE_KEY: input.envelope }).to_string();
        self.activity_service
            .update_activity(ActivityUpdate {
                unlink_transfer_pair_id: None,
                split_review: None,
                id: existing.id.clone(),
                account_id: existing.account_id.clone(),
                asset: None,
                activity_type: existing.activity_type.clone(),
                subtype: existing.subtype.clone(),
                activity_date: existing.activity_date.to_rfc3339(),
                // Every scalar is restated from the stored row: an omitted
                // field is not "keep", so sending None would blank it.
                quantity: Some(existing.quantity),
                unit_price: Some(existing.unit_price),
                currency: existing.currency.clone(),
                fee: Some(existing.fee),
                tax: Some(existing.tax),
                amount: Some(existing.amount),
                status: Some(existing.status.clone()),
                needs_review: Some(existing.needs_review),
                notes: existing.notes.clone(),
                fx_rate: Some(existing.fx_rate),
                metadata: Some(patch),
            })
            .await
            .map_err(|e| anyhow!(e.to_string()))?;
        Ok(())
    }

    // ----------------------------- snapshot -----------------------------

    pub async fn snapshot(
        &self,
        as_of: Option<NaiveDate>,
        currency: &str,
        timezone: &str,
    ) -> Result<EnvelopeSnapshot> {
        let as_of = as_of.unwrap_or_else(|| activity_date_in_user_timezone(Utc::now(), timezone));
        let envelopes = self.repo.list_envelopes().await?;
        let bills = self.repo.list_bills().await?;
        let links = self.repo.list_links().await?;
        let plan = plan_values(
            self.spending_settings
                .get_document(INCOME_PLAN_KEY)
                .await?
                .as_deref(),
        );
        let rules = resolve_rules(self.repo.list_rules().await?, &bills, &plan);

        // Reading a future date must not write funding for periods that have
        // not come: later rule changes would never reach those rows.
        let today = activity_date_in_user_timezone(Utc::now(), timezone);
        self.materialize_scheduled(&rules, &envelopes, &bills, as_of.min(today))
            .await?;
        let entries = self.repo.list_entries(None, None).await?;

        let month_start = NaiveDate::from_ymd_opt(as_of.year(), as_of.month(), 1)
            .ok_or_else(|| anyhow!("bad as_of"))?;
        // Paydays are the 15th and the last day, so a quincena runs 1-15 or 16-end.
        let period_start = if as_of.day() <= 15 {
            month_start
        } else {
            clamp_day(as_of.year(), as_of.month(), 16)
        };
        let period_target = period_targets(&rules);

        // Savings categories sit beside the spending ones: a move to an
        // investing account picks its pot through a savings category.
        let mut spending_categories = self.taxonomy_categories(SPENDING_TAXONOMY)?;
        spending_categories.extend(self.taxonomy_categories(SAVINGS_TAXONOMY)?);
        let spending_meta: HashMap<String, Category> = spending_categories
            .iter()
            .map(|c| (c.id.clone(), c.clone()))
            .collect();
        let link_by_category: HashMap<&str, &EnvelopeCategoryLink> =
            links.iter().map(|l| (l.category_id.as_str(), l)).collect();
        let start_by_envelope: HashMap<&str, NaiveDate> = envelopes
            .iter()
            .map(|e| (e.id.as_str(), e.start_date))
            .collect();

        let (spent, spent_month, spent_period, income_by_activity, bill_flows, quality) = self
            .collect_flows(
                &envelopes,
                as_of,
                month_start,
                period_start,
                currency,
                timezone,
                &spending_meta,
                &link_by_category,
                &start_by_envelope,
            )
            .await?;

        // A registered payment settles the due date it falls near and moves
        // the bill to its next cycle; persisted so the state survives reloads.
        // What the pot still holds on that day goes to the envelope the
        // paycheck remainder feeds, so every cycle starts from zero.
        let sweep_to = rules
            .iter()
            .filter(|r| r.active)
            .flat_map(|r| &r.splits)
            .find(|s| s.source.as_deref() == Some(SOURCE_REMAINDER) && s.bill_id.is_none())
            .map(|s| s.envelope_id.clone())
            .filter(|id| envelopes.iter().any(|e| &e.id == id && !e.archived));
        let mut bills = bills;
        let mut swept = false;
        for bill in bills.iter_mut() {
            let key = (bill.envelope_id.clone(), Some(bill.id.clone()));
            let (Some(flows), Some(next)) = (bill_flows.get(&key), bill.next_due) else {
                continue;
            };
            let Some(paid) = settling_payment(dec(bill.expected_amount), next, flows) else {
                continue;
            };
            let advanced = advance_due(next, cycle_months(&bill.cycle), paid);
            if advanced == next {
                continue;
            }
            let leftover = entries
                .iter()
                .filter(|e| {
                    e.envelope_id == bill.envelope_id
                        && e.bill_id.as_deref() == Some(&bill.id)
                        && e.entry_date <= paid
                })
                .map(|e| dec(e.amount))
                .sum::<Decimal>()
                - flows
                    .iter()
                    .filter(|(date, _)| *date <= paid)
                    .map(|(_, amount)| *amount)
                    .sum::<Decimal>();
            let sweep = match &sweep_to {
                Some(to) if leftover >= Decimal::new(1, 2) => {
                    sweep_entries(bill, to, paid, round_half_up(leftover))
                }
                _ => Vec::new(),
            };
            let moved = !sweep.is_empty();
            // Only the snapshot that still finds the old due date writes, so
            // two concurrent reads cannot sweep the same leftover twice.
            if self
                .repo
                .settle_bill(&bill.id, next, advanced, sweep)
                .await?
            {
                swept |= moved;
            }
            bill.next_due = Some(advanced);
        }
        let entries = if swept {
            self.repo.list_entries(None, None).await?
        } else {
            entries
        };
        let mut funded: HashMap<PotKey, Decimal> = HashMap::new();
        let mut funded_month: HashMap<String, Decimal> = HashMap::new();
        for e in entries.iter().filter(|e| e.entry_date <= as_of) {
            let amount = dec(e.amount);
            *funded
                .entry((e.envelope_id.clone(), e.bill_id.clone()))
                .or_default() += amount;
            if e.entry_date >= month_start {
                *funded_month.entry(e.envelope_id.clone()).or_default() += amount;
            }
        }

        let mut rows = Vec::with_capacity(envelopes.len());
        let mut total = Decimal::ZERO;
        for envelope in envelopes.iter().filter(|e| !e.archived) {
            let env_bills = bills
                .iter()
                .filter(|b| b.envelope_id == envelope.id && !b.archived)
                .cloned()
                .map(|bill| {
                    let key = (envelope.id.clone(), Some(bill.id.clone()));
                    let f = funded.get(&key).copied().unwrap_or_default();
                    let s = spent.get(&key).copied().unwrap_or_default();
                    let balance = f - s;
                    let ready = bill.expected_amount > 0.0
                        && balance >= dec(bill.expected_amount) - Decimal::new(1, 2);
                    let days_left = bill.next_due.map(|d| (d - as_of).num_days());
                    let state = match days_left {
                        Some(d) if d < 0 && ready => BillState::Overdue,
                        Some(d) if d < 0 => BillState::Underfunded,
                        _ if ready => BillState::Ready,
                        _ => BillState::Funding,
                    };
                    BillBalance {
                        linked_category_ids: links
                            .iter()
                            .filter(|l| l.bill_id.as_deref() == Some(&bill.id))
                            .map(|l| l.category_id.clone())
                            .collect(),
                        last_payment: bill_flows.get(&key).and_then(|flows| {
                            flows
                                .iter()
                                .filter(|(_, amount)| *amount > Decimal::ZERO)
                                .map(|(date, _)| *date)
                                .max()
                        }),
                        state,
                        days_left,
                        bill,
                        funded: f64_of(f),
                        spent: f64_of(s),
                        balance: f64_of(balance),
                    }
                })
                .collect::<Vec<_>>();
            let funded_total = funded
                .iter()
                .filter(|((id, _), _)| id == &envelope.id)
                .map(|(_, v)| *v)
                .sum::<Decimal>();
            let spent_total = spent
                .iter()
                .filter(|((id, _), _)| id == &envelope.id)
                .map(|(_, v)| *v)
                .sum::<Decimal>();
            let balance = funded_total - spent_total;
            total += balance;
            rows.push(EnvelopeBalance {
                envelope: envelope.clone(),
                funded: f64_of(funded_total),
                spent: f64_of(spent_total),
                balance: f64_of(balance),
                funded_this_month: f64_of(
                    funded_month.get(&envelope.id).copied().unwrap_or_default(),
                ),
                spent_this_month: f64_of(
                    spent_month.get(&envelope.id).copied().unwrap_or_default(),
                ),
                spent_this_period: f64_of(
                    spent_period.get(&envelope.id).copied().unwrap_or_default(),
                ),
                period_target: period_target.get(&envelope.id).copied().unwrap_or_default(),
                linked_category_ids: links
                    .iter()
                    .filter(|l| l.envelope_id == envelope.id && l.bill_id.is_none())
                    .map(|l| l.category_id.clone())
                    .collect(),
                bills: env_bills,
            });
        }

        let funded_activities: HashSet<&str> = entries
            .iter()
            .filter_map(|e| e.activity_id.as_deref())
            .collect();
        let income_meta: HashMap<String, Category> = self
            .taxonomy_categories(INCOME_TAXONOMY)?
            .into_iter()
            .map(|c| (c.id.clone(), c))
            .collect();
        let mut pending_income = Vec::new();
        for rule in rules
            .iter()
            .filter(|r| r.active && r.cadence == FundingCadence::OnIncome)
        {
            let Some(rule_category) = rule.income_category_id.as_deref() else {
                continue;
            };
            let since = rule.anchor_date.unwrap_or(NaiveDate::MIN);
            for (activity_id, date, category_id, amount) in &income_by_activity {
                if funded_activities.contains(activity_id.as_str())
                    || *date < since
                    || !is_or_descends_from(category_id, rule_category, &income_meta)
                {
                    continue;
                }
                pending_income.push(PendingIncome {
                    activity_id: activity_id.clone(),
                    date: *date,
                    amount: f64_of(*amount),
                    category_id: category_id.clone(),
                    rule_id: rule.id.clone(),
                    rule_name: rule.name.clone(),
                    proposed: compute_splits(
                        &rule.splits,
                        *amount,
                        rule.shortfall_envelope_id.as_deref(),
                    ),
                });
            }
        }
        pending_income.sort_by_key(|p| std::cmp::Reverse(p.date));

        Ok(EnvelopeSnapshot {
            as_of,
            currency: currency.to_string(),
            envelopes: rows,
            rules,
            pending_income,
            total_balance: f64_of(total),
            quality,
        })
    }

    /// Insert the funding entries that scheduled rules owe up to `as_of`.
    /// Idempotent: (rule, period, pot) is unique in the ledger.
    async fn materialize_scheduled(
        &self,
        rules: &[FundingRule],
        envelopes: &[Envelope],
        bills: &[EnvelopeBill],
        as_of: NaiveDate,
    ) -> Result<()> {
        let existing = self.repo.list_entries(None, None).await?;
        let have: HashSet<(String, String, PotKey)> = existing
            .iter()
            .filter_map(|e| {
                Some((
                    e.rule_id.clone()?,
                    e.period_key.clone()?,
                    (e.envelope_id.clone(), e.bill_id.clone()),
                ))
            })
            .collect();
        let live_envelopes: HashSet<&str> = envelopes
            .iter()
            .filter(|e| !e.archived)
            .map(|e| e.id.as_str())
            .collect();
        let live_bills: HashSet<&str> = bills
            .iter()
            .filter(|b| !b.archived)
            .map(|b| b.id.as_str())
            .collect();
        let mut new_entries = Vec::new();
        for rule in rules.iter().filter(|r| r.active) {
            let Some(anchor) = rule.anchor_date else {
                continue;
            };
            let periods: Vec<(NaiveDate, String)> = match rule.cadence {
                FundingCadence::Biweekly => (0..)
                    .map(|n| anchor + Duration::days(14 * n))
                    .take_while(|d| *d <= as_of)
                    .map(|d| (d, d.to_string()))
                    .collect(),
                FundingCadence::Monthly => {
                    let day = rule
                        .day_of_month
                        .unwrap_or(anchor.day() as i32)
                        .clamp(1, 31) as u32;
                    month_walk(anchor, as_of, |y, m| {
                        vec![(clamp_day(y, m, day), format!("{y:04}-{m:02}"))]
                    })
                }
                FundingCadence::Semimonthly => month_walk(anchor, as_of, |y, m| {
                    vec![
                        (clamp_day(y, m, 15), format!("{y:04}-{m:02}-a")),
                        (clamp_day(y, m, 31), format!("{y:04}-{m:02}-b")),
                    ]
                }),
                FundingCadence::OnIncome => Vec::new(),
            };
            for (date, period_key) in periods {
                for split in &rule.splits {
                    let Some(amount) = split.amount else { continue };
                    if amount == 0.0
                        || !live_envelopes.contains(split.envelope_id.as_str())
                        || split
                            .bill_id
                            .as_deref()
                            .is_some_and(|b| !live_bills.contains(b))
                    {
                        continue;
                    }
                    let key = (
                        rule.id.clone(),
                        period_key.clone(),
                        (split.envelope_id.clone(), split.bill_id.clone()),
                    );
                    if have.contains(&key) {
                        continue;
                    }
                    new_entries.push(NewEnvelopeEntry {
                        envelope_id: split.envelope_id.clone(),
                        bill_id: split.bill_id.clone(),
                        entry_date: date,
                        amount,
                        kind: EnvelopeEntryKind::Funding,
                        note: Some(rule.name.clone()),
                        rule_id: Some(rule.id.clone()),
                        period_key: Some(period_key.clone()),
                        activity_id: None,
                        move_id: None,
                    });
                }
            }
        }
        if !new_entries.is_empty() {
            self.repo.insert_entries(new_entries).await?;
        }
        Ok(())
    }

    /// Spend per pot since each envelope's start date, plus income deposits
    /// (for on-income rules), all in `currency`.
    #[allow(clippy::too_many_arguments, clippy::type_complexity)]
    async fn collect_flows(
        &self,
        envelopes: &[Envelope],
        as_of: NaiveDate,
        month_start: NaiveDate,
        period_start: NaiveDate,
        currency: &str,
        timezone: &str,
        spending_meta: &HashMap<String, Category>,
        link_by_category: &HashMap<&str, &EnvelopeCategoryLink>,
        start_by_envelope: &HashMap<&str, NaiveDate>,
    ) -> Result<Flows> {
        let mut spent: HashMap<PotKey, Decimal> = HashMap::new();
        let mut bill_flows: HashMap<PotKey, Vec<(NaiveDate, Decimal)>> = HashMap::new();
        let mut quality = CalculationQuality::default();
        let mut spent_month: HashMap<String, Decimal> = HashMap::new();
        let mut spent_period: HashMap<String, Decimal> = HashMap::new();
        let mut income = Vec::new();
        let settings = self.spending_settings.get().await?;
        let Some(earliest) = envelopes.iter().map(|e| e.start_date).min() else {
            return Ok((
                spent,
                spent_month,
                spent_period,
                income,
                bill_flows,
                quality,
            ));
        };
        if !settings.enabled || settings.account_ids.is_empty() {
            return Ok((
                spent,
                spent_month,
                spent_period,
                income,
                bill_flows,
                quality,
            ));
        }
        let accounts = self
            .account_repo
            .list(None, Some(false), Some(&settings.account_ids))
            .map_err(|e| anyhow!(e.to_string()))?;
        let accounts = accounts
            .into_iter()
            .filter(|a| account_supports_purpose(&a.account_type, AccountPurpose::Spending))
            .collect::<Vec<_>>();
        // Every spending account tells whether a transfer stayed among them,
        // excluded ones included.
        let context_ids = accounts.iter().map(|a| a.id.clone()).collect::<Vec<_>>();
        // Accounts flagged `envelopesExcluded` in their meta (e.g. a grocery
        // voucher card the budget already nets out) stay in reports but never
        // touch a pot.
        let account_types: HashMap<String, String> = accounts
            .into_iter()
            .filter(|a| !account_flag(a.meta.as_deref(), "envelopesExcluded"))
            .map(|a| (a.id, a.account_type))
            .collect();
        if account_types.is_empty() {
            return Ok((
                spent,
                spent_month,
                spent_period,
                income,
                bill_flows,
                quality,
            ));
        }
        // One day of slack on both ends; the local date decides membership.
        let start_utc = Utc.from_utc_datetime(
            &(earliest - Duration::days(1))
                .and_hms_opt(0, 0, 0)
                .ok_or_else(|| anyhow!("bad start date"))?,
        );
        let end_utc = Utc.from_utc_datetime(
            &(as_of + Duration::days(1))
                .and_hms_opt(23, 59, 59)
                .ok_or_else(|| anyhow!("bad as_of date"))?,
        );
        let activities = self
            .activity_repo
            .get_activities_by_account_ids_in_date_range(&context_ids, start_utc, end_utc)
            .map_err(|e| anyhow!(e.to_string()))?;
        // ponytail: both legs of a transfer are looked for inside the envelope
        // window only; read the whole history if a transfer ever straddles its start.
        let transfer_groups =
            within_spending_transfer_groups(&activities.iter().collect::<Vec<_>>());
        let activity_ids = activities.iter().map(|a| a.id.clone()).collect::<Vec<_>>();
        let assignments = group_assignments(
            self.assignment_repo
                .list_for_activities(&activity_ids)
                .await?,
        );
        let splits = group_splits(self.split_repo.list_for_activities(&activity_ids).await?);
        let fx = self.fx_service.as_ref();

        for activity in &activities {
            let Some(account_type) = account_types.get(&activity.account_id) else {
                continue;
            };
            // Account balances count posted activities only; a draft or void
            // one debiting a pot would open a gap in the reconcile.
            if !activity.is_posted() {
                continue;
            }
            let local_date = activity_date_in_user_timezone(activity.activity_date, timezone);
            if local_date > as_of {
                continue;
            }
            let classification =
                classify_activity_for_aggregation(activity, account_type, &transfer_groups);
            let amount = activity_abs_amount(activity);
            let (spending_native, pot_taxonomy) = pot_flow(classification, amount);
            let income_native = classification.income_amount(amount);
            // A pinned activity goes whole to its pot (or to none); otherwise
            // each category allocation follows its link.
            let pin = activity_pin(activity);
            // A deposit pinned to "no envelope" is money the envelopes already
            // counted (an expected credit), so no rule proposes a split for it.
            let income_native = match pin {
                Some(ActivityEnvelope {
                    envelope_id: None, ..
                }) => Decimal::ZERO,
                _ => income_native,
            };
            let pots: Vec<(PotKey, Decimal)> = match pin {
                Some(ActivityEnvelope {
                    envelope_id: Some(envelope_id),
                    bill_id,
                }) if spending_native != Decimal::ZERO => {
                    vec![((envelope_id, bill_id), spending_native)]
                }
                Some(_) => Vec::new(),
                None => allocations_for_taxonomy(
                    &activity.id,
                    pot_taxonomy,
                    spending_native,
                    &assignments,
                    &splits,
                )
                .into_iter()
                .filter_map(|allocation| {
                    let link =
                        resolve_link(&allocation.category_id, link_by_category, spending_meta)?;
                    Some((
                        (link.envelope_id.clone(), link.bill_id.clone()),
                        allocation.amount,
                    ))
                })
                .collect(),
            };
            for ((envelope_id, bill_id), native) in pots {
                if start_by_envelope
                    .get(envelope_id.as_str())
                    .is_some_and(|start| local_date < *start)
                {
                    continue;
                }
                // The rate of the day the money moved: one read today would
                // shift every past charge with the currency.
                let converted =
                    crate::fx::convert(fx, native, &activity.currency, currency, local_date)
                        .unwrap_or_else(|| {
                            quality.record_missing(&activity.currency);
                            Decimal::ZERO
                        });
                if converted != Decimal::ZERO && bill_id.is_some() {
                    bill_flows
                        .entry((envelope_id.clone(), bill_id.clone()))
                        .or_default()
                        .push((local_date, converted));
                }
                *spent.entry((envelope_id.clone(), bill_id)).or_default() += converted;
                if local_date >= month_start {
                    *spent_month.entry(envelope_id.clone()).or_default() += converted;
                }
                if local_date >= period_start {
                    *spent_period.entry(envelope_id).or_default() += converted;
                }
            }
            if income_native != Decimal::ZERO {
                for allocation in allocations_for_taxonomy(
                    &activity.id,
                    INCOME_TAXONOMY,
                    income_native,
                    &assignments,
                    &splits,
                ) {
                    let converted = crate::fx::convert(
                        fx,
                        allocation.amount,
                        &activity.currency,
                        currency,
                        local_date,
                    )
                    .unwrap_or_else(|| {
                        quality.record_missing(&activity.currency);
                        Decimal::ZERO
                    });
                    income.push((
                        activity.id.clone(),
                        local_date,
                        allocation.category_id,
                        converted,
                    ));
                }
            }
        }
        Ok((
            spent,
            spent_month,
            spent_period,
            income,
            bill_flows,
            quality,
        ))
    }

    fn taxonomy_categories(&self, taxonomy_id: &str) -> Result<Vec<Category>> {
        Ok(self
            .taxonomy_service
            .get_taxonomy(taxonomy_id)?
            .map(|t| t.categories)
            .unwrap_or_default())
    }
}

/// A cycle label the rest of the code can read: anything else would silently
/// count as monthly, and an absurd month count never stops advancing a due date.
fn require_cycle(cycle: &str) -> Result<()> {
    let c = cycle.trim();
    let months = c
        .strip_suffix(" months")
        .and_then(|n| n.trim().parse::<u32>().ok());
    if c == "monthly" || c == "yearly" || months.is_some_and(|n| (1..=120).contains(&n)) {
        Ok(())
    } else {
        Err(anyhow!(
            "cycle must be \"monthly\", \"yearly\" or \"N months\" (1 to 120), got \"{cycle}\""
        ))
    }
}

/// Cycle length in months from the stored label.
pub fn cycle_months(cycle: &str) -> u32 {
    match cycle.trim() {
        "monthly" => 1,
        "yearly" => 12,
        other => other
            .split_whitespace()
            .next()
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(1),
    }
}

/// Same day `months` later, clamped to the end of shorter months.
pub fn add_months(date: NaiveDate, months: u32) -> NaiveDate {
    let total = date.year() * 12 + date.month0() as i32 + months as i32;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    clamp_day(y, m, date.day())
}

/// Move `next_due` forward one cycle at a time while a payment on `paid`
/// settles it (on or up to PAYMENT_WINDOW_DAYS before the due date).
pub fn advance_due(mut next_due: NaiveDate, months: u32, paid: NaiveDate) -> NaiveDate {
    while paid + Duration::days(PAYMENT_WINDOW_DAYS) >= next_due {
        next_due = add_months(next_due, months);
    }
    next_due
}

/// The new links whose category, by itself or through a parent, fed a
/// different pot until now.
fn moved_links(
    before: &[EnvelopeCategoryLink],
    links: &[EnvelopeCategoryLink],
    meta: &HashMap<String, Category>,
) -> Vec<EnvelopeCategoryLink> {
    let by_category: HashMap<&str, &EnvelopeCategoryLink> =
        before.iter().map(|l| (l.category_id.as_str(), l)).collect();
    links
        .iter()
        .filter(|l| {
            resolve_link(&l.category_id, &by_category, meta)
                .is_some_and(|was| (&was.envelope_id, &was.bill_id) != (&l.envelope_id, &l.bill_id))
        })
        .cloned()
        .collect()
}

/// Spend per pot as the snapshot reports it; the envelope's own pot is what
/// its bills do not account for.
fn pot_spend(snapshot: &EnvelopeSnapshot) -> HashMap<PotKey, Decimal> {
    let mut out = HashMap::new();
    for row in &snapshot.envelopes {
        let mut own = dec(row.spent);
        for bill in &row.bills {
            own -= dec(bill.spent);
            out.insert(
                (row.envelope.id.clone(), Some(bill.bill.id.clone())),
                dec(bill.spent),
            );
        }
        out.insert((row.envelope.id.clone(), None), own);
    }
    out
}

/// One adjustment per pot whose spend changed, for that change: the pot that
/// lost history gives the money back, the one that gained it is made whole.
fn relink_adjustments(
    before: &HashMap<PotKey, Decimal>,
    after: &HashMap<PotKey, Decimal>,
    date: NaiveDate,
) -> Vec<NewEnvelopeEntry> {
    let mut pots: Vec<&PotKey> = before.keys().chain(after.keys()).collect();
    pots.sort();
    pots.dedup();
    pots.into_iter()
        .filter_map(|pot| {
            let change = after.get(pot).copied().unwrap_or_default()
                - before.get(pot).copied().unwrap_or_default();
            (change.abs() >= Decimal::new(1, 2)).then(|| NewEnvelopeEntry {
                envelope_id: pot.0.clone(),
                bill_id: pot.1.clone(),
                entry_date: date,
                amount: f64_of(change),
                kind: EnvelopeEntryKind::Adjustment,
                note: Some("Category moved: its past spend stays where it was".into()),
                ..Default::default()
            })
        })
        .collect()
}

/// The date of the payment that settles `next_due`: the latest charge in its
/// window, once the charges there (refunds netted) reach PAYMENT_MIN_SHARE of
/// the expected amount. A bill with no expected amount settles on any charge.
// ponytail: a second charge that lands after the first already settled the
// bill leaves the pot negative until it is funded again; hold the sweep for
// the window's end if bills ever get paid in parts.
fn settling_payment(
    expected: Decimal,
    next_due: NaiveDate,
    flows: &[(NaiveDate, Decimal)],
) -> Option<NaiveDate> {
    let window = next_due - Duration::days(PAYMENT_WINDOW_DAYS);
    let near = || flows.iter().filter(|(date, _)| *date >= window);
    let paid: Decimal = near().map(|(_, amount)| *amount).sum();
    if paid <= Decimal::ZERO || paid < expected * dec(PAYMENT_MIN_SHARE) {
        return None;
    }
    near()
        .filter(|(_, amount)| *amount > Decimal::ZERO)
        .map(|(date, _)| *date)
        .max()
}

/// Both legs of the move that empties a settled bill's pot into `to`.
fn sweep_entries(
    bill: &EnvelopeBill,
    to: &str,
    date: NaiveDate,
    amount: f64,
) -> Vec<NewEnvelopeEntry> {
    let move_id = Some(Uuid::new_v4().to_string());
    let leg = |envelope_id: &str, bill_id: Option<String>, amount: f64| NewEnvelopeEntry {
        envelope_id: envelope_id.to_string(),
        bill_id,
        entry_date: date,
        amount,
        kind: EnvelopeEntryKind::Move,
        note: Some(format!("{}: leftover", bill.name)),
        move_id: move_id.clone(),
        ..Default::default()
    };
    vec![
        leg(&bill.envelope_id, Some(bill.id.clone()), -amount),
        leg(to, None, amount),
    ]
}

/// What an activity takes out of a pot, and the taxonomy whose category picks
/// that pot. Money moved to an investing account leaves a pot like a spend, and
/// money brought back returns to it; both go by their savings category.
fn pot_flow(classification: SpendingClassification, amount: Decimal) -> (Decimal, &'static str) {
    let saving =
        classification.saving_amount(amount) - classification.savings_withdrawal_amount(amount);
    if saving != Decimal::ZERO {
        (saving, SAVINGS_TAXONOMY)
    } else {
        (classification.spending_amount(amount), SPENDING_TAXONOMY)
    }
}

/// The pot an activity was pinned to, if any.
fn activity_pin(activity: &wealthfolio_core::activities::Activity) -> Option<ActivityEnvelope> {
    let value = activity.metadata.as_ref()?.get(ACTIVITY_ENVELOPE_KEY)?;
    if value.is_null() {
        return None;
    }
    serde_json::from_value(value.clone()).ok()
}

/// The link for a category: its own, else the nearest linked ancestor.
fn resolve_link<'a>(
    category_id: &str,
    links: &HashMap<&str, &'a EnvelopeCategoryLink>,
    meta: &HashMap<String, Category>,
) -> Option<&'a EnvelopeCategoryLink> {
    let mut current = Some(category_id.to_string());
    for _ in 0..32 {
        let id = current?;
        if let Some(link) = links.get(id.as_str()) {
            return Some(link);
        }
        current = meta.get(&id).and_then(|c| c.parent_id.clone());
    }
    None
}

fn is_or_descends_from(
    category_id: &str,
    ancestor: &str,
    meta: &HashMap<String, Category>,
) -> bool {
    let mut current = Some(category_id.to_string());
    for _ in 0..32 {
        let Some(id) = current else { return false };
        if id == ancestor {
            return true;
        }
        current = meta.get(&id).and_then(|c| c.parent_id.clone());
    }
    false
}

/// Fixed amounts first; percents apply to what is left after them. Rounded
/// to cents.
/// Fixed lines first; percent lines share what is left. A deposit short of
/// the fixed lines takes the gap out of `shortfall_envelope` when set, else
/// the remainder clamps to zero. One row per pot: a pot named twice (fixed
/// plus a percent of the surplus) comes back summed, since entries are
/// unique per rule, period and pot.
pub fn compute_splits(
    splits: &[FundingSplit],
    amount: Decimal,
    shortfall_envelope: Option<&str>,
) -> Vec<ProposedSplit> {
    let fixed: Decimal = splits.iter().filter_map(|s| s.amount).map(dec).sum();
    let gap = amount - fixed;
    let remainder = gap.max(Decimal::ZERO);
    let mut out: Vec<ProposedSplit> = Vec::new();
    let mut add = |envelope_id: &str, bill_id: Option<&str>, value: Decimal| {
        if let Some(row) = out
            .iter_mut()
            .find(|r| r.envelope_id == envelope_id && r.bill_id.as_deref() == bill_id)
        {
            row.amount = f64_of(dec(row.amount) + value);
        } else {
            out.push(ProposedSplit {
                envelope_id: envelope_id.to_string(),
                bill_id: bill_id.map(Into::into),
                amount: f64_of(value),
            });
        }
    };
    for s in splits {
        let value = match (s.amount, s.percent) {
            (Some(a), _) => dec(a),
            (None, Some(p)) => (remainder * dec(p) / Decimal::from(100)).round_dp(2),
            (None, None) => Decimal::ZERO,
        };
        add(&s.envelope_id, s.bill_id.as_deref(), value);
    }
    if gap < Decimal::ZERO {
        if let Some(envelope_id) = shortfall_envelope {
            add(envelope_id, None, gap);
        }
    }
    out
}

/// Candidate dates per month from the anchor's month up to `as_of`, keeping
/// only those inside [anchor, as_of].
fn month_walk(
    anchor: NaiveDate,
    as_of: NaiveDate,
    dates_in: impl Fn(i32, u32) -> Vec<(NaiveDate, String)>,
) -> Vec<(NaiveDate, String)> {
    let mut out = Vec::new();
    let (mut y, mut m) = (anchor.year(), anchor.month());
    while NaiveDate::from_ymd_opt(y, m, 1).is_some_and(|first| first <= as_of) {
        out.extend(
            dates_in(y, m)
                .into_iter()
                .filter(|(d, _)| *d >= anchor && *d <= as_of),
        );
        if m == 12 {
            y += 1;
            m = 1;
        } else {
            m += 1;
        }
    }
    out
}

fn clamp_day(year: i32, month: u32, day: u32) -> NaiveDate {
    // Walk down from `day` until the date exists; day 1 always does.
    (1..=day.clamp(1, 31))
        .rev()
        .find_map(|d| NaiveDate::from_ymd_opt(year, month, d))
        .unwrap_or_default()
}

fn validate_rule(input: &FundingRuleInput) -> Result<()> {
    require_name(&input.name)?;
    for split in input.splits.iter().filter(|s| s.source.is_some()) {
        if split.percent.is_some() {
            return Err(anyhow!("a line takes a percent or a source, not both"));
        }
        if split.source.as_deref() == Some(SOURCE_BILL) && split.bill_id.is_none() {
            return Err(anyhow!("a line sourced from a bill needs the bill"));
        }
    }
    match input.cadence {
        FundingCadence::OnIncome => {
            if input.income_category_id.as_deref().unwrap_or("").is_empty() {
                return Err(anyhow!("an on-income rule needs an income category"));
            }
            let pct: f64 = input.splits.iter().filter_map(|s| s.percent).sum();
            if pct > 100.0 + 1e-9 {
                return Err(anyhow!("percent splits add up to more than 100"));
            }
        }
        // Funding by calendar re-funds past periods when a rule changes, and
        // nothing uses it: every split follows a deposit.
        _ => {
            return Err(anyhow!(
                "only rules that split an income deposit are supported"
            ))
        }
    }
    Ok(())
}

fn require_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        Err(anyhow!("name is required"))
    } else {
        Ok(())
    }
}

fn require_amount(amount: f64) -> Result<()> {
    if !amount.is_finite() || amount == 0.0 {
        Err(anyhow!("amount must be a non-zero number"))
    } else {
        Ok(())
    }
}

fn dec(v: f64) -> Decimal {
    Decimal::from_f64(v).unwrap_or_default()
}

fn f64_of(v: Decimal) -> f64 {
    v.round_dp(2).to_f64().unwrap_or(0.0)
}

/// Cents with halves away from zero, like the spreadsheet's ROUND (a bill's
/// cost over its cycle can land on half a cent).
fn round_half_up(v: Decimal) -> f64 {
    v.round_dp_with_strategy(2, rust_decimal::RoundingStrategy::MidpointAwayFromZero)
        .to_f64()
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn period_targets_sum_envelope_lines_per_quincena() {
        let split = |env: &str, bill: Option<&str>, amount: f64| FundingSplit {
            envelope_id: env.into(),
            bill_id: bill.map(Into::into),
            amount: Some(amount),
            percent: None,
            ..Default::default()
        };
        let rule = |cadence, splits, active| FundingRule {
            id: "r".into(),
            name: "r".into(),
            cadence,
            anchor_date: None,
            day_of_month: None,
            income_category_id: None,
            splits,
            active,
            shortfall_envelope_id: None,
        };
        let rules = vec![
            rule(
                FundingCadence::Semimonthly,
                vec![
                    split("disc", None, 8800.0),
                    split("bills", Some("b1"), 350.0),
                ],
                true,
            ),
            rule(
                FundingCadence::Monthly,
                vec![split("disc", None, 1000.0)],
                true,
            ),
            rule(
                FundingCadence::OnIncome,
                vec![split("disc", None, 700.0)],
                true,
            ),
            rule(
                FundingCadence::Semimonthly,
                vec![split("disc", None, 999.0)],
                false,
            ),
        ];
        let targets = period_targets(&rules);
        assert_eq!(targets.get("disc"), Some(&10000.0));
        assert_eq!(targets.get("bills"), None);
    }

    #[test]
    fn splits_take_fixed_first_then_percent_of_remainder() {
        let splits = vec![
            FundingSplit {
                envelope_id: "tax".into(),
                bill_id: None,
                amount: None,
                percent: Some(2.5),
                ..Default::default()
            },
            FundingSplit {
                envelope_id: "inv".into(),
                bill_id: None,
                amount: None,
                percent: Some(48.75),
                ..Default::default()
            },
            FundingSplit {
                envelope_id: "disc".into(),
                bill_id: None,
                amount: None,
                percent: Some(48.75),
                ..Default::default()
            },
            FundingSplit {
                envelope_id: "fee".into(),
                bill_id: None,
                amount: Some(100.0),
                percent: None,
                ..Default::default()
            },
        ];
        let out = compute_splits(&splits, Decimal::from(10_100), None);
        assert_eq!(out[0].amount, 250.0);
        assert_eq!(out[1].amount, 4875.0);
        assert_eq!(out[2].amount, 4875.0);
        assert_eq!(out[3].amount, 100.0);
    }

    #[test]
    fn shortfall_comes_out_of_one_envelope_and_surplus_merges_by_pot() {
        let fixed = |env: &str, amount: f64| FundingSplit {
            envelope_id: env.into(),
            bill_id: None,
            amount: Some(amount),
            percent: None,
            ..Default::default()
        };
        let share = |env: &str, percent: f64| FundingSplit {
            envelope_id: env.into(),
            bill_id: None,
            amount: None,
            percent: Some(percent),
            ..Default::default()
        };
        let splits = vec![
            fixed("inv", 7000.0),
            fixed("disc", 8000.0),
            share("inv", 50.0),
            share("disc", 50.0),
        ];
        // Surplus of 1,000 splits 50/50 on top of the fixed lines, one row per pot.
        let up = compute_splits(&splits, Decimal::from(16_000), Some("disc"));
        assert_eq!(up.len(), 2);
        assert_eq!(up[0].amount, 7500.0);
        assert_eq!(up[1].amount, 8500.0);
        // Short by 2,000: discretionary alone absorbs it.
        let down = compute_splits(&splits, Decimal::from(13_000), Some("disc"));
        assert_eq!(down[0].amount, 7000.0);
        assert_eq!(down[1].amount, 6000.0);
        // Without a shortfall envelope the old clamp stays.
        let clamp = compute_splits(&splits, Decimal::from(13_000), None);
        assert_eq!(clamp[1].amount, 8000.0);
    }

    #[test]
    fn semimonthly_walk_hits_15th_and_month_end() {
        let anchor = NaiveDate::from_ymd_opt(2026, 11, 15).unwrap();
        let as_of = NaiveDate::from_ymd_opt(2027, 1, 20).unwrap();
        let dates = month_walk(anchor, as_of, |y, m| {
            vec![
                (clamp_day(y, m, 15), "a".into()),
                (clamp_day(y, m, 31), "b".into()),
            ]
        })
        .into_iter()
        .map(|(d, _)| d.to_string())
        .collect::<Vec<_>>();
        assert_eq!(
            dates,
            [
                "2026-11-15",
                "2026-11-30",
                "2026-12-15",
                "2026-12-31",
                "2027-01-15"
            ]
        );
    }

    #[test]
    fn payments_advance_the_due_date_one_cycle_at_a_time() {
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        assert_eq!(
            advance_due(d("2026-11-09"), 1, d("2026-11-05")),
            d("2026-12-09")
        );
        assert_eq!(
            advance_due(d("2026-11-09"), 1, d("2026-10-20")),
            d("2026-11-09")
        );
        assert_eq!(
            advance_due(d("2026-11-09"), 1, d("2027-01-15")),
            d("2027-02-09")
        );
        assert_eq!(
            advance_due(d("2026-08-17"), 12, d("2026-08-17")),
            d("2027-08-17")
        );
        assert_eq!(add_months(d("2026-01-31"), 1), d("2026-02-28"));
        assert_eq!(cycle_months("monthly"), 1);
        assert_eq!(cycle_months("yearly"), 12);
        assert_eq!(cycle_months("6 months"), 6);
        assert_eq!(cycle_months("weird"), 1);
        // Labels that would read as monthly, or never stop advancing, are refused on save.
        assert!(require_cycle("3 months").is_ok());
        assert!(require_cycle("annual").is_err());
        assert!(require_cycle("0 months").is_err());
        assert!(require_cycle("4294967295 months").is_err());
    }

    #[test]
    fn monthly_day_clamps_to_short_months() {
        assert_eq!(
            clamp_day(2026, 2, 31),
            NaiveDate::from_ymd_opt(2026, 2, 28).unwrap()
        );
        assert_eq!(
            clamp_day(2026, 12, 22),
            NaiveDate::from_ymd_opt(2026, 12, 22).unwrap()
        );
    }

    #[test]
    fn moves_to_investing_leave_a_pot_and_come_back() {
        let amount = Decimal::from(100);
        assert_eq!(
            pot_flow(SpendingClassification::Saving, amount),
            (amount, SAVINGS_TAXONOMY)
        );
        assert_eq!(
            pot_flow(SpendingClassification::FromSavings, amount),
            (-amount, SAVINGS_TAXONOMY)
        );
        assert_eq!(
            pot_flow(SpendingClassification::Expense, amount),
            (amount, SPENDING_TAXONOMY)
        );
        assert_eq!(
            pot_flow(SpendingClassification::InternalTransfer, amount),
            (Decimal::ZERO, SPENDING_TAXONOMY)
        );
    }

    #[test]
    fn link_resolves_through_parents() {
        let meta: HashMap<String, Category> = HashMap::new();
        let link = EnvelopeCategoryLink {
            category_id: "a".into(),
            envelope_id: "e".into(),
            bill_id: None,
        };
        let links: HashMap<&str, &EnvelopeCategoryLink> = [("a", &link)].into_iter().collect();
        assert!(resolve_link("a", &links, &meta).is_some());
        assert!(resolve_link("zz", &links, &meta).is_none());
    }

    #[test]
    fn sourced_lines_follow_bills_and_plan() {
        let bill = |id: &str, cost: f64, cycle: &str, archived| EnvelopeBill {
            id: id.into(),
            envelope_id: "bills".into(),
            name: id.into(),
            expected_amount: cost,
            due_day: None,
            cycle: cycle.into(),
            sort_order: 0,
            archived,
            next_due: None,
        };
        let line = |env: &str, bill: Option<&str>, amount: Option<f64>, source: Option<&str>| {
            FundingSplit {
                envelope_id: env.into(),
                bill_id: bill.map(Into::into),
                amount,
                source: source.map(Into::into),
                ..Default::default()
            }
        };
        let rule = |cadence, splits| FundingRule {
            id: "r".into(),
            name: "r".into(),
            cadence,
            anchor_date: None,
            day_of_month: None,
            income_category_id: None,
            splits,
            active: true,
            shortfall_envelope_id: None,
        };
        let bills = vec![
            bill("rent", 6700.0, "monthly", false),
            bill("insurance", 13162.56, "yearly", false),
            bill("odd", 150.01, "monthly", false),
            bill("gone", 500.0, "monthly", true),
        ];
        let paycheck = vec![
            line("inv", None, Some(1.0), Some(SOURCE_REMAINDER)),
            line("disc", None, Some(5500.0), None),
            line("disc", None, Some(0.0), Some("-base.grocery_vouchers")),
            line("fam", None, Some(1300.0), None),
            line("bills", Some("rent"), Some(1.0), Some(SOURCE_BILL)),
            line("bills", Some("insurance"), Some(1.0), Some(SOURCE_BILL)),
            line("bills", Some("odd"), Some(1.0), Some(SOURCE_BILL)),
            line("bills", Some("gone"), Some(250.0), Some(SOURCE_BILL)),
            line("bills", Some("deleted"), Some(99.0), Some(SOURCE_BILL)),
            FundingSplit {
                envelope_id: "inv".into(),
                percent: Some(50.0),
                ..Default::default()
            },
        ];
        let plan = plan_values(Some(
            r#"{"lines":[],"resolved":{"base.grocery_vouchers":1783.11,"paycheck.expected":24820.63}}"#,
        ));
        let out = resolve_rules(
            vec![
                rule(FundingCadence::OnIncome, paycheck.clone()),
                rule(
                    FundingCadence::Monthly,
                    vec![line("bills", Some("rent"), None, Some(SOURCE_BILL))],
                ),
            ],
            &bills,
            &plan,
        );
        let amounts: Vec<Option<f64>> = out[0].splits.iter().map(|s| s.amount).collect();
        // remainder = 24,820.63 - (5,500 - 1,783.11 + 1,300 + 3,350 + 548.44 + 75.01)
        assert_eq!(
            amounts,
            vec![
                Some(15830.29),
                Some(5500.0),
                Some(-1783.11),
                Some(1300.0),
                Some(3350.0),
                Some(548.44),
                Some(75.01),
                Some(0.0),
                Some(0.0),
                None,
            ]
        );
        let fixed: f64 = amounts.iter().flatten().sum();
        assert!((fixed - 24820.63).abs() < 0.005);
        // A monthly rule funds once a month, so it takes the whole monthly share.
        assert_eq!(out[1].splits[0].amount, Some(6700.0));

        // Without plan values a plan line and the remainder keep what is stored.
        let stale = resolve_rules(
            vec![rule(FundingCadence::OnIncome, paycheck)],
            &bills,
            &plan_values(None),
        );
        assert_eq!(stale[0].splits[0].amount, Some(1.0));
        assert_eq!(stale[0].splits[2].amount, Some(0.0));
        assert_eq!(stale[0].splits[4].amount, Some(3350.0));
    }

    #[test]
    fn sourced_lines_are_validated() {
        let input = |cadence, split: FundingSplit| FundingRuleInput {
            name: "r".into(),
            cadence,
            anchor_date: NaiveDate::from_ymd_opt(2026, 11, 15),
            day_of_month: None,
            income_category_id: Some("cat".into()),
            splits: vec![split],
            active: None,
            shortfall_envelope_id: None,
        };
        let sourced = |bill: Option<&str>, percent, source: &str| FundingSplit {
            envelope_id: "e".into(),
            bill_id: bill.map(Into::into),
            percent,
            source: Some(source.into()),
            ..Default::default()
        };
        assert!(validate_rule(&input(
            FundingCadence::OnIncome,
            sourced(Some("b"), None, SOURCE_BILL)
        ))
        .is_ok());
        assert!(validate_rule(&input(
            FundingCadence::Semimonthly,
            sourced(Some("b"), None, SOURCE_BILL)
        ))
        .is_err());
        assert!(validate_rule(&input(
            FundingCadence::OnIncome,
            sourced(None, None, SOURCE_BILL)
        ))
        .is_err());
        assert!(validate_rule(&input(
            FundingCadence::OnIncome,
            sourced(None, Some(50.0), SOURCE_REMAINDER)
        ))
        .is_err());
    }

    #[test]
    fn a_bill_settles_on_a_real_payment_and_hands_over_its_leftover() {
        let day = |d| NaiveDate::from_ymd_opt(2026, 11, d).unwrap();
        let due = day(20);
        // A fee on the bill's category is not its payment; half the amount is.
        assert_eq!(
            settling_payment(dec(1000.0), due, &[(day(12), dec(30.0))]),
            None
        );
        assert_eq!(
            settling_payment(
                dec(1000.0),
                due,
                &[(day(12), dec(30.0)), (day(18), dec(900.0))]
            ),
            Some(day(18))
        );
        // A charge before the window belongs to the previous due date, and a
        // refund takes back what it undid.
        assert_eq!(
            settling_payment(dec(1000.0), due, &[(day(9), dec(1000.0))]),
            None
        );
        assert_eq!(
            settling_payment(
                dec(1000.0),
                due,
                &[(day(15), dec(900.0)), (day(16), dec(-900.0))]
            ),
            None
        );
        assert_eq!(
            settling_payment(dec(0.0), due, &[(day(15), dec(5.0))]),
            Some(day(15))
        );

        let bill = EnvelopeBill {
            id: "b".into(),
            envelope_id: "bills".into(),
            name: "Internet".into(),
            expected_amount: 1000.0,
            due_day: None,
            cycle: "monthly".into(),
            sort_order: 0,
            archived: false,
            next_due: Some(due),
        };
        let legs = sweep_entries(&bill, "investment", day(18), 100.0);
        let pot = |e: &NewEnvelopeEntry| (e.envelope_id.clone(), e.bill_id.clone(), e.amount);
        assert_eq!(pot(&legs[0]), ("bills".into(), Some("b".into()), -100.0));
        assert_eq!(pot(&legs[1]), ("investment".into(), None, 100.0));
        assert!(legs[0].move_id.is_some() && legs[0].move_id == legs[1].move_id);
        assert!(legs.iter().all(|e| e.entry_date == day(18)));
    }

    #[test]
    fn a_moved_category_leaves_both_balances_where_they_were() {
        let link = |category: &str, envelope: &str| EnvelopeCategoryLink {
            category_id: category.into(),
            envelope_id: envelope.into(),
            bill_id: None,
        };
        let category = |id: &str, parent: Option<&str>| {
            let c = Category {
                id: id.into(),
                taxonomy_id: SPENDING_TAXONOMY.into(),
                parent_id: parent.map(Into::into),
                name: id.into(),
                key: id.into(),
                color: String::new(),
                description: None,
                sort_order: 0,
                created_at: Default::default(),
                updated_at: Default::default(),
                icon: None,
            };
            (c.id.clone(), c)
        };
        let meta: HashMap<String, Category> = [
            category("food", None),
            category("coffee", Some("food")),
            category("gym", None),
        ]
        .into_iter()
        .collect();
        let before = vec![link("food", "home")];
        // Coffee followed its parent into Home; Gym fed nothing; Food stays put.
        let moved = moved_links(&before, &[link("coffee", "fun"), link("gym", "fun")], &meta);
        assert_eq!(moved, vec![link("coffee", "fun")]);
        assert!(moved_links(&before, &[link("food", "home")], &meta).is_empty());

        let pots = |home: f64, fun: f64| -> HashMap<PotKey, Decimal> {
            [
                (("home".to_string(), None), dec(home)),
                (("fun".to_string(), None), dec(fun)),
            ]
            .into_iter()
            .collect()
        };
        let day = NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
        let entries = relink_adjustments(&pots(500.0, 40.0), &pots(380.0, 160.0), day);
        let amounts: Vec<(&str, f64)> = entries
            .iter()
            .map(|e| (e.envelope_id.as_str(), e.amount))
            .collect();
        // Funded moves by what spend moved, so funded - spent holds in both.
        assert_eq!(amounts, vec![("fun", 120.0), ("home", -120.0)]);
        assert!(relink_adjustments(&pots(1.0, 2.0), &pots(1.0, 2.0), day).is_empty());
    }
}
