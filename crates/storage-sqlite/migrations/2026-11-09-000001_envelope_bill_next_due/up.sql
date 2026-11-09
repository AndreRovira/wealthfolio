-- A bill keeps its next due date; registering a payment advances it one cycle.
ALTER TABLE envelope_bills ADD COLUMN next_due TEXT;
