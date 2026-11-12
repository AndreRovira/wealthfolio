import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { PrivacyAmount, useNumberFormatting } from "@wealthfolio/ui";

import { updateAccount } from "@/adapters";
import { profileFetch } from "@/features/profiles/session";
import { useAccounts } from "@/hooks/use-accounts";
import { QueryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

import { AmountInput } from "./amount-input";
import { LoadFailed } from "./load-failed";

const CARD = "bg-card border-border/60 rounded-xl border shadow-sm";

interface SavingsRow {
  accountId: string;
  accountName: string;
  accountType: string;
  plannedMonthly: number;
  actualMonth: number;
  actualYtd: number;
}

interface SavingsSnapshot {
  periodKey: string;
  currency: string;
  rows: SavingsRow[];
  plannedMonthlyTotal: number;
  actualMonthTotal: number;
  actualYtdTotal: number;
  incomeMonth: number;
  incomeYtd: number;
}

async function getSavings(periodKey?: string): Promise<SavingsSnapshot> {
  const res = await profileFetch(
    `/api/v1/spending/savings${periodKey ? `?periodKey=${periodKey}` : ""}`,
    { credentials: "same-origin" },
  );
  if (!res.ok) throw new Error(res.statusText);
  return (await res.json()) as SavingsSnapshot;
}

/** Planned vs actual transfers into every non-spending account. */
export function SavingsPlanCard({ periodKey }: { periodKey?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const numberFormatting = useNumberFormatting();
  const snapshot = useQuery({
    queryKey: ["spending_savings", periodKey ?? null],
    queryFn: () => getSavings(periodKey),
  });
  const { accounts } = useAccounts({ filterActive: false, includeArchived: false });
  const [showAll, setShowAll] = useState(false);

  const savePlan = useMutation({
    mutationFn: async ({ accountId, amount }: { accountId: string; amount: number }) => {
      const account = accounts.find((a) => a.id === accountId);
      if (!account) throw new Error("account not found");
      let meta: Record<string, unknown> = {};
      try {
        meta = account.meta ? (JSON.parse(account.meta) as Record<string, unknown>) : {};
      } catch {
        meta = {};
      }
      meta.savingsPlanMonthly = amount;
      return updateAccount({
        id: account.id,
        name: account.name,
        group: account.group ?? undefined,
        accountNumber: account.accountNumber ?? undefined,
        isDefault: account.isDefault,
        isActive: account.isActive,
        isArchived: account.isArchived,
        accountType: account.accountType,
        currency: account.currency,
        trackingMode: account.trackingMode,
        meta: JSON.stringify(meta),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["spending_savings"] });
      void qc.invalidateQueries({ queryKey: [QueryKeys.ACCOUNTS] });
    },
    onError: () => toast.error(t("spending:savingsPlan.saveFailed")),
  });

  const data = snapshot.data;
  if (snapshot.isError) return <LoadFailed onRetry={() => void snapshot.refetch()} />;
  if (!data) return null;
  const currency = data.currency;
  const rate = (saved: number, income: number) => (income > 0 ? saved / income : 0);
  // Accounts without plan or flows are hidden by the API; "show all" lists the
  // rest so a plan can be set on them.
  const shownIds = new Set(data.rows.map((r) => r.accountId));
  const extra = showAll
    ? accounts.filter((a) => a.isActive && !shownIds.has(a.id) && a.accountType !== "CREDIT_CARD")
    : [];

  const cell = (v: number, strong?: boolean) => (
    <span className={cn("w-20 shrink-0 text-end tabular-nums sm:w-24", strong && "font-semibold")}>
      <PrivacyAmount value={v} currency={currency} />
    </span>
  );

  return (
    <section className={cn(CARD, "overflow-hidden")}>
      <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-semibold">
            {t("spending:savingsPlan.title")}
          </div>
          <div className="text-muted-foreground text-2xs">
            {t("spending:savingsPlan.rateMonth")}{" "}
            {numberFormatting.formatPercent(rate(data.actualMonthTotal, data.incomeMonth), {
              digits: 0,
            })}
            {" · "}
            {t("spending:savingsPlan.rateYtd")}{" "}
            {numberFormatting.formatPercent(rate(data.actualYtdTotal, data.incomeYtd), {
              digits: 0,
            })}
          </div>
        </div>
        <span className="text-muted-foreground text-2xs w-20 text-end uppercase sm:w-24">
          {t("spending:savingsPlan.planned")}
        </span>
        <span className="text-muted-foreground text-2xs w-20 text-end uppercase sm:w-24">
          {t("spending:savingsPlan.month")}
        </span>
        <span className="text-muted-foreground text-2xs hidden w-24 text-end uppercase sm:inline">
          {t("spending:savingsPlan.ytd")}
        </span>
      </div>
      <div className="border-border/60 divide-border/40 divide-y border-t text-xs">
        {[
          ...data.rows,
          ...extra.map((a) => ({
            accountId: a.id,
            accountName: a.name,
            accountType: a.accountType,
            plannedMonthly: 0,
            actualMonth: 0,
            actualYtd: 0,
          })),
        ].map((r) => (
          <div
            key={r.accountId}
            className="hover:bg-muted/15 flex items-center gap-2 px-3 py-1.5 sm:px-4"
          >
            <span className="text-foreground min-w-0 flex-1 truncate">{r.accountName}</span>
            <div className="w-20 shrink-0 sm:w-24">
              <AmountInput
                value={r.plannedMonthly}
                onCommit={(v) =>
                  savePlan.mutate({ accountId: r.accountId, amount: Number(v) || 0 })
                }
              />
            </div>
            {cell(r.actualMonth)}
            <span className="hidden sm:inline">{cell(r.actualYtd)}</span>
          </div>
        ))}
        <div className="flex items-center gap-2 px-3 py-1.5 sm:px-4">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground text-2xs min-w-0 flex-1 truncate text-start underline-offset-2 hover:underline"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? t("spending:savingsPlan.hideOthers") : t("spending:savingsPlan.showOthers")}
          </button>
          {cell(data.plannedMonthlyTotal, true)}
          {cell(data.actualMonthTotal, true)}
          <span className="hidden sm:inline">{cell(data.actualYtdTotal, true)}</span>
        </div>
      </div>
    </section>
  );
}
