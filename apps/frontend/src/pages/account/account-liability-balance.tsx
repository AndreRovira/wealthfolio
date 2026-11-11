import { useMemo } from "react";
import { format } from "date-fns";
import { useTranslation } from "react-i18next";
import type { DateRange } from "react-day-picker";

import { HistoryChart, type HistoryChartData } from "@/components/history-chart";
import { useNetWorthHistory } from "@/hooks/use-alternative-assets";
import type { TimePeriod } from "@/lib/types";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  IntervalSelector,
  PrivacyAmount,
  Skeleton,
} from "@wealthfolio/ui";

/** Net worth keys a credit card's owed balance by this prefix plus the account id. */
const CREDIT_CARD_KEY_PREFIX = "CREDIT_CARD:";

/**
 * Balance owed and its history for a card or other liability account. These
 * accounts get no daily valuations, so the series comes from the net worth
 * history, which tracks what each card owes day by day.
 */
export function AccountLiabilityBalance({
  accountId,
  dateRange,
  today,
  defaultInterval,
  onIntervalSelect,
}: {
  accountId: string;
  dateRange: DateRange | undefined;
  today: Date;
  defaultInterval: TimePeriod;
  onIntervalSelect: (code: TimePeriod) => void;
}) {
  const { t } = useTranslation();
  const endDate = format(dateRange?.to ?? today, "yyyy-MM-dd");
  // "All" has no start; cards rarely go back further than a few years.
  const startDate = dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : "2000-01-01";
  const { data, isLoading } = useNetWorthHistory({ startDate, endDate });

  const chartData = useMemo<HistoryChartData[]>(() => {
    const key = `${CREDIT_CARD_KEY_PREFIX}${accountId}`;
    const points = (data ?? []).map((p) => ({
      date: p.date,
      totalValue: Number(p.breakdown?.[key] ?? 0),
      netContribution: 0,
      currency: p.currency,
    }));
    // Leading days before the card's first movement would flatten the chart.
    const first = points.findIndex((p) => p.totalValue !== 0);
    return first > 0 ? points.slice(first) : points;
  }, [accountId, data]);
  const latest = chartData[chartData.length - 1];

  return (
    <Card className="mb-4 overflow-hidden">
      <CardHeader className="pb-0">
        <CardTitle className="text-md">
          <span className="text-muted-foreground text-xs font-normal">
            {t("account:balance_owed")}
          </span>
          <p className="text-xl font-bold">
            {isLoading || !latest ? (
              <Skeleton className="h-8 w-36" />
            ) : (
              <PrivacyAmount value={latest.totalValue} currency={latest.currency} />
            )}
          </p>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="h-72 w-full">
          <HistoryChart
            data={chartData}
            isLoading={isLoading}
            color="var(--destructive)"
            hideNetContribution
          />
          <IntervalSelector
            className="relative start-0 end-0 bottom-10 z-10"
            onIntervalSelect={onIntervalSelect}
            isLoading={isLoading}
            defaultValue={defaultInterval}
          />
        </div>
      </CardContent>
    </Card>
  );
}
