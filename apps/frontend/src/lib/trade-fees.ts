import { useEffect, useMemo, useRef } from "react";

/** Fork: what a broker charges on a trade, kept in the account meta as percentages. */
export interface TradeFees {
  /** Commission, percent of the traded value. */
  feePercent: number;
  /** Tax on that commission (IVA), percent of the fee. */
  taxPercent: number;
}

const positive = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function tradeFeesFromMeta(meta?: string | null): TradeFees {
  let raw: Partial<TradeFees> | undefined;
  try {
    raw = meta ? (JSON.parse(meta) as { tradeFees?: Partial<TradeFees> })?.tradeFees : undefined;
  } catch {
    raw = undefined;
  }
  return { feePercent: positive(raw?.feePercent), taxPercent: positive(raw?.taxPercent) };
}

export function setTradeFeesInMeta(meta: string | null | undefined, fees: TradeFees): string {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = meta ? JSON.parse(meta) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  // Kept while either is set: the fee passes through 0 while it is retyped,
  // and that must not drop the tax beside it.
  if (fees.feePercent > 0 || fees.taxPercent > 0) parsed.tradeFees = fees;
  else delete parsed.tradeFees;
  return JSON.stringify(parsed);
}

// ponytail: two decimals for every currency; use the currency's minor unit if
// a zero-decimal one ever gets a commission percentage.
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** The fee on a traded value, and the tax on that fee. */
export function tradeFees(gross: number, rates: TradeFees) {
  const fee = round2((positive(gross) * rates.feePercent) / 100);
  return { fee, tax: round2((fee * rates.taxPercent) / 100) };
}

interface FeeForm {
  getValues: (name: any) => unknown;
  setValue: (name: any, value: any, options?: any) => void;
}

/**
 * Fills fee and tax from the account's percentages while a new trade is typed.
 * Each field is followed on its own and only while it still holds what was
 * filled in: a value entered by hand stays. An account without percentages
 * fills zeros, which clears what the previous account had filled.
 */
export function useAutoTradeFees(
  form: FeeForm,
  { meta, gross, enabled }: { meta?: string | null; gross: number; enabled: boolean },
) {
  const rates = useMemo(() => tradeFeesFromMeta(meta), [meta]);
  const filled = useRef<{ fee: number; tax: number } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const next = tradeFees(gross, rates);
    const now = {
      fee: Number(form.getValues("fee")) || 0,
      tax: Number(form.getValues("tax")) || 0,
    };
    // The phone form remounts this step on Back and Next while the values stay
    // in the form: values that match the percentages were filled in, not typed.
    filled.current ??= { fee: now.fee === next.fee ? next.fee : 0, tax: now.tax === next.tax ? next.tax : 0 };
    for (const field of ["fee", "tax"] as const) {
      if (now[field] !== filled.current[field]) continue;
      filled.current[field] = next[field];
      if (next[field] !== now[field]) form.setValue(field, next[field], { shouldDirty: true });
    }
  }, [enabled, rates, gross, form]);
}
