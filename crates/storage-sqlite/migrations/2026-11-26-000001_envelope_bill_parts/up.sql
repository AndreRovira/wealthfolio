-- A bill the bank charges in parts (an annual fee over three statements)
-- settles on its last part, counting the earlier ones.
ALTER TABLE envelope_bills ADD COLUMN parts INTEGER NOT NULL DEFAULT 1;
