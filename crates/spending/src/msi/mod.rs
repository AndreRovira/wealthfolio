//! MSI (meses sin intereses): an interest-free instalment plan on a credit card.
//!
//! A card charge converted to MSI becomes a zero-rate loan liability, and the
//! card gets a matching credit so its balance matches the bank, which only
//! bills one instalment a month. On each due date the instalment is posted as
//! a card withdrawal tagged as the loan's payment, so the card statement and
//! the loan both move like the real ones. The original charge keeps its
//! category: the purchase is spend at origin.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use wealthfolio_core::accounts::{account_types, AccountRepositoryTrait};
use wealthfolio_core::activities::{Activity, ActivityServiceTrait, NewActivity};
use wealthfolio_core::assets::loan::{
    InstalmentStatus, InterestMethod, LoanFrequency, LoanSchedule, LoanSetup, PaymentLink,
    PaymentTarget,
};
use wealthfolio_core::assets::{
    AlternativeAssetServiceTrait, AssetKind, CreateAlternativeAssetRequest,
};
use wealthfolio_core::taxonomies::TaxonomyServiceTrait;
use wealthfolio_core::utils::time_utils::activity_date_in_user_timezone;

use crate::activity_assignments::ActivityTaxonomyAssignmentService;

const SPENDING_TAXONOMY: &str = "spending_categories";
/// Category that keeps MSI bookkeeping out of spending reports; created when missing.
const MSI_CATEGORY_NAME: &str = "MSI payments";
pub const MSI_KEY: &str = "msi";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertInput {
    pub activity_id: String,
    pub months: u32,
    pub first_due: NaiveDate,
    /// Loan name; defaults to the charge's note.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub loan_id: String,
    pub financing_activity_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub activity_id: String,
    pub account_id: String,
    pub account_name: String,
    pub date: NaiveDate,
    pub amount: f64,
    pub currency: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostedInstalment {
    pub loan_id: String,
    pub loan_name: String,
    pub due_date: NaiveDate,
    pub amount: f64,
    pub activity_id: String,
}

pub struct MsiService {
    activity_service: Arc<dyn ActivityServiceTrait + Send + Sync>,
    account_repo: Arc<dyn AccountRepositoryTrait>,
    alternative_assets: Arc<dyn AlternativeAssetServiceTrait + Send + Sync>,
    assignments: Arc<ActivityTaxonomyAssignmentService>,
    taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
}

impl MsiService {
    pub fn new(
        activity_service: Arc<dyn ActivityServiceTrait + Send + Sync>,
        account_repo: Arc<dyn AccountRepositoryTrait>,
        alternative_assets: Arc<dyn AlternativeAssetServiceTrait + Send + Sync>,
        assignments: Arc<ActivityTaxonomyAssignmentService>,
        taxonomy_service: Arc<dyn TaxonomyServiceTrait>,
    ) -> Self {
        Self {
            activity_service,
            account_repo,
            alternative_assets,
            assignments,
            taxonomy_service,
        }
    }

    /// Card withdrawals of the last `days` not converted yet, newest first.
    pub fn candidates(&self, days: i64, timezone: &str) -> Result<Vec<Candidate>> {
        let since = Utc::now() - chrono::Duration::days(days);
        let cards = self
            .account_repo
            .list(None, Some(false), None)
            .map_err(|e| anyhow!(e.to_string()))?
            .into_iter()
            .filter(|a| a.account_type == account_types::CREDIT_CARD)
            .collect::<Vec<_>>();
        let mut out = Vec::new();
        for card in &cards {
            let activities = self
                .activity_service
                .get_activities_by_account_id(&card.id)
                .map_err(|e| anyhow!(e.to_string()))?;
            let converted: Vec<String> = activities
                .iter()
                .filter_map(|a| {
                    msi_meta(a)?
                        .get("chargeActivityId")?
                        .as_str()
                        .map(String::from)
                })
                .collect();
            for a in activities {
                if a.activity_date < since
                    || a.effective_type() != "WITHDRAWAL"
                    || !a.is_posted()
                    || converted.contains(&a.id)
                    || msi_meta(&a).is_some()
                {
                    continue;
                }
                let Some(amount) = a.amount.map(|d| d.abs()).and_then(|d| d.to_f64()) else {
                    continue;
                };
                out.push(Candidate {
                    activity_id: a.id.clone(),
                    account_id: card.id.clone(),
                    account_name: card.name.clone(),
                    date: activity_date_in_user_timezone(a.activity_date, timezone),
                    amount,
                    currency: a.currency.clone(),
                    notes: a.notes.clone(),
                });
            }
        }
        out.sort_by_key(|c| std::cmp::Reverse(c.date));
        Ok(out)
    }

    /// Turn a posted card charge into a zero-rate loan plus a card credit.
    pub async fn convert(&self, input: ConvertInput, timezone: &str) -> Result<ConvertResult> {
        if input.months == 0 {
            return Err(anyhow!("months must be at least 1"));
        }
        let charge = self
            .activity_service
            .get_activity(&input.activity_id)
            .map_err(|e| anyhow!(e.to_string()))?;
        let card = self
            .account_repo
            .get_by_id(&charge.account_id)
            .map_err(|e| anyhow!(e.to_string()))?;
        if card.account_type != account_types::CREDIT_CARD {
            return Err(anyhow!("only credit card charges can be converted to MSI"));
        }
        if charge.effective_type() != "WITHDRAWAL" || !charge.is_posted() {
            return Err(anyhow!("only a posted card charge can be converted to MSI"));
        }
        if msi_meta(&charge).is_some() {
            return Err(anyhow!("this activity is already MSI bookkeeping"));
        }
        let amount = charge
            .amount
            .map(|d| d.abs())
            .filter(|d| *d > Decimal::ZERO)
            .ok_or_else(|| anyhow!("charge has no amount"))?;
        let charge_date = activity_date_in_user_timezone(charge.activity_date, timezone);
        if input.first_due <= charge_date {
            return Err(anyhow!("first due date must be after the charge"));
        }
        let name = input
            .name
            .filter(|n| !n.trim().is_empty())
            .or_else(|| charge.notes.clone().filter(|n| !n.trim().is_empty()))
            .unwrap_or_else(|| format!("MSI {}", charge_date));

        let created = self
            .alternative_assets
            .create_alternative_asset(CreateAlternativeAssetRequest {
                kind: AssetKind::Liability,
                name: format!("MSI {name} ({})", card.name),
                currency: charge.currency.clone(),
                current_value: amount,
                value_date: charge_date,
                purchase_price: None,
                purchase_date: None,
                metadata: Some(json!({
                    "sub_type": "credit_card",
                    MSI_KEY: {
                        "cardAccountId": card.id,
                        "chargeActivityId": charge.id,
                        "months": input.months,
                    }
                })),
                linked_asset_id: None,
                loan: Some(LoanSetup {
                    original_amount: amount.to_f64(),
                    origination_date: Some(charge_date),
                    interest_rate: Some(0.0),
                    schedule: Some(LoanSchedule {
                        frequency: LoanFrequency::Monthly,
                        interest_method: InterestMethod::default(),
                        first_payment_date: Some(input.first_due),
                        amortization_months: Some(input.months),
                        last_payment_date: None,
                        payment_amount: None,
                        renewal_maturity: None,
                        payment_account_id: None,
                        escrow_amount: None,
                    }),
                }),
            })
            .await
            .map_err(|e| anyhow!(e.to_string()))?;

        let financing = self
            .create_card_activity(
                &card.id,
                "CREDIT",
                charge.activity_date,
                amount,
                &charge.currency,
                format!("MSI financed: {name}"),
                json!({ MSI_KEY: {
                    "loanId": created.asset_id,
                    "role": "financing",
                    "chargeActivityId": charge.id,
                }}),
            )
            .await?;
        Ok(ConvertResult {
            loan_id: created.asset_id,
            financing_activity_id: financing.id,
        })
    }

    /// Post every MSI instalment due on or before `as_of` that has no payment
    /// yet, as a card withdrawal tagged as that instalment. Idempotent.
    pub async fn post_due(
        &self,
        as_of: NaiveDate,
        timezone: &str,
    ) -> Result<Vec<PostedInstalment>> {
        let mut posted = Vec::new();
        let holdings = self
            .alternative_assets
            .get_alternative_holdings()
            .map_err(|e| anyhow!(e.to_string()))?;
        for holding in holdings.iter().filter(|h| h.kind == AssetKind::Liability) {
            // Converted charges carry a nested `msi` object; loans opted in later
            // through the metadata route (flat strings only) use `msi_*` keys.
            let meta_str = |nested: &str, flat: &str| -> Option<String> {
                let m = holding.metadata.as_ref()?;
                m.get(MSI_KEY)
                    .and_then(|v| v.get(nested)?.as_str())
                    .or_else(|| m.get(flat)?.as_str())
                    .map(String::from)
            };
            let Some(card_id) = meta_str("cardAccountId", "msi_card_account_id") else {
                continue;
            };
            // Loans that existed before auto-posting carry `postFrom`: instalments
            // before that day were settled some other way and must not be posted.
            let post_from = meta_str("postFrom", "msi_post_from")
                .and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok());
            let instalments = self
                .alternative_assets
                .get_loan_instalments(&holding.id, as_of)
                .map_err(|e| anyhow!(e.to_string()))?;
            let total = holding
                .metadata
                .as_ref()
                .and_then(|m| m.get(MSI_KEY)?.get("months")?.as_u64())
                .or_else(|| {
                    holding
                        .loan
                        .as_ref()
                        .and_then(|l| l.original_amount.zip(l.payment_amount))
                        .map(|(o, p)| (o / p).round() as u64)
                })
                .unwrap_or(instalments.len() as u64) as usize;
            let paid: Vec<NaiveDate> = self
                .alternative_assets
                .get_loan_payments(&holding.id)
                .map_err(|e| anyhow!(e.to_string()))?
                .into_iter()
                .filter_map(|p| match p.applies_to {
                    Some(PaymentTarget::Instalment(d)) => Some(d),
                    _ => None,
                })
                .collect();
            for (index, instalment) in instalments.iter().enumerate() {
                if instalment.due_date > as_of
                    || post_from.is_some_and(|from| instalment.due_date < from)
                    || instalment.status == InstalmentStatus::Paid
                    || paid.contains(&instalment.due_date)
                    || instalment.scheduled <= 0.0
                {
                    continue;
                }
                let amount = Decimal::try_from(instalment.scheduled)
                    .map_err(|e| anyhow!(e.to_string()))?
                    .round_dp(2);
                let when = local_noon_utc(instalment.due_date, timezone);
                let activity = self
                    .create_card_activity(
                        &card_id,
                        "WITHDRAWAL",
                        when,
                        amount,
                        &holding.currency,
                        format!("MSI {}/{} {}", index + 1, total, holding.name),
                        json!({ MSI_KEY: {
                            "loanId": holding.id,
                            "role": "instalment",
                            "due": instalment.due_date,
                        }}),
                    )
                    .await?;
                self.alternative_assets
                    .link_loan_payment(
                        &activity.id,
                        PaymentLink::Link {
                            loan_id: holding.id.clone(),
                            escrow: None,
                            applies_to: Some(PaymentTarget::Instalment(instalment.due_date)),
                            replace_event: false,
                        },
                    )
                    .await
                    .map_err(|e| anyhow!(e.to_string()))?;
                posted.push(PostedInstalment {
                    loan_id: holding.id.clone(),
                    loan_name: holding.name.clone(),
                    due_date: instalment.due_date,
                    amount: amount.to_f64().unwrap_or(0.0),
                    activity_id: activity.id,
                });
            }
        }
        Ok(posted)
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_card_activity(
        &self,
        account_id: &str,
        activity_type: &str,
        when: DateTime<Utc>,
        amount: Decimal,
        currency: &str,
        notes: String,
        metadata: Value,
    ) -> Result<Activity> {
        let activity = self
            .activity_service
            .create_activity(NewActivity {
                id: None,
                account_id: account_id.to_string(),
                asset: None,
                activity_type: activity_type.to_string(),
                subtype: None,
                activity_date: when.to_rfc3339(),
                quantity: None,
                unit_price: None,
                currency: currency.to_string(),
                fee: None,
                tax: None,
                amount: Some(amount),
                status: None,
                notes: Some(notes),
                fx_rate: None,
                metadata: Some(metadata.to_string()),
                needs_review: None,
                source_system: None,
                source_record_id: None,
                source_group_id: None,
                idempotency_key: None,
                import_run_id: None,
            })
            .await
            .map_err(|e| anyhow!(e.to_string()))?;
        let category = self.msi_category_id()?;
        self.assignments
            .assign_single(&activity.id, SPENDING_TAXONOMY, &category)
            .await?;
        Ok(activity)
    }

    fn msi_category_id(&self) -> Result<String> {
        let taxonomy = self
            .taxonomy_service
            .get_taxonomy(SPENDING_TAXONOMY)?
            .ok_or_else(|| anyhow!("spending categories taxonomy is missing"))?;
        taxonomy
            .categories
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case(MSI_CATEGORY_NAME))
            .map(|c| c.id.clone())
            .ok_or_else(|| {
                anyhow!("create a spending category named \"{MSI_CATEGORY_NAME}\" and exclude it from spending first")
            })
    }
}

fn msi_meta(activity: &Activity) -> Option<Value> {
    activity.metadata.as_ref()?.get(MSI_KEY).cloned()
}

/// Noon in the user's zone on `date`, so the activity shows on that day everywhere.
fn local_noon_utc(date: NaiveDate, timezone: &str) -> DateTime<Utc> {
    let tz: chrono_tz::Tz = timezone.parse().unwrap_or(chrono_tz::UTC);
    let naive = date.and_hms_opt(12, 0, 0).unwrap_or_default();
    tz.from_local_datetime(&naive)
        .single()
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|| Utc.from_utc_datetime(&naive))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Datelike;

    #[test]
    fn noon_lands_on_the_same_local_day() {
        let d = NaiveDate::from_ymd_opt(2026, 12, 5).unwrap();
        let utc = local_noon_utc(d, "America/Mexico_City");
        assert_eq!(utc.day(), 5);
        assert_eq!(
            activity_date_in_user_timezone(utc, "America/Mexico_City"),
            d
        );
    }
}
