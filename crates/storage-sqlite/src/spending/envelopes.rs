//! Storage adapter for spending::envelopes. No sync outbox: envelopes are a
//! single-device feature of this fork.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use chrono::NaiveDate;
use diesel::prelude::*;
use rust_decimal::prelude::{FromPrimitive, ToPrimitive};
use rust_decimal::Decimal;
use uuid::Uuid;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::{
    envelope_bills, envelope_category_links, envelope_entries, envelope_funding_rules, envelopes,
};
use wealthfolio_spending::envelopes::*;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
fn date(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap_or_default()
}
fn amount_str(v: f64) -> String {
    Decimal::from_f64(v)
        .unwrap_or_default()
        .round_dp(2)
        .to_string()
}
fn amount_f64(s: &str) -> f64 {
    s.parse::<Decimal>()
        .ok()
        .and_then(|d| d.to_f64())
        .unwrap_or(0.0)
}
fn err(e: impl std::fmt::Display) -> anyhow::Error {
    anyhow!(e.to_string())
}

#[derive(Queryable, Insertable, Selectable, Debug, Clone)]
#[diesel(table_name = envelopes)]
struct EnvelopeDB {
    id: String,
    name: String,
    color: Option<String>,
    icon: Option<String>,
    sort_order: i32,
    allow_negative: i32,
    start_date: String,
    archived: i32,
    created_at: String,
    updated_at: String,
}
impl From<EnvelopeDB> for Envelope {
    fn from(r: EnvelopeDB) -> Self {
        Envelope {
            id: r.id,
            name: r.name,
            color: r.color,
            icon: r.icon,
            sort_order: r.sort_order,
            allow_negative: r.allow_negative != 0,
            start_date: date(&r.start_date),
            archived: r.archived != 0,
        }
    }
}

#[derive(Queryable, Insertable, Selectable, Debug, Clone)]
#[diesel(table_name = envelope_bills)]
struct BillDB {
    id: String,
    envelope_id: String,
    name: String,
    expected_amount: String,
    due_day: Option<i32>,
    cycle: String,
    sort_order: i32,
    archived: i32,
    created_at: String,
    updated_at: String,
    next_due: Option<String>,
}
impl From<BillDB> for EnvelopeBill {
    fn from(r: BillDB) -> Self {
        EnvelopeBill {
            id: r.id,
            envelope_id: r.envelope_id,
            name: r.name,
            expected_amount: amount_f64(&r.expected_amount),
            due_day: r.due_day,
            cycle: r.cycle,
            sort_order: r.sort_order,
            archived: r.archived != 0,
            next_due: r.next_due.as_deref().map(date),
        }
    }
}

#[derive(Queryable, Insertable, Selectable, Debug, Clone)]
#[diesel(table_name = envelope_category_links)]
struct LinkDB {
    category_id: String,
    envelope_id: String,
    bill_id: Option<String>,
    created_at: String,
}

#[derive(Queryable, Insertable, Selectable, Debug, Clone)]
#[diesel(table_name = envelope_entries)]
struct EntryDB {
    id: String,
    envelope_id: String,
    bill_id: Option<String>,
    entry_date: String,
    amount: String,
    kind: String,
    note: Option<String>,
    move_id: Option<String>,
    rule_id: Option<String>,
    period_key: Option<String>,
    activity_id: Option<String>,
    created_at: String,
}
impl From<EntryDB> for EnvelopeEntry {
    fn from(r: EntryDB) -> Self {
        EnvelopeEntry {
            id: r.id,
            envelope_id: r.envelope_id,
            bill_id: r.bill_id,
            entry_date: date(&r.entry_date),
            amount: amount_f64(&r.amount),
            kind: EnvelopeEntryKind::parse(&r.kind).unwrap_or_default(),
            note: r.note,
            move_id: r.move_id,
            rule_id: r.rule_id,
            period_key: r.period_key,
            activity_id: r.activity_id,
        }
    }
}

