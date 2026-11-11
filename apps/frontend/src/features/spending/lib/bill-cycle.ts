import { round2 } from "./plan-eval";

/** Months in a bill's cycle label: "monthly", "yearly" or "N months". */
export function cycleMonths(cycle: string): number {
  const c = cycle.trim();
  if (c === "monthly") return 1;
  if (c === "yearly") return 12;
  const n = Number(c.split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * A bill's cost spread over its cycle. The quincena share is the canonical
 * figure (what a paycheck sets aside); monthly and annual follow from it.
 */
export function billShares(expectedAmount: number, cycle: string) {
  const quincena = round2(expectedAmount / (cycleMonths(cycle) * 2));
  return { quincena, monthly: round2(quincena * 2), annual: round2(quincena * 24) };
}
