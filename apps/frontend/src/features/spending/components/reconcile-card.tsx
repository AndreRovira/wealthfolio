import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { Icons, PrivacyAmount, Skeleton } from "@wealthfolio/ui";

import { DashboardCard } from "@/components/dashboard-card";
import { cn } from "@/lib/utils";

import { getIncomePlan } from "../adapters/income-plan";
import { useReconcile } from "../hooks/use-reconcile";

/** Dashboard tile: is every peso accounted for, and what is free to spend. */
export function ReconcileCard() {
  const { t } = useTranslation();
  const { data } = useReconcile();
  const plan = useQuery({ queryKey: ["spending_income_plan"], queryFn: getIncomePlan });
  const tolerance = plan.data?.reconcile?.tolerance ?? 1;
  const manage = (
    <Link
      to="/spending/budget?tab=reconcile"
      className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
    >
      {t("spending:budgetChart.manage")}
    </Link>
  );
  if (!data) {
    return (
      <DashboardCard title={t("spending:reconcile.title")} action={manage}>
        <Skeleton className="h-16 w-full" />
      </DashboardCard>
    );
  }
  const ok = Math.abs(data.difference) <= tolerance;
  return (
    <DashboardCard title={t("spending:reconcile.title")} action={manage}>
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <div className="text-muted-foreground text-2xs uppercase tracking-wide">
            {t("spending:reconcile.difference")}
          </div>
          <div className={cn("flex items-center gap-1 text-sm font-semibold tabular-nums", ok ? "text-success" : "text-destructive")}>
            {ok ? <Icons.Check className="h-3.5 w-3.5" /> : <Icons.AlertTriangle className="h-3.5 w-3.5" />}
            <PrivacyAmount value={data.difference} currency={data.currency} />
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-2xs uppercase tracking-wide">{t("spending:reconcile.float")}</div>
          <div className="text-sm font-semibold tabular-nums">
            <PrivacyAmount value={data.float} currency={data.currency} />
          </div>
        </div>
        <div>
          <div className="text-muted-foreground text-2xs uppercase tracking-wide">{t("spending:reconcile.float30")}</div>
          <div className={cn("text-sm font-semibold tabular-nums", data.float30 < 0 && "text-destructive")}>
            <PrivacyAmount value={data.float30} currency={data.currency} />
          </div>
        </div>
      </div>
    </DashboardCard>
  );
}
