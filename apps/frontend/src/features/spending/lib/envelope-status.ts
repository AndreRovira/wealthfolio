/** When a bill is next due and whether its pot already covers it. */
export interface BillDue {
  /** Days until the next due day, null when the bill has no due day. */
  daysLeft: number | null;
  /** Pot covers the cost. */
  ready: boolean;
  /** Due day passed this month and the pot does not cover it. */
  overdue: boolean;
}

export function billDueState(
  dueDay: number | null,
  balance: number,
  cost: number,
  asOf: string,
): BillDue {
  const ready = cost > 0 && balance + 0.005 >= cost;
  if (dueDay == null) return { daysLeft: null, ready, overdue: false };
  const [y, m, d] = asOf.split("-").map(Number);
  const today = Date.UTC(y, m - 1, d);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let due = Date.UTC(y, m - 1, Math.min(dueDay, lastDay));
  // Already past this month: the pot was either paid (and refilled by the
  // next funding) or it is late. Flag late until the day flips to next month.
  let overdue = false;
  if (due < today) {
    overdue = !ready;
    const nextLast = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    due = Date.UTC(y, m, Math.min(dueDay, nextLast));
  }
  const daysLeft = Math.round((due - today) / 86_400_000);
  return { daysLeft, ready, overdue };
}