#[derive(Queryable, Insertable, Selectable, Debug, Clone)]
#[diesel(table_name = envelope_funding_rules)]
struct RuleDB {
    id: String,
    name: String,
    cadence: String,
    anchor_date: Option<String>,
    day_of_month: Option<i32>,
    income_category_id: Option<String>,
    splits_json: String,
    active: i32,
    created_at: String,
    updated_at: String,
}
impl From<RuleDB> for FundingRule {
    fn from(r: RuleDB) -> Self {
        FundingRule {
            id: r.id,
            name: r.name,
            cadence: FundingCadence::parse(&r.cadence).unwrap_or(FundingCadence::Monthly),
            anchor_date: r.anchor_date.as_deref().map(date),
            day_of_month: r.day_of_month,
            income_category_id: r.income_category_id,
            splits: serde_json::from_str(&r.splits_json).unwrap_or_default(),
            active: r.active != 0,
        }
    }
}

pub struct EnvelopeRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl EnvelopeRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }
}

#[async_trait]
impl EnvelopeRepositoryTrait for EnvelopeRepository {
    async fn list_envelopes(&self) -> Result<Vec<Envelope>> {
        let mut conn = get_connection(&self.pool).map_err(err)?;
        let rows = envelopes::table
            .order((envelopes::sort_order.asc(), envelopes::name.asc()))
            .load::<EnvelopeDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn create_envelope(&self, input: EnvelopeInput) -> Result<Envelope> {
        let ts = now();
        let row = EnvelopeDB {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            color: input.color,
            icon: input.icon,
            sort_order: input.sort_order.unwrap_or(0),
            allow_negative: input.allow_negative.unwrap_or(false) as i32,
            start_date: input
                .start_date
                .unwrap_or_else(|| chrono::Utc::now().date_naive())
                .to_string(),
            archived: input.archived.unwrap_or(false) as i32,
            created_at: ts.clone(),
            updated_at: ts,
        };
        let out = row.clone();
        self.writer
            .exec(move |conn| {
                diesel::insert_into(envelopes::table)
                    .values(&row)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)?;
        Ok(out.into())
    }

    async fn update_envelope(&self, id: &str, input: EnvelopeInput) -> Result<Envelope> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                let mut row: EnvelopeDB = envelopes::table
                    .find(&id)
                    .first(conn)
                    .map_err(StorageError::from)?;
                row.name = input.name.trim().to_string();
                row.color = input.color;
                row.icon = input.icon;
                if let Some(v) = input.sort_order {
                    row.sort_order = v;
                }
                if let Some(v) = input.allow_negative {
                    row.allow_negative = v as i32;
                }
                if let Some(v) = input.start_date {
                    row.start_date = v.to_string();
                }
                if let Some(v) = input.archived {
                    row.archived = v as i32;
                }
                row.updated_at = now();
                diesel::update(envelopes::table.find(&id))
                    .set((
                        envelopes::name.eq(&row.name),
                        envelopes::color.eq(&row.color),
                        envelopes::icon.eq(&row.icon),
                        envelopes::sort_order.eq(row.sort_order),
                        envelopes::allow_negative.eq(row.allow_negative),
                        envelopes::start_date.eq(&row.start_date),
                        envelopes::archived.eq(row.archived),
                        envelopes::updated_at.eq(&row.updated_at),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(Envelope::from(row))
            })
            .await
            .map_err(err)
    }

    async fn delete_envelope(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                diesel::delete(envelopes::table.find(&id))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)
    }

