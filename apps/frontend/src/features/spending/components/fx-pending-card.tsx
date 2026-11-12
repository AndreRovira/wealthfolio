import { formatDateISO } from "@/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { searchActivities, updateActivity } from "@/adapters";
import type { ActivityDetails } from "@/lib/types";
import { Button, Input, PrivacyAmount } from "@wealthfolio/ui";

import { cn } from "@/lib/utils";

import { useSpendingSettings } from "../hooks/use-spending-settings";
import { invalidateSpendingCaches } from "../lib/invalidation";

const CARD = "bg-card border-border/60 rounded-xl border shadow-sm";
export const FX_PENDING_KEY = "spending_fx_pending";

/** Charges flagged provisional: the bank restates foreign-currency amounts days later. */
export function useFxPending() {
  const { settings } = useSpendingSettings();
  const ids = settings?.accountIds ?? [];
  return useQuery({
    queryKey: [FX_PENDING_KEY, ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      // ponytail: one page of 500 recent rows, filtered client-side; a metadata filter server-side if it ever overflows.
      const res = await searchActivities(0, 500, { accountIds: ids }, "", { id: "date", desc: true });
      return res.data.filter((a) => a.metadata?.fxPending === true);
    },
  });
}

function SettleRow({ a, currency }: { a: ActivityDetails; currency: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(String(a.amount ?? ""));
  const days = Math.floor((Date.now() - new Date(a.date).getTime()) / 86_400_000);
  const settle = useMutation({
    mutationFn: () =>
      // Omitted scalars are blanked by the update, so restate what a cash row carries.
      updateActivity({
        id: a.id,
        accountId: a.accountId,
        activityType: a.activityType,
        subtype: a.subtype ?? null,
        activityDate: new Date(a.date).toISOString(),
        amount: Number(amount),
        currency: a.currency,
        fxRate: a.fxRate != null ? Number(a.fxRate) : undefined,
        comment: a.comment ?? null,
        metadata: { ...(a.metadata ?? {}), fxPending: false },
      }),
    onSuccess: () => {
      invalidateSpendingCaches(qc);
      void qc.invalidateQueries({ queryKey: [FX_PENDING_KEY] });
      toast.success(t("spending:fxPending.settled"));
    },
    onError: () => toast.error(t("spending:fxPending.failed")),
  });
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-foreground truncate">{a.comment || a.activityType}</div>
        <div className="text-muted-foreground text-2xs">
          {a.accountName} · {formatDateISO(new Date(a.date))} ·{" "}
          {t("spending:fxPending.daysAgo", { count: days })}
        </div>
      </div>
      <span className="text-muted-foreground w-20 shrink-0 text-end tabular-nums">
        <PrivacyAmount value={Number(a.amount ?? 0)} currency={currency} />
      </span>
      <Input
        type="number"
        step="0.01"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="h-7 w-28 text-end text-xs tabular-nums"
        aria-label={t("spending:fxPending.finalAmount")}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        onClick={() => settle.mutate()}
        disabled={settle.isPending || !(Number(amount) > 0)}
      >
        {t("spending:fxPending.settle")}
      </Button>
    </div>
  );
}

export function FxPendingCard({ currency }: { currency: string }) {
  const { t } = useTranslation();
  const pending = useFxPending();
  const rows = pending.data ?? [];
  return (
    <section className={cn(CARD, "space-y-2 p-4")}>
      <div className="flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">{t("spending:fxPending.title")}</h3>
        <span className={cn("text-xs", rows.length ? "text-warning" : "text-muted-foreground")}>
          {t("spending:fxPending.count", { count: rows.length })}
        </span>
      </div>
      <p className="text-muted-foreground text-2xs">{t("spending:fxPending.hint")}</p>
      {rows.map((a) => (
        <SettleRow key={a.id} a={a} currency={currency} />
      ))}
    </section>
  );
}
