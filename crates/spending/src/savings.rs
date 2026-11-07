//! Savings plan vs actual: money moved from spending accounts into the other
//! accounts (brokerage, retirement, savings pots), per destination account.
//! The monthly plan lives in each account's `meta` JSON under
//! `savingsPlanMonthly`, so no new table is needed.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use chrono::{Datelike, NaiveDate, TimeZone, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use wealthfolio_core::accounts::{account_types, AccountRepositoryTrait};
use wealthfolio_core::activities::{
    ActivityRepositoryTrait, ACTIVITY_TYPE_TRANSFER_IN, ACTIVITY_TYPE_TRANSFER_OUT,
};
use wealthfolio_core::utils::time_utils::activity_date_in_user_timezone;

use crate::activity_classification::{activity_abs_amount, classify_activity};
use crate::settings::SpendingSettingsService;

pub const PLAN_KEY: &str = "savingsPlanMonthly";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavingsRow {
    pub account_id: String,
    pub account_name: String,
    pub account_type: String,
    pub planned_monthly: f64,
    pub actual_month: f64,
    pub actual_ytd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavingsSnapshot {
    pub period_key: String,
    pub currency: String,
    pub rows: Vec<SavingsRow>,
    pub planned_monthly_total: f64,
    pub actual_month_total: f64,
    pub actual_ytd_total: f64,
    /// Income received in spending accounts this month and year to date.
    pub income_month: f64,
    pub income_ytd: f64,
}

pub struct SavingsService {
    activity_repo: Arc<dyn ActivityRepositoryTrait>,
    account_repo: Arc<dyn AccountRepositoryTrait>,
    spending_settings: Arc<SpendingSettingsService>,
    fx_service: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
}

impl SavingsService {
    pub fn new(
        activity_repo: Arc<dyn ActivityRepositoryTrait>,
        account_repo: Arc<dyn AccountRepositoryTrait>,
        spending_settings: Arc<SpendingSettingsService>,
        fx_service: Arc<dyn wealthfolio_core::fx::FxServiceTrait>,
    ) -> Self {
        Self {
            activity_repo,
            account_repo,
            spending_settings,
            fx_service,
        }
    }

    pub async fn snapshot(
        &self,
        period_key: Option<String>,
        currency: &str,
        timezone: &str,
    ) -> Result<SavingsSnapshot> {
        let today = activity_date_in_user_timezone(Utc::now(), timezone);
        let (year, month) = match period_key.as_deref() {
            Some(key) => {
                let (y, m) = key
                    .split_once('-')
                    .ok_or_else(|| anyhow!("period must be YYYY-MM"))?;
                (y.parse::<i32>()?, m.parse::<u32>()?)
            }
            None => (today.year(), today.month()),
        };
        let month_start =
            NaiveDate::from_ymd_opt(year, month, 1).ok_or_else(|| anyhow!("bad period"))?;
        let month_end = if month == 12 {
            NaiveDate::from_ymd_opt(year + 1, 1, 1)
        } else {
            NaiveDate::from_ymd_opt(year, month + 1, 1)
        }
        .and_then(|d| d.pred_opt())
        .ok_or_else(|| anyhow!("bad period"))?;
        let year_start = NaiveDate::from_ymd_opt(year, 1, 1).ok_or_else(|| anyhow!("bad year"))?;
        let period_key = format!("{year:04}-{month:02}");

        let settings = self.spending_settings.get().await?;
        let accounts = self
            .account_repo
            .list(None, Some(false), None)
            .map_err(|e| anyhow!(e.to_string()))?;
        let spending_ids: Vec<&str> = settings.account_ids.iter().map(String::as_str).collect();
        let destinations: Vec<_> = accounts
            .iter()
            .filter(|a| {
                a.is_active
                    && !a.is_archived
                    && !spending_ids.contains(&a.id.as_str())
                    && a.account_type != account_types::CREDIT_CARD
            })
            .collect();
        let fx = self.fx_service.as_ref();
        let fx_as_of = month_end.min(today);

        // Flows into each destination, net of what came back out.
        let mut month_by_account: HashMap<String, Decimal> = HashMap::new();
        let mut ytd_by_account: HashMap<String, Decimal> = HashMap::new();
        let dest_ids: Vec<String> = destinations.iter().map(|a| a.id.clone()).collect();
        let (start_utc, end_utc) = bounds(year_start, month_end)?;
        if !dest_ids.is_empty() {
            for activity in self
                .activity_repo
                .get_activities_by_account_ids_in_date_range(&dest_ids, start_utc, end_utc)
                .map_err(|e| anyhow!(e.to_string()))?
            {
                let sign = match activity.effective_type() {
                    t if t == ACTIVITY_TYPE_TRANSFER_IN => Decimal::ONE,
                    t if t == ACTIVITY_TYPE_TRANSFER_OUT => Decimal::NEGATIVE_ONE,
                    _ => continue,
                };
                if !activity.is_posted() {
                    continue;
                }
                let day = activity_date_in_user_timezone(activity.activity_date, timezone);
                if day < year_start || day > month_end {
                    continue;
                }
                let amount = crate::fx::convert(
                    fx,
                    activity_abs_amount(&activity) * sign,
                    &activity.currency,
                    currency,
                    fx_as_of,
                )
                .unwrap_or(Decimal::ZERO);
                *ytd_by_account
                    .entry(activity.account_id.clone())
                    .or_default() += amount;
                if day >= month_start {
                    *month_by_account
                        .entry(activity.account_id.clone())
                        .or_default() += amount;
                }
            }
        }

        // Income landing in spending accounts, for the savings rate.
        let mut income_month = Decimal::ZERO;
        let mut income_ytd = Decimal::ZERO;
        if settings.enabled && !settings.account_ids.is_empty() {
            let types: HashMap<&str, &str> = accounts
                .iter()
                .map(|a| (a.id.as_str(), a.account_type.as_str()))
                .collect();
            for activity in self
                .activity_repo
                .get_activities_by_account_ids_in_date_range(
                    &settings.account_ids,
                    start_utc,
                    end_utc,
                )
                .map_err(|e| anyhow!(e.to_string()))?
            {
                let Some(account_type) = types.get(activity.account_id.as_str()) else {
                    continue;
                };
                let native = classify_activity(&activity, account_type)
                    .income_amount(activity_abs_amount(&activity));
                if native == Decimal::ZERO {
                    continue;
                }
                let day = activity_date_in_user_timezone(activity.activity_date, timezone);
                if day < year_start || day > month_end {
                    continue;
                }
                let amount = crate::fx::convert(fx, native, &activity.currency, currency, fx_as_of)
                    .unwrap_or(Decimal::ZERO);
                income_ytd += amount;
                if day >= month_start {
                    income_month += amount;
                }
            }
        }

        let mut rows: Vec<SavingsRow> = destinations
            .iter()
            .map(|a| SavingsRow {
                account_id: a.id.clone(),
                account_name: a.name.clone(),
                account_type: a.account_type.clone(),
                planned_monthly: planned_monthly(a.meta.as_deref()),
                actual_month: f64_of(month_by_account.get(&a.id).copied().unwrap_or_default()),
                actual_ytd: f64_of(ytd_by_account.get(&a.id).copied().unwrap_or_default()),
            })
            .filter(|r| r.planned_monthly != 0.0 || r.actual_month != 0.0 || r.actual_ytd != 0.0)
            .collect();
        rows.sort_by(|a, b| {
            b.planned_monthly
                .partial_cmp(&a.planned_monthly)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.account_name.cmp(&b.account_name))
        });
        Ok(SavingsSnapshot {
            period_key,
            currency: currency.to_string(),
            planned_monthly_total: rows.iter().map(|r| r.planned_monthly).sum(),
            actual_month_total: rows.iter().map(|r| r.actual_month).sum(),
            actual_ytd_total: rows.iter().map(|r| r.actual_ytd).sum(),
            income_month: f64_of(income_month),
            income_ytd: f64_of(income_ytd),
            rows,
        })
    }
}

fn planned_monthly(meta: Option<&str>) -> f64 {
    meta.and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .and_then(|v| v.get(PLAN_KEY)?.as_f64())
        .unwrap_or(0.0)
}

fn bounds(
    start: NaiveDate,
    end: NaiveDate,
) -> Result<(chrono::DateTime<Utc>, chrono::DateTime<Utc>)> {
    let s = (start - chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| anyhow!("bad start"))?;
    let e = (end + chrono::Duration::days(1))
        .and_hms_opt(23, 59, 59)
        .ok_or_else(|| anyhow!("bad end"))?;
    Ok((Utc.from_utc_datetime(&s), Utc.from_utc_datetime(&e)))
}

fn f64_of(v: Decimal) -> f64 {
    v.round_dp(2).to_f64().unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_reads_from_meta_json() {
        assert_eq!(
            planned_monthly(Some(r#"{"savingsPlanMonthly": 7759.58}"#)),
            7759.58
        );
        assert_eq!(planned_monthly(Some("{}")), 0.0);
        assert_eq!(planned_monthly(None), 0.0);
        assert_eq!(planned_monthly(Some("not json")), 0.0);
    }
}
