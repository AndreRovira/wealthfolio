use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub allow_negative: bool,
    /// Spend in linked categories counts from this day on (inclusive).
    pub start_date: NaiveDate,
    pub archived: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeInput {
    pub name: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub sort_order: Option<i32>,
    pub allow_negative: Option<bool>,
    pub start_date: Option<NaiveDate>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeBill {
    pub id: String,
    pub envelope_id: String,
    pub name: String,
    /// Expected amount per cycle, in the base currency.
    pub expected_amount: f64,
    pub due_day: Option<i32>,
    /// "monthly", "yearly" or "N months".
    pub cycle: String,
    pub sort_order: i32,
    pub archived: bool,
    /// Next date the bill must be paid; a registered payment moves it one cycle.
    pub next_due: Option<NaiveDate>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeBillInput {
    pub envelope_id: String,
    pub name: String,
    pub expected_amount: Option<f64>,
    pub due_day: Option<i32>,
    pub cycle: Option<String>,
    pub sort_order: Option<i32>,
    pub archived: Option<bool>,
    #[serde(default)]
    pub next_due: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeCategoryLink {
    pub category_id: String,
    pub envelope_id: String,
    pub bill_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvelopeEntryKind {
    Funding,
    Move,
    #[default]
    Adjustment,
}

impl EnvelopeEntryKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Funding => "funding",
            Self::Move => "move",
            Self::Adjustment => "adjustment",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "funding" => Some(Self::Funding),
            "move" => Some(Self::Move),
            "adjustment" => Some(Self::Adjustment),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeEntry {
    pub id: String,
    pub envelope_id: String,
    pub bill_id: Option<String>,
    pub entry_date: NaiveDate,
    /// Positive adds to the pot, negative takes from it. Base currency.
    pub amount: f64,
    pub kind: EnvelopeEntryKind,
    pub note: Option<String>,
    /// Both legs of a move share this id.
    pub move_id: Option<String>,
    pub rule_id: Option<String>,
    pub period_key: Option<String>,
    /// The income deposit a rule-proposed funding came from.
    pub activity_id: Option<String>,
}

/// Internal insert shape: ids and provenance filled by the service.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEnvelopeEntry {
    pub envelope_id: String,
    pub bill_id: Option<String>,
    pub entry_date: NaiveDate,
    pub amount: f64,
    pub kind: EnvelopeEntryKind,
    pub note: Option<String>,
    pub move_id: Option<String>,
    pub rule_id: Option<String>,
    pub period_key: Option<String>,
    pub activity_id: Option<String>,
}

/// Fund or adjust one pot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub envelope_id: String,
    pub bill_id: Option<String>,
    pub entry_date: NaiveDate,
    pub amount: f64,
    pub kind: EnvelopeEntryKind,
    pub note: Option<String>,
}

/// Move money between two pots (envelope or bill level).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveInput {
    pub entry_date: NaiveDate,
    pub amount: f64,
    pub from_envelope_id: String,
    pub from_bill_id: Option<String>,
    pub to_envelope_id: String,
    pub to_bill_id: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FundingCadence {
    /// Every 14 days from `anchor_date`.
    Biweekly,
    /// The 15th and the last day of every month, from `anchor_date`.
    Semimonthly,
    /// Once a month on `day_of_month` (clamped to month length).
    Monthly,
    /// Proposed when a deposit assigned to `income_category_id` lands.
    OnIncome,
}

impl FundingCadence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Biweekly => "biweekly",
            Self::Semimonthly => "semimonthly",
            Self::Monthly => "monthly",
            Self::OnIncome => "on_income",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "biweekly" => Some(Self::Biweekly),
            "semimonthly" => Some(Self::Semimonthly),
            "monthly" => Some(Self::Monthly),
            "on_income" => Some(Self::OnIncome),
            _ => None,
        }
    }
}

/// One line of a funding rule: a fixed amount, or a percent of what is left
/// after the fixed amounts and earlier percent lines were taken.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingSplit {
    pub envelope_id: String,
    pub bill_id: Option<String>,
    #[serde(default)]
    pub amount: Option<f64>,
    /// 0-100. Percent of the running remainder of the income amount.
    #[serde(default)]
    pub percent: Option<f64>,
    /// Names the line when an envelope takes several (its components).
    #[serde(default)]
    pub label: Option<String>,
    /// Where `amount` comes from each time the rules are read; the stored
    /// amount is only the last known value. `bill` = the bill's cost spread
    /// over its cycle, `remainder` = the plan's expected paycheck minus every
    /// other fixed line, anything else = an income-plan line (`base.on_call`,
    /// or `-base.grocery_vouchers` to subtract it), per quincena.
    #[serde(default)]
    pub source: Option<String>,
}

