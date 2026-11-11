import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { getLatestValuations } from "@/adapters";
import { useAccounts } from "@/hooks/use-accounts";
import { useAlternativeHoldings, useNetWorth } from "@/hooks/use-alternative-assets";
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
  // Credit cards get no account valuation rows; net worth carries their balance
  // as a CREDIT_CARD:<accountId> liability.
  const netWorth = useNetWorth();
  const ids = useMemo(() => settings?.accountIds ?? [], [settings?.accountIds]);
  const valuations = useQuery({
    queryKey: ["spending_reconcile_valuations", ids],
    queryFn: () => getLatestValuations(ids),
    enabled: ids.length > 0,
  });

  const data = useMemo<Reconcile | null>(() => {
    if (!snapshot.data || !valuations.data || !accounts || !holdings.data || !netWorth.data) return null;
    const byAccount = new Map(valuations.data.map((v) => [v.accountId, v]));
    const cardOwed = new Map<string, number>();
    for (const item of netWorth.data.liabilities.breakdown) {
      if (item.assetId?.startsWith("CREDIT_CARD:")) {
        cardOwed.set(item.assetId.slice("CREDIT_CARD:".length), item.value);
      }
    }
    const tracked = accounts.filter((a) => ids.includes(a.id) && a.isActive);
    const cash: ReconcileRow[] = [];
    const cards: ReconcileRow[] = [];
    for (const account of tracked) {
      const v = byAccount.get(account.id);
      const balance = v ? Number(v.cashBalanceBase) : 0;
      const m = meta(account);
      if (account.accountType === "CREDIT_CARD") {
        cards.push({ account, balance: round2(cardOwed.get(account.id) ?? 0), excluded: false });
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
    const envelopes = round2(snapshot.data.totalBalance);
    const tax = snapshot.data.envelopes.find((e) => e.envelope.name.toLowerCase() === "tax")?.balance ?? 0;
    const float = round2(liquidity - tax - cardDebt);
    return {
      currency: snapshot.data.currency,
      liquidity,
      cardDebt,
      msiRemaining,
      envelopes,
      difference: round2(liquidity - cardDebt - msiRemaining - envelopes),
      float,
      cash,
      cards,
    };
  }, [snapshot.data, valuations.data, accounts, holdings.data, netWorth.data, ids]);

  return {
    data,
    isLoading:
      !data && (snapshot.isLoading || valuations.isLoading || holdings.isLoading || netWorth.isLoading),
  };
}
