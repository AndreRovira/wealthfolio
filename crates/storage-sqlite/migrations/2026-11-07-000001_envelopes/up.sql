-- Envelopes: money pots funded on a pay cycle, independent of the monthly budget.
-- Balance = sum(entries) - spend in linked categories since the envelope start date.
CREATE TABLE envelopes (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    allow_negative INTEGER NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- A recurring bill with its own pot inside an envelope.
CREATE TABLE envelope_bills (
    id TEXT NOT NULL PRIMARY KEY,
    envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    expected_amount TEXT NOT NULL DEFAULT '0',
    due_day INTEGER,
    cycle TEXT NOT NULL DEFAULT 'monthly',
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_envelope_bills_envelope ON envelope_bills(envelope_id);

-- Spending category -> envelope (or one of its bills). Unlinked categories never touch envelopes.
CREATE TABLE envelope_category_links (
    category_id TEXT NOT NULL PRIMARY KEY,
    envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
    bill_id TEXT REFERENCES envelope_bills(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_envelope_category_links_envelope ON envelope_category_links(envelope_id);

-- Ledger: funding, moves (two rows sharing move_id), adjustments.
CREATE TABLE envelope_entries (
    id TEXT NOT NULL PRIMARY KEY,
    envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
    bill_id TEXT REFERENCES envelope_bills(id) ON DELETE SET NULL,
    entry_date TEXT NOT NULL,
    amount TEXT NOT NULL,
    kind TEXT NOT NULL,
    note TEXT,
    move_id TEXT,
    rule_id TEXT,
    period_key TEXT,
    activity_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_envelope_entries_envelope_date ON envelope_entries(envelope_id, entry_date);
CREATE UNIQUE INDEX idx_envelope_entries_rule_period
    ON envelope_entries(rule_id, period_key, envelope_id, bill_id) WHERE rule_id IS NOT NULL;

-- Funding rules: biweekly from anchor, monthly on a day, or proposed when an income deposit lands.
CREATE TABLE envelope_funding_rules (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    cadence TEXT NOT NULL,
    anchor_date TEXT,
    day_of_month INTEGER,
    income_category_id TEXT,
    splits_json TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