pub const SOURCE_BILL: &str = "bill";
pub const SOURCE_REMAINDER: &str = "remainder";
/// Key in the plan's resolved values holding the expected net paycheck.
pub const PLAN_EXPECTED_KEY: &str = "paycheck.expected";
/// Settings key of the income plan document.
pub const INCOME_PLAN_KEY: &str = "spending.income_plan";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingRule {
    pub id: String,
    pub name: String,
    pub cadence: FundingCadence,
    pub anchor_date: Option<NaiveDate>,
    pub day_of_month: Option<i32>,
    pub income_category_id: Option<String>,
    pub splits: Vec<FundingSplit>,
    pub active: bool,
    /// On-income rules: when the deposit is short of the fixed lines, this
    /// envelope absorbs the gap instead of the remainder clamping to zero.
    pub shortfall_envelope_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingRuleInput {
    pub name: String,
    pub cadence: FundingCadence,
    pub anchor_date: Option<NaiveDate>,
    pub day_of_month: Option<i32>,
    pub income_category_id: Option<String>,
    pub splits: Vec<FundingSplit>,
    pub active: Option<bool>,
    #[serde(default)]
    pub shortfall_envelope_id: Option<String>,
}

// ----------------------------- snapshot -----------------------------

/// Where a bill stands against its next due date.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BillState {
    /// Pot below cost, due date ahead.
    Funding,
    /// Pot covers cost, due date ahead.
    Ready,
    /// Due date passed, pot covers cost, payment not registered yet.
    Overdue,
    /// Due date passed and the pot does not cover the cost.
    Underfunded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BillBalance {
    pub bill: EnvelopeBill,
    pub funded: f64,
    pub spent: f64,
    pub balance: f64,
    pub linked_category_ids: Vec<String>,
    pub state: BillState,
    /// Days from as_of to next_due; negative when past; None without a date.
    pub days_left: Option<i64>,
    /// Latest spend that hit this bill's pot.
    pub last_payment: Option<NaiveDate>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkPaidInput {
    /// Payment date; defaults to today.
    pub date: Option<NaiveDate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeBalance {
    pub envelope: Envelope,
    /// Sum of ledger entries at envelope level and bill level.
    pub funded: f64,
    pub spent: f64,
    pub balance: f64,
    /// Entries + spend inside the current calendar month, for the period view.
    pub funded_this_month: f64,
    pub spent_this_month: f64,
    /// Spend inside the current quincena (1-15 or 16-end of month).
    pub spent_this_period: f64,
    /// What scheduled rules put in per quincena at envelope level; 0 = no bar.
    pub period_target: f64,
    pub linked_category_ids: Vec<String>,
    pub bills: Vec<BillBalance>,
}

/// An income deposit an on-income rule applies to that has no funding yet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingIncome {
    pub activity_id: String,
    pub date: NaiveDate,
    pub amount: f64,
    pub category_id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub proposed: Vec<ProposedSplit>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedSplit {
    pub envelope_id: String,
    pub bill_id: Option<String>,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeSnapshot {
    pub as_of: NaiveDate,
    pub currency: String,
    pub envelopes: Vec<EnvelopeBalance>,
    pub rules: Vec<FundingRule>,
    pub pending_income: Vec<PendingIncome>,
    pub total_balance: f64,
}

/// Apply an on-income rule to one deposit with the final amounts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyIncomeInput {
    pub rule_id: String,
    pub activity_id: String,
    pub entry_date: NaiveDate,
    pub splits: Vec<ProposedSplit>,
}

/// Per-activity pot override, stored in the activity's metadata under
/// `envelope`. `envelope_id` None means "no pot at all"; absent key means
/// "follow the category link".
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEnvelope {
    pub envelope_id: Option<String>,
    #[serde(default)]
    pub bill_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEnvelopeInput {
    /// Some(envelope) pins the activity to a pot (envelope_id None = no pot);
    /// None removes the override.
    pub envelope: Option<ActivityEnvelope>,
}
