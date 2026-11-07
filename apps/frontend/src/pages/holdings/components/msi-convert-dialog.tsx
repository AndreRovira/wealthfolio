import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  PrivacyAmount,
  ResponsiveSelect,
} from "@wealthfolio/ui";

import { profileFetch } from "@/features/profiles/session";
import { notifyUnauthorized } from "@/lib/auth-token";

// Fork feature served only by the web host: talks to /api/v1 directly.
interface Candidate {
  activityId: string;
  accountId: string;
  accountName: string;
  date: string;
  amount: number;
  currency: string;
  notes: string | null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await profileFetch(`/api/v1/spending/msi${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 401) notifyUnauthorized();
  if (!res.ok) {
    let message = res.statusText;
    try {
      const err = (await res.json()) as { message?: string };
      if (typeof err.message === "string") message = err.message;
    } catch {
      // non-JSON body
    }
    throw new Error(message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function nextMonthSameDay(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export function MsiConvertDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const candidates = useQuery({
    queryKey: ["msi", "candidates"],
    queryFn: () => request<Candidate[]>("GET", "/candidates?days=120"),
    enabled: open,
  });
  const [activityId, setActivityId] = useState("");
  const [months, setMonths] = useState("6");
  const [firstDue, setFirstDue] = useState("");
  const [name, setName] = useState("");
  const chosen = candidates.data?.find((c) => c.activityId === activityId);

  const convert = useMutation({
    mutationFn: () =>
      request("POST", "/convert", {
        activityId,
        months: Number(months),
        firstDue,
        name: name || null,
      }),
    onSuccess: () => {
      toast.success(t("holdings:msi.converted"));
      void qc.invalidateQueries();
      setActivityId("");
      setName("");
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const pick = (id: string) => {
    setActivityId(id);
    const c = candidates.data?.find((x) => x.activityId === id);
    if (c) {
      setFirstDue(nextMonthSameDay(c.date));
      setName(c.notes ?? "");
    }
  };

  const monthly = chosen ? chosen.amount / Math.max(1, Number(months) || 1) : 0;
  const ready = !!chosen && Number(months) >= 1 && !!firstDue && !convert.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("holdings:msi.title")}</DialogTitle>
          <DialogDescription>{t("holdings:msi.description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t("holdings:msi.charge")}</Label>
            <ResponsiveSelect
              value={activityId}
              onValueChange={pick}
              placeholder={
                candidates.isLoading ? t("common:loading") : t("holdings:msi.pickCharge")
              }
              options={(candidates.data ?? []).map((c) => ({
                value: c.activityId,
                label: `${c.date} · ${c.accountName} · ${c.notes ?? ""} · ${c.amount.toFixed(2)} ${c.currency}`,
              }))}
            />
            {candidates.data?.length === 0 && (
              <p className="text-muted-foreground text-xs">{t("holdings:msi.noCharges")}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("holdings:msi.months")}</Label>
              <Input
                type="number"
                min={1}
                max={60}
                value={months}
                onChange={(e) => setMonths(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("holdings:msi.firstDue")}</Label>
              <Input type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("holdings:msi.name")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {chosen && (
            <p className="text-muted-foreground text-xs">
              {t("holdings:msi.preview", { months })}{" "}
              <PrivacyAmount value={monthly} currency={chosen.currency} />
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => convert.mutate()} disabled={!ready}>
            {t("holdings:msi.convert")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
