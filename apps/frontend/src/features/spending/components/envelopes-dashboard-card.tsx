import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Icons, PrivacyAmount, Skeleton } from "@wealthfolio/ui";

import { DashboardCard } from "@/components/dashboard-card";
import { cn } from "@/lib/utils";

import { useEnvelopeSnapshot } from "../hooks/use-envelopes";
import { SPENDING_THEME, tint } from "../lib/theme";

/** Last calendar day of a YYYY-MM key, as YYYY-MM-DD. */
function monthEnd(monthKey: string) {
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthKey}-${String(last).padStart(2, "0")}`;
}

/** Envelope balances and the bills coming due, in place of the monthly budget. */
export function EnvelopesDashboardCard({
  monthKey,
  isCurrentMonth,
}: {
  monthKey: string;
  isCurrentMonth: boolean;
}) {
  const { t } = useTranslation();
  // A past month shows balances as they stood at its end.
  const snapshot = useEnvelopeSnapshot(isCurrentMonth ? undefined : monthEnd(monthKey));
  const data = snapshot.data;
  const manage = (
    <Link
      to="/spending/envelopes"
      className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
    >
      {t("spending:budgetChart.manage")}
    </Link>
  );

  if (!data) {
    return (
      <DashboardCard title={t("spending:envelopes.heading")} action={manage}>
        <Skeleton className="h-24 w-full" />
      </DashboardCard>
    );
  }

  const currency = data.currency;
  const dueSoon = data.envelopes
    .flatMap((e) =>
      e.bills.map((b) => ({
        key: `${e.envelope.id}:${b.bill.id}`,
        name: b.bill.name,
        balance: b.balance,
        state: b.state,
        daysLeft: b.daysLeft,
      })),
    )
    .filter((b) => b.state === "overdue" || b.state === "underfunded" || (b.daysLeft !== null && b.daysLeft <= 14))
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));

  return (
    <DashboardCard title={t("spending:envelopes.heading")} action={manage} padded={false}>
      <div className="divide-border/40 divide-y">
        {data.pendingIncome.length > 0 && (
          <Link
            to="/spending/envelopes"
            className="bg-warning-subtle/40 hover:bg-warning-subtle/60 flex items-center gap-2 px-4 py-2 text-xs"
          >
            <Icons.Sparkles className="text-warning h-3.5 w-3.5" />
            {t("spending:envelopes.pendingIncomeCount", { count: data.pendingIncome.length })}
          </Link>
        )}
        <div className="space-y-2 px-4 py-3">
          {data.envelopes.map((e) => {
            const accent = e.envelope.color ?? SPENDING_THEME.deep;
            const negative = e.balance < 0;
            const target = e.periodTarget;
            // Same thresholds as the envelopes page.
            const range =
              target <= 0 ? null : negative ? "short" : e.balance > target * 1.5 ? "surplus" : null;
            return (
              <div key={e.envelope.id} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-foreground truncate">{e.envelope.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {range && (
                      <span
                        className={cn(
                          "rounded px-1 py-px text-2xs",
                          range === "short" ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning",
                        )}
                      >
                        {t(`spending:envelopes.${range}`)}
                      </span>
                    )}
                    <span className={cn("tabular-nums", negative ? "text-destructive" : "text-foreground")}>
                      <PrivacyAmount value={e.balance} currency={currency} />
                    </span>
                  </span>
                </div>
                {target > 0 && (
                  <div className="bg-muted/40 mt-1 h-1.5 overflow-hidden rounded-full">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (e.spentThisPeriod / target) * 100)}%`,
                        backgroundColor: e.spentThisPeriod > target ? "var(--destructive)" : accent,
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })}
          <div className="text-muted-foreground flex items-center justify-between pt-1 text-2xs uppercase tracking-wide">
            <span>{t("spending:envelopes.totalBalance")}</span>
            <span className="text-foreground tabular-nums normal-case">
              <PrivacyAmount value={data.totalBalance} currency={currency} />
            </span>
          </div>
        </div>
        {dueSoon.length > 0 && (
          <div className="px-4 py-3">
            <div className="text-muted-foreground mb-1.5 text-2xs uppercase tracking-wide">
              {t("spending:envelopes.dueSoon")}
            </div>
            <div className="space-y-1">
              {dueSoon.slice(0, 6).map((b) => (
                <div key={b.key} className="flex items-center gap-2 text-xs">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor:
                        b.state === "ready"
                          ? "var(--success)"
                          : b.state === "overdue"
                            ? "var(--destructive)"
                            : "var(--warning)",
                      boxShadow:
                        b.state === "ready" ? `0 0 6px ${tint("var(--success)", 0.8)}` : undefined,
                    }}
                  />
                  <span className="text-foreground min-w-0 flex-1 truncate">{b.name}</span>
                  <span className="text-muted-foreground shrink-0">
                    {b.state === "overdue"
                      ? t("spending:envelopes.overdue")
                      : b.state === "underfunded"
                        ? t("spending:envelopes.underfunded")
                        : (b.daysLeft ?? 0) === 0
                          ? t("spending:envelopes.dueToday")
                          : t("spending:envelopes.dueIn", { count: b.daysLeft ?? 0 })}
                  </span>
                  <span className={cn("w-20 shrink-0 text-end tabular-nums", b.state === "ready" ? "text-success" : "text-foreground")}>
                    <PrivacyAmount value={b.balance} currency={currency} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </DashboardCard>
  );
}
