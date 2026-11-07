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
use crate::activity_classification::{activity_abs_amount, classify_activity};
use crate::activity_splits::ActivitySplitRepositoryTrait;
use crate::settings::SpendingSettingsService;

const SPENDING_TAXONOMY: &str = "spending_categories";
const INCOME_TAXONOMY: &str = "income_sources";

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
    pub async fn update_envelope(&self, id: &str, input: EnvelopeInput) -> Result<Envelope> {
        require_name(&input.name)?;
        self.repo.update_envelope(id, input).await
    }
    pub async fn delete_envelope(&self, id: &str) -> Result<()> {
        self.repo.delete_envelope(id).await
    }

    pub async fn list_bills(&self) -> Result<Vec<EnvelopeBill>> {
        self.repo.list_bills().await
    }
    pub async fn create_bill(&self, input: EnvelopeBillInput) -> Result<EnvelopeBill> {
        require_name(&input.name)?;
        self.repo.create_bill(input).await
    }
    pub async fn update_bill(&self, id: &str, input: EnvelopeBillInput) -> Result<EnvelopeBill> {
        require_name(&input.name)?;
        self.repo.update_bill(id, input).await
    }
    pub async fn delete_bill(&self, id: &str) -> Result<()> {
        self.repo.delete_bill(id).await
    }

    pub async fn list_links(&self) -> Result<Vec<EnvelopeCategoryLink>> {
        self.repo.list_links().await
    }
    pub async fn replace_links(
        &self,
        envelope_id: &str,
        links: Vec<EnvelopeCategoryLink>,
    ) -> Result<()> {
        if links.iter().any(|l| l.envelope_id != envelope_id) {
            return Err(anyhow!("every link must point at envelope {envelope_id}"));
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
        let rules = self.repo.list_rules().await?;

        self.materialize_scheduled(&rules, &envelopes, &bills, as_of)
            .await?;
        let entries = self.repo.list_entries(None, None).await?;

        let month_start = NaiveDate::from_ymd_opt(as_of.year(), as_of.month(), 1)
            .ok_or_else(|| anyhow!("bad as_of"))?;
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

        let spending_categories = self.taxonomy_categories(SPENDING_TAXONOMY)?;
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

        let (spent, spent_month, income_by_activity) = self
            .collect_flows(
                &envelopes,
                as_of,
                month_start,
                currency,
                timezone,
                &spending_meta,
                &link_by_category,
                &start_by_envelope,
            )
            .await?;

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
                    BillBalance {
                        linked_category_ids: links
                            .iter()
                            .filter(|l| l.bill_id.as_deref() == Some(&bill.id))
                            .map(|l| l.category_id.clone())
                            .collect(),
                        bill,
                        funded: f64_of(f),
                        spent: f64_of(s),
                        balance: f64_of(f - s),
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
                    proposed: compute_splits(&rule.splits, *amount),
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
        currency: &str,
        timezone: &str,
        spending_meta: &HashMap<String, Category>,
        link_by_category: &HashMap<&str, &EnvelopeCategoryLink>,
        start_by_envelope: &HashMap<&str, NaiveDate>,
    ) -> Result<(
        HashMap<PotKey, Decimal>,
        HashMap<String, Decimal>,
        Vec<(String, NaiveDate, String, Decimal)>,
    )> {
        let mut spent: HashMap<PotKey, Decimal> = HashMap::new();
        let mut spent_month: HashMap<String, Decimal> = HashMap::new();
        let mut income = Vec::new();
        let settings = self.spending_settings.get().await?;
        let Some(earliest) = envelopes.iter().map(|e| e.start_date).min() else {
            return Ok((spent, spent_month, income));
        };
        if !settings.enabled || settings.account_ids.is_empty() {
            return Ok((spent, spent_month, income));
        }
        let accounts = self
            .account_repo
            .list(None, Some(false), Some(&settings.account_ids))
            .map_err(|e| anyhow!(e.to_string()))?;
        let account_types: HashMap<String, String> = accounts
            .into_iter()
            .filter(|a| account_supports_purpose(&a.account_type, AccountPurpose::Spending))
            .map(|a| (a.id, a.account_type))
            .collect();
        if account_types.is_empty() {
            return Ok((spent, spent_month, income));
        }
        let account_ids = account_types.keys().cloned().collect::<Vec<_>>();
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
            .get_activities_by_account_ids_in_date_range(&account_ids, start_utc, end_utc)
            .map_err(|e| anyhow!(e.to_string()))?;
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
            let local_date = activity_date_in_user_timezone(activity.activity_date, timezone);
            if local_date > as_of {
                continue;
            }
            let classification = classify_activity(activity, account_type);
            let amount = activity_abs_amount(activity);
            let spending_native = classification.spending_amount(amount);
            let income_native = classification.income_amount(amount);
            // A pinned activity goes whole to its pot (or to none); otherwise
            // each category allocation follows its link.
            let pots: Vec<(PotKey, Decimal)> = match activity_pin(activity) {
                Some(ActivityEnvelope {
                    envelope_id: Some(envelope_id),
                    bill_id,
                }) if spending_native != Decimal::ZERO => {
                    vec![((envelope_id, bill_id), spending_native)]
                }
                Some(_) => Vec::new(),
                None => allocations_for_taxonomy(
                    &activity.id,
                    SPENDING_TAXONOMY,
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
                let converted = crate::fx::convert(fx, native, &activity.currency, currency, as_of)
                    .unwrap_or(Decimal::ZERO);
                *spent.entry((envelope_id.clone(), bill_id)).or_default() += converted;
                if local_date >= month_start {
                    *spent_month.entry(envelope_id).or_default() += converted;
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
                        as_of,
                    )
                    .unwrap_or(Decimal::ZERO);
                    income.push((
                        activity.id.clone(),
                        local_date,
                        allocation.category_id,
                        converted,
                    ));
                }
            }
        }
        Ok((spent, spent_month, income))
    }

    fn taxonomy_categories(&self, taxonomy_id: &str) -> Result<Vec<Category>> {
        Ok(self
            .taxonomy_service
            .get_taxonomy(taxonomy_id)?
            .map(|t| t.categories)
            .unwrap_or_default())
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
pub fn compute_splits(splits: &[FundingSplit], amount: Decimal) -> Vec<ProposedSplit> {
    let fixed: Decimal = splits.iter().filter_map(|s| s.amount).map(dec).sum();
    let remainder = (amount - fixed).max(Decimal::ZERO);
    splits
        .iter()
        .map(|s| {
            let value = match (s.amount, s.percent) {
                (Some(a), _) => dec(a),
                (None, Some(p)) => (remainder * dec(p) / Decimal::from(100)).round_dp(2),
                (None, None) => Decimal::ZERO,
            };
            ProposedSplit {
                envelope_id: s.envelope_id.clone(),
                bill_id: s.bill_id.clone(),
                amount: f64_of(value),
            }
        })
        .collect()
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
        _ => {
            if input.anchor_date.is_none() {
                return Err(anyhow!("a scheduled rule needs an anchor date"));
            }
            if input.splits.iter().any(|s| s.amount.is_none()) {
                return Err(anyhow!("scheduled rules need fixed amounts on every line"));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_take_fixed_first_then_percent_of_remainder() {
        let splits = vec![
            FundingSplit {
                envelope_id: "tax".into(),
                bill_id: None,
                amount: None,
                percent: Some(2.5),
            },
            FundingSplit {
                envelope_id: "inv".into(),
                bill_id: None,
                amount: None,
                percent: Some(48.75),
            },
            FundingSplit {
                envelope_id: "disc".into(),
                bill_id: None,
                amount: None,
                percent: Some(48.75),
            },
            FundingSplit {
                envelope_id: "fee".into(),
                bill_id: None,
                amount: Some(100.0),
                percent: None,
            },
        ];
        let out = compute_splits(&splits, Decimal::from(10_100));
        assert_eq!(out[0].amount, 250.0);
        assert_eq!(out[1].amount, 4875.0);
        assert_eq!(out[2].amount, 4875.0);
        assert_eq!(out[3].amount, 100.0);
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
}
