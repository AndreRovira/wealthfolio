//! Envelopes: money pots funded on a pay cycle. See `wealthfolio_spending::envelopes`.

use std::sync::Arc;

use axum::{
    extract::{Path, Query},
    routing::{get, post},
    Json, Router,
};
use chrono::NaiveDate;
use serde::Deserialize;

use crate::{error::ApiResult, AppState};
use wealthfolio_spending::envelopes::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotQuery {
    as_of: Option<NaiveDate>,
}

async fn snapshot(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(q): Query<SnapshotQuery>,
) -> ApiResult<Json<EnvelopeSnapshot>> {
    let base = state.base_currency()?;
    let timezone = state.timezone()?;
    Ok(Json(
        state
            .envelope_service
            .snapshot(q.as_of, &base, &timezone)
            .await?,
    ))
}

async fn list_envelopes(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<Envelope>>> {
    Ok(Json(state.envelope_service.list_envelopes().await?))
}
async fn create_envelope(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(input): Json<EnvelopeInput>,
) -> ApiResult<Json<Envelope>> {
    Ok(Json(state.envelope_service.create_envelope(input).await?))
}
async fn update_envelope(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<EnvelopeInput>,
) -> ApiResult<Json<Envelope>> {
    let base = state.base_currency()?;
    let timezone = state.timezone()?;
    Ok(Json(
        state
            .envelope_service
            .update_envelope(&id, input, &base, &timezone)
            .await?,
    ))
}
async fn delete_envelope(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    let base = state.base_currency()?;
    let timezone = state.timezone()?;
    state
        .envelope_service
        .delete_envelope(&id, &base, &timezone)
        .await?;
    Ok(())
}

async fn list_bills(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<EnvelopeBill>>> {
    Ok(Json(state.envelope_service.list_bills().await?))
}
async fn create_bill(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(input): Json<EnvelopeBillInput>,
) -> ApiResult<Json<EnvelopeBill>> {
    Ok(Json(state.envelope_service.create_bill(input).await?))
}
async fn update_bill(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<EnvelopeBillInput>,
) -> ApiResult<Json<EnvelopeBill>> {
    Ok(Json(state.envelope_service.update_bill(&id, input).await?))
}
async fn delete_bill(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    state.envelope_service.delete_bill(&id).await?;
    Ok(())
}

async fn list_links(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<EnvelopeCategoryLink>>> {
    Ok(Json(state.envelope_service.list_links().await?))
}
async fn replace_links(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(links): Json<Vec<EnvelopeCategoryLink>>,
) -> ApiResult<()> {
    let base = state.base_currency()?;
    let timezone = state.timezone()?;
    state
        .envelope_service
        .replace_links(&id, links, &base, &timezone)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntriesQuery {
    envelope_id: Option<String>,
    from: Option<NaiveDate>,
}
async fn list_entries(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(q): Query<EntriesQuery>,
) -> ApiResult<Json<Vec<EnvelopeEntry>>> {
    Ok(Json(
        state
            .envelope_service
            .list_entries(q.envelope_id.as_deref(), q.from)
            .await?,
    ))
}
async fn add_entry(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(input): Json<EntryInput>,
) -> ApiResult<Json<EnvelopeEntry>> {
    Ok(Json(state.envelope_service.add_entry(input).await?))
}
async fn move_money(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(input): Json<MoveInput>,
) -> ApiResult<Json<Vec<EnvelopeEntry>>> {
    Ok(Json(state.envelope_service.move_money(input).await?))
}
async fn delete_entry(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    state.envelope_service.delete_entry(&id).await?;
    Ok(())
}

async fn list_rules(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<Vec<FundingRule>>> {
    Ok(Json(state.envelope_service.list_rules().await?))
}
async fn create_rule(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(input): Json<FundingRuleInput>,
) -> ApiResult<Json<FundingRule>> {
    Ok(Json(state.envelope_service.create_rule(input).await?))
}
async fn update_rule(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<FundingRuleInput>,
) -> ApiResult<Json<FundingRule>> {
    Ok(Json(state.envelope_service.update_rule(&id, input).await?))
}
async fn delete_rule(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
) -> ApiResult<()> {
    state.envelope_service.delete_rule(&id).await?;
    Ok(())
}
async fn apply_income(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(input): Json<ApplyIncomeInput>,
) -> ApiResult<Json<Vec<EnvelopeEntry>>> {
    Ok(Json(state.envelope_service.apply_income(input).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavingsQuery {
    period_key: Option<String>,
}

async fn savings(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(q): Query<SavingsQuery>,
) -> ApiResult<Json<wealthfolio_spending::savings::SavingsSnapshot>> {
    let base = state.base_currency()?;
    let timezone = state.timezone()?;
    Ok(Json(
        state
            .savings_service
            .snapshot(q.period_key, &base, &timezone)
            .await?,
    ))
}

async fn mark_bill_paid(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<MarkPaidInput>,
) -> ApiResult<Json<EnvelopeBill>> {
    let timezone = state.timezone()?;
    Ok(Json(
        state
            .envelope_service
            .mark_bill_paid(&id, input, &timezone)
            .await?,
    ))
}

async fn set_activity_envelope(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Path(id): Path<String>,
    Json(input): Json<ActivityEnvelopeInput>,
) -> ApiResult<()> {
    state
        .envelope_service
        .set_activity_envelope(&id, input)
        .await?;
    Ok(())
}

/// The income plan is a client-evaluated document: lines with amounts or
/// formulas plus named constants. The server only stores it.
async fn get_income_plan(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
) -> ApiResult<Json<serde_json::Value>> {
    let raw = state
        .spending_settings_service
        .get_document(INCOME_PLAN_KEY)
        .await?;
    let value = match raw {
        Some(s) => serde_json::from_str(&s).unwrap_or(serde_json::Value::Null),
        None => serde_json::Value::Null,
    };
    Ok(Json(value))
}

async fn put_income_plan(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(value): Json<serde_json::Value>,
) -> ApiResult<Json<serde_json::Value>> {
    state
        .spending_settings_service
        .set_document(INCOME_PLAN_KEY, &value.to_string())
        .await?;
    Ok(Json(value))
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route(
            "/spending/income-plan",
            get(get_income_plan).put(put_income_plan),
        )
        .route("/spending/savings", get(savings))
        .route("/spending/envelopes/snapshot", get(snapshot))
        .route(
            "/spending/envelopes",
            get(list_envelopes).post(create_envelope),
        )
        .route(
            "/spending/envelopes/{id}",
            axum::routing::put(update_envelope).delete(delete_envelope),
        )
        .route(
            "/spending/envelopes/{id}/links",
            axum::routing::put(replace_links),
        )
        .route("/spending/envelopes/links", get(list_links))
        .route(
            "/spending/envelopes/bills",
            get(list_bills).post(create_bill),
        )
        .route(
            "/spending/envelopes/bills/{id}",
            axum::routing::put(update_bill).delete(delete_bill),
        )
        .route("/spending/envelopes/bills/{id}/paid", post(mark_bill_paid))
        .route(
            "/spending/envelopes/entries",
            get(list_entries).post(add_entry),
        )
        .route(
            "/spending/envelopes/entries/{id}",
            axum::routing::delete(delete_entry),
        )
        .route("/spending/envelopes/move", post(move_money))
        .route(
            "/spending/envelopes/rules",
            get(list_rules).post(create_rule),
        )
        .route(
            "/spending/envelopes/rules/{id}",
            axum::routing::put(update_rule).delete(delete_rule),
        )
        .route("/spending/envelopes/apply-income", post(apply_income))
        .route(
            "/spending/envelopes/activity/{id}",
            axum::routing::put(set_activity_envelope),
        )
}
