//! MSI: interest-free card instalment plans. See `wealthfolio_spending::msi`.

use std::sync::Arc;

use axum::{
    extract::Query,
    routing::{get, post},
    Json, Router,
};
use chrono::NaiveDate;
use serde::Deserialize;

use crate::{error::ApiResult, AppState};
use wealthfolio_spending::msi::{Candidate, ConvertInput, ConvertResult, PostedInstalment};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CandidatesQuery {
    days: Option<i64>,
}

async fn candidates(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(q): Query<CandidatesQuery>,
) -> ApiResult<Json<Vec<Candidate>>> {
    let timezone = state.timezone()?;
    Ok(Json(
        state
            .msi_service
            .candidates(q.days.unwrap_or(90), &timezone)?,
    ))
}

async fn convert(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Json(input): Json<ConvertInput>,
) -> ApiResult<Json<ConvertResult>> {
    let timezone = state.timezone()?;
    let result = state.msi_service.convert(input, &timezone).await?;
    crate::api::shared::enqueue_portfolio_job(
        state.clone(),
        crate::api::shared::PortfolioJobConfig {
            account_ids: None,
            market_sync_mode: wealthfolio_core::quotes::MarketSyncMode::None,
            force_full: false,
        },
    );
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PostDueQuery {
    as_of: Option<NaiveDate>,
}

async fn post_due(
    axum::Extension(state): axum::Extension<Arc<AppState>>,
    Query(q): Query<PostDueQuery>,
) -> ApiResult<Json<Vec<PostedInstalment>>> {
    let posted = post_due_instalments(&state, q.as_of).await?;
    Ok(Json(posted))
}

/// Shared by the route and the daily scheduler.
pub(crate) async fn post_due_instalments(
    state: &Arc<AppState>,
    as_of: Option<NaiveDate>,
) -> ApiResult<Vec<PostedInstalment>> {
    let timezone = state.timezone()?;
    let as_of = as_of.unwrap_or_else(|| {
        wealthfolio_core::utils::time_utils::activity_date_in_user_timezone(
            chrono::Utc::now(),
            &timezone,
        )
    });
    let posted = state.msi_service.post_due(as_of, &timezone).await?;
    if !posted.is_empty() {
        crate::api::shared::enqueue_portfolio_job(
            state.clone(),
            crate::api::shared::PortfolioJobConfig {
                account_ids: None,
                market_sync_mode: wealthfolio_core::quotes::MarketSyncMode::None,
                force_full: false,
            },
        );
    }
    Ok(posted)
}

pub fn router<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/spending/msi/candidates", get(candidates))
        .route("/spending/msi/convert", post(convert))
        .route("/spending/msi/post-due", post(post_due))
}
