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
  if (fees.feePercent > 0) parsed.tradeFees = fees;
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
 * It stops at the first value entered by hand: the fields then no longer hold
 * what was filled in.
 */
export function useAutoTradeFees(
  form: FeeForm,
  { meta, gross, enabled }: { meta?: string | null; gross: number; enabled: boolean },
) {
  const rates = useMemo(() => tradeFeesFromMeta(meta), [meta]);
  const filled = useRef({ fee: 0, tax: 0 });
  useEffect(() => {
    if (!enabled || rates.feePercent <= 0) return;
    const fee = Number(form.getValues("fee")) || 0;
    const tax = Number(form.getValues("tax")) || 0;
    if (fee !== filled.current.fee || tax !== filled.current.tax) return;
    const next = tradeFees(gross, rates);
    filled.current = next;
    if (next.fee !== fee) form.setValue("fee", next.fee, { shouldDirty: true });
    if (next.tax !== tax) form.setValue("tax", next.tax, { shouldDirty: true });
  }, [enabled, rates, gross, form]);
}
