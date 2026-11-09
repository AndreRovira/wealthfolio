// Mirrors crates/spending/src/envelopes/model.rs

export interface Envelope {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  allowNegative: boolean;
  /** YYYY-MM-DD: spend in linked categories counts from this day on. */
  startDate: string;
  archived: boolean;
}

export interface EnvelopeInput {
  name: string;
  color?: string | null;
  icon?: string | null;
  sortOrder?: number;
  allowNegative?: boolean;
  startDate?: string;
  archived?: boolean;
}

export interface EnvelopeBill {
  id: string;
  envelopeId: string;
  name: string;
  expectedAmount: number;
  dueDay: number | null;
  cycle: string;
  sortOrder: number;
  archived: boolean;
  /** YYYY-MM-DD; a registered payment moves it one cycle. */
  nextDue: string | null;
}

export interface EnvelopeBillInput {
  envelopeId: string;
  name: string;
  expectedAmount?: number;
  dueDay?: number | null;
  cycle?: string;
  sortOrder?: number;
  archived?: boolean;
  nextDue?: string | null;
}

export interface EnvelopeCategoryLink {
  categoryId: string;
  envelopeId: string;
  billId: string | null;
}

export type EnvelopeEntryKind = "funding" | "move" | "adjustment";

export interface EnvelopeEntry {
  id: string;
  envelopeId: string;
  billId: string | null;
  entryDate: string;
  amount: number;
  kind: EnvelopeEntryKind;
  note: string | null;
  moveId: string | null;
  ruleId: string | null;
  periodKey: string | null;
  activityId: string | null;
}

export interface EntryInput {
  envelopeId: string;
  billId?: string | null;
  entryDate: string;
  amount: number;
  kind: Exclude<EnvelopeEntryKind, "move">;
  note?: string | null;
}

export interface MoveInput {
  entryDate: string;
  amount: number;
  fromEnvelopeId: string;
  fromBillId?: string | null;
  toEnvelopeId: string;
  toBillId?: string | null;
  note?: string | null;
}

export type FundingCadence = "biweekly" | "semimonthly" | "monthly" | "on_income";

export interface FundingSplit {
  envelopeId: string;
  billId?: string | null;
  amount?: number | null;
  percent?: number | null;
}

export interface FundingRule {
  id: string;
  name: string;
  cadence: FundingCadence;
  anchorDate: string | null;
  dayOfMonth: number | null;
  incomeCategoryId: string | null;
  splits: FundingSplit[];
  active: boolean;
}

export interface FundingRuleInput {
  name: string;
  cadence: FundingCadence;
  anchorDate?: string | null;
  dayOfMonth?: number | null;
  incomeCategoryId?: string | null;
  splits: FundingSplit[];
  active?: boolean;
}

export type BillState = "funding" | "ready" | "overdue" | "underfunded";

export interface BillBalance {
  bill: EnvelopeBill;
  funded: number;
  spent: number;
  balance: number;
  linkedCategoryIds: string[];
  state: BillState;
  /** Days to next due; negative when past; null without a date. */
  daysLeft: number | null;
  lastPayment: string | null;
}

export interface EnvelopeBalance {
  envelope: Envelope;
  funded: number;
  spent: number;
  balance: number;
  fundedThisMonth: number;
  spentThisMonth: number;
  linkedCategoryIds: string[];
  bills: BillBalance[];
}

export interface ProposedSplit {
  envelopeId: string;
  billId: string | null;
  amount: number;
}

export interface PendingIncome {
  activityId: string;
  date: string;
  amount: number;
  categoryId: string;
  ruleId: string;
  ruleName: string;
  proposed: ProposedSplit[];
}

export interface EnvelopeSnapshot {
  asOf: string;
  currency: string;
  envelopes: EnvelopeBalance[];
  rules: FundingRule[];
  pendingIncome: PendingIncome[];
  totalBalance: number;
}

export interface ApplyIncomeInput {
  ruleId: string;
  activityId: string;
  entryDate: string;
  splits: ProposedSplit[];
}

/** Pin stored in activity metadata under `envelope`; envelopeId null = no pot. */
export interface ActivityEnvelope {
  envelopeId: string | null;
  billId: string | null;
}
