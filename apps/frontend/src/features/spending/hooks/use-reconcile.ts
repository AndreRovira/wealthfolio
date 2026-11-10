import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { getLatestValuations } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useAlternativeHoldings } from "@/hooks/use-alternative-assets";
import type { Account } from "@/lib/types";

import { useEnvelopeSnapshot } from "./use-envelopes";
import { useSpendingSettings } from "./use-spending-settings";

const round2 = (v: number) => Math.round(v * 100) / 100;

function meta(account: Account): Record<string, unknown> {
  try {
    return account.meta ? (JSON.parse(account.meta) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface ReconcileRow {
  account: Account;
  balance: number;
  excluded: boolean;
}

export interface Reconcile {
  currency: string;
  liquidity: number;
  cardDebt: number;
  msiRemaining: number;
  envelopes: number;
  /** liquidity − card debt − MSI remaining − envelopes; zero when every peso is accounted for. */
  difference: number;
  /** Excel float: liquidity − tax envelope − card debt. */
  float: number;
  /** Float after bills and MSI instalments due in the next 30 days. */
  float30: number;
  billsDue30: number;
  msiDue30: number;
  cash: ReconcileRow[];
  cards: ReconcileRow[];
}

/**
 * The spreadsheet's RECONCILIATION line, from live data. Cash accounts tracked
 * for spending are liquidity unless flagged `liquidity: false` or
 * `envelopesExcluded`; card balances owed are the payables; liabilities in
 * Holdings are the MSI remaining.
 */
export function useReconcile() {
  const { settings } = useSpendingSettings();
  const { accounts } = useAccounts({ filterActive: false });
  const snapshot = useEnvelopeSnapshot();
  const holdings = useAlternativeHoldings();
  const ids = useMemo(() => settings?.accountIds ?? [], [settings?.accountIds]);
  const valuations = useQuery({
    queryKey: ["spending_reconcile_valuations", ids],
    queryFn: () => getLatestValuations(ids),
    enabled: ids.length > 0,
  });

  const data = useMemo<Reconcile | null>(() => {
    if (!snapshot.data || !valuations.data || !accounts || !holdings.data) return null;
    const byAccount = new Map(valuations.data.map((v) => [v.accountId, v]));
    const tracked = accounts.filter((a) => ids.includes(a.id) && a.isActive);
    const cash: ReconcileRow[] = [];
    const cards: ReconcileRow[] = [];
    for (const account of tracked) {
      const v = byAccount.get(account.id);
      const balance = v ? Number(v.cashBalanceBase) : 0;
      const m = meta(account);
      if (account.accountType === "CREDIT_CARD") {
        cards.push({ account, balance: round2(-balance), excluded: false });
      } else {
        cash.push({
          account,
          balance: round2(balance),
          excluded: m.liquidity === false || m.envelopesExcluded === true,
        });
      }
    }
    const sum = (rows: ReconcileRow[]) =>
      round2(rows.filter((r) => !r.excluded).reduce((s, r) => s + r.balance, 0));
    const liquidity = sum(cash);
    const cardDebt = sum(cards);
    const loans = holdings.data.filter((h) => h.kind === "liability");
    const msiRemaining = round2(loans.reduce((s, h) => s + Math.max(0, Number(h.marketValue)), 0));
    const msiDue30 = round2(
      loans.reduce((s, h) => {
        const remaining = Math.max(0, Number(h.marketValue));
        const payment = h.loan?.paymentAmount ?? 0;
        return s + Math.min(remaining, payment);
      }, 0),
    );
    const envelopes = round2(snapshot.data.totalBalance);
    const tax = snapshot.data.envelopes.find((e) => e.envelope.name.toLowerCase() === "tax")?.balance ?? 0;
    const billsDue30 = round2(
      snapshot.data.envelopes
        .flatMap((e) => e.bills)
        .filter((b) => b.daysLeft !== null && b.daysLeft <= 30)
        .reduce((s, b) => s + b.bill.expectedAmount, 0),
    );
    const float = round2(liquidity - tax - cardDebt);
    return {
      currency: snapshot.data.currency,
      liquidity,
      cardDebt,
      msiRemaining,
      envelopes,
      difference: round2(liquidity - cardDebt - msiRemaining - envelopes),
      float,
      float30: round2(float - billsDue30 - msiDue30),
      billsDue30,
      msiDue30,
      cash,
      cards,
    };
  }, [snapshot.data, valuations.data, accounts, holdings.data, ids]);

  return { data, isLoading: !data && (snapshot.isLoading || valuations.isLoading || holdings.isLoading) };
}