    async fn list_bills(&self) -> Result<Vec<EnvelopeBill>> {
        let mut conn = get_connection(&self.pool).map_err(err)?;
        let rows = envelope_bills::table
            .order((envelope_bills::sort_order.asc(), envelope_bills::name.asc()))
            .load::<BillDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn create_bill(&self, input: EnvelopeBillInput) -> Result<EnvelopeBill> {
        let ts = now();
        let row = BillDB {
            id: Uuid::new_v4().to_string(),
            envelope_id: input.envelope_id,
            name: input.name.trim().to_string(),
            expected_amount: amount_str(input.expected_amount.unwrap_or(0.0)),
            due_day: input.due_day,
            cycle: input.cycle.unwrap_or_else(|| "monthly".into()),
            sort_order: input.sort_order.unwrap_or(0),
            archived: input.archived.unwrap_or(false) as i32,
            created_at: ts.clone(),
            updated_at: ts,
            next_due: input.next_due.map(|d| d.to_string()),
        };
        let out = row.clone();
        self.writer
            .exec(move |conn| {
                diesel::insert_into(envelope_bills::table)
                    .values(&row)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)?;
        Ok(out.into())
    }

    async fn update_bill(&self, id: &str, input: EnvelopeBillInput) -> Result<EnvelopeBill> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                let mut row: BillDB = envelope_bills::table
                    .find(&id)
                    .first(conn)
                    .map_err(StorageError::from)?;
                row.envelope_id = input.envelope_id;
                row.name = input.name.trim().to_string();
                if let Some(v) = input.expected_amount {
                    row.expected_amount = amount_str(v);
                }
                row.due_day = input.due_day;
                if let Some(v) = input.cycle {
                    row.cycle = v;
                }
                if let Some(v) = input.sort_order {
                    row.sort_order = v;
                }
                if let Some(v) = input.archived {
                    row.archived = v as i32;
                }
                if let Some(v) = input.next_due {
                    row.next_due = Some(v.to_string());
                }
                row.updated_at = now();
                diesel::update(envelope_bills::table.find(&id))
                    .set((
                        envelope_bills::next_due.eq(&row.next_due),
                        envelope_bills::envelope_id.eq(&row.envelope_id),
                        envelope_bills::name.eq(&row.name),
                        envelope_bills::expected_amount.eq(&row.expected_amount),
                        envelope_bills::due_day.eq(row.due_day),
                        envelope_bills::cycle.eq(&row.cycle),
                        envelope_bills::sort_order.eq(row.sort_order),
                        envelope_bills::archived.eq(row.archived),
                        envelope_bills::updated_at.eq(&row.updated_at),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(EnvelopeBill::from(row))
            })
            .await
            .map_err(err)
    }

    async fn set_bill_next_due(&self, id: &str, next_due: Option<NaiveDate>) -> Result<()> {
        let id = id.to_string();
        let value = next_due.map(|d| d.to_string());
        self.writer
            .exec(move |conn| {
                diesel::update(envelope_bills::table.find(&id))
                    .set((
                        envelope_bills::next_due.eq(&value),
                        envelope_bills::updated_at.eq(now()),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)
    }

    async fn delete_bill(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                diesel::delete(envelope_bills::table.find(&id))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)
    }

    async fn list_links(&self) -> Result<Vec<EnvelopeCategoryLink>> {
        let mut conn = get_connection(&self.pool).map_err(err)?;
        let rows = envelope_category_links::table
            .load::<LinkDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows
            .into_iter()
            .map(|r| EnvelopeCategoryLink {
                category_id: r.category_id,
                envelope_id: r.envelope_id,
                bill_id: r.bill_id,
            })
            .collect())
    }

    async fn replace_links(
        &self,
        envelope_id: &str,
        links: Vec<EnvelopeCategoryLink>,
    ) -> Result<()> {
        let envelope_id = envelope_id.to_string();
        self.writer
            .exec(move |conn| {
                conn.transaction::<_, StorageError, _>(|conn| {
                    diesel::delete(
                        envelope_category_links::table
                            .filter(envelope_category_links::envelope_id.eq(&envelope_id)),
                    )
                    .execute(conn)?;
                    let ts = now();
                    for link in links {
                        let row = LinkDB {
                            category_id: link.category_id,
                            envelope_id: link.envelope_id,
                            bill_id: link.bill_id,
                            created_at: ts.clone(),
                        };
                        // A category can only feed one pot: the newest link wins.
                        diesel::replace_into(envelope_category_links::table)
                            .values(&row)
                            .execute(conn)?;
                    }
                    Ok(())
                })?;
                Ok(())
            })
            .await
            .map_err(err)
    }

    async fn list_entries(
        &self,
        envelope_id: Option<&str>,
        from: Option<NaiveDate>,
    ) -> Result<Vec<EnvelopeEntry>> {
        let mut conn = get_connection(&self.pool).map_err(err)?;
        let mut query = envelope_entries::table.into_boxed();
        if let Some(id) = envelope_id {
            query = query.filter(envelope_entries::envelope_id.eq(id.to_string()));
        }
        if let Some(from) = from {
            query = query.filter(envelope_entries::entry_date.ge(from.to_string()));
        }
        let rows = query
            .order((
                envelope_entries::entry_date.desc(),
                envelope_entries::created_at.desc(),
            ))
            .load::<EntryDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn insert_entries(&self, entries: Vec<NewEnvelopeEntry>) -> Result<Vec<EnvelopeEntry>> {
        let ts = now();
        let rows = entries
            .into_iter()
            .map(|e| EntryDB {
                id: Uuid::new_v4().to_string(),
                envelope_id: e.envelope_id,
                bill_id: e.bill_id,
                entry_date: e.entry_date.to_string(),
                amount: amount_str(e.amount),
                kind: e.kind.as_str().to_string(),
                note: e.note,
                move_id: e.move_id,
                rule_id: e.rule_id,
                period_key: e.period_key,
                activity_id: e.activity_id,
                created_at: ts.clone(),
            })
            .collect::<Vec<_>>();
        let out = rows.clone();
        self.writer
            .exec(move |conn| {
                conn.transaction::<_, StorageError, _>(|conn| {
                    for row in &rows {
                        diesel::insert_into(envelope_entries::table)
                            .values(row)
                            .execute(conn)?;
                    }
                    Ok(())
                })?;
                Ok(())
            })
            .await
            .map_err(err)?;
        Ok(out.into_iter().map(Into::into).collect())
    }

    async fn delete_entry(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                diesel::delete(envelope_entries::table.find(&id))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)
    }

    async fn delete_move(&self, move_id: &str) -> Result<()> {
        let move_id = move_id.to_string();
        self.writer
            .exec(move |conn| {
                diesel::delete(
                    envelope_entries::table.filter(envelope_entries::move_id.eq(&move_id)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)
    }

    async fn list_rules(&self) -> Result<Vec<FundingRule>> {
        let mut conn = get_connection(&self.pool).map_err(err)?;
        let rows = envelope_funding_rules::table
            .order(envelope_funding_rules::name.asc())
            .load::<RuleDB>(&mut conn)
            .map_err(StorageError::from)?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    async fn create_rule(&self, input: FundingRuleInput) -> Result<FundingRule> {
        let ts = now();
        let row = RuleDB {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            cadence: input.cadence.as_str().to_string(),
            anchor_date: input.anchor_date.map(|d| d.to_string()),
            day_of_month: input.day_of_month,
            income_category_id: input.income_category_id,
            splits_json: serde_json::to_string(&input.splits)?,
            active: input.active.unwrap_or(true) as i32,
            created_at: ts.clone(),
            updated_at: ts,
        };
        let out = row.clone();
        self.writer
            .exec(move |conn| {
                diesel::insert_into(envelope_funding_rules::table)
                    .values(&row)
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)?;
        Ok(out.into())
    }

    async fn update_rule(&self, id: &str, input: FundingRuleInput) -> Result<FundingRule> {
        let id = id.to_string();
        let splits_json = serde_json::to_string(&input.splits)?;
        self.writer
            .exec(move |conn| {
                let mut row: RuleDB = envelope_funding_rules::table
                    .find(&id)
                    .first(conn)
                    .map_err(StorageError::from)?;
                row.name = input.name.trim().to_string();
                row.cadence = input.cadence.as_str().to_string();
                row.anchor_date = input.anchor_date.map(|d| d.to_string());
                row.day_of_month = input.day_of_month;
                row.income_category_id = input.income_category_id;
                row.splits_json = splits_json;
                if let Some(v) = input.active {
                    row.active = v as i32;
                }
                row.updated_at = now();
                diesel::update(envelope_funding_rules::table.find(&id))
                    .set((
                        envelope_funding_rules::name.eq(&row.name),
                        envelope_funding_rules::cadence.eq(&row.cadence),
                        envelope_funding_rules::anchor_date.eq(&row.anchor_date),
                        envelope_funding_rules::day_of_month.eq(row.day_of_month),
                        envelope_funding_rules::income_category_id.eq(&row.income_category_id),
                        envelope_funding_rules::splits_json.eq(&row.splits_json),
                        envelope_funding_rules::active.eq(row.active),
                        envelope_funding_rules::updated_at.eq(&row.updated_at),
                    ))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(FundingRule::from(row))
            })
            .await
            .map_err(err)
    }

    async fn delete_rule(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                diesel::delete(envelope_funding_rules::table.find(&id))
                    .execute(conn)
                    .map_err(StorageError::from)?;
                Ok(())
            })
            .await
            .map_err(err)
    }
}
