import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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

import { request as send } from "@/features/spending/adapters/request";

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

const request = <T,>(method: string, path: string, body?: unknown) =>
  send<T>(method, `/api/v1/spending/msi${path}`, body);

/** Same day next month; the 31st of a month lands on the last day of a shorter one. */
function nextMonthSameDay(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
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
  // Plain fetches: the holdings page tests mock react-query partially.
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [activityId, setActivityId] = useState("");
  const [months, setMonths] = useState("6");
  const [firstDue, setFirstDue] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCandidates(null);
    request<Candidate[]>("GET", "/candidates?days=120")
      .then(setCandidates)
      .catch((e: Error) => {
        setCandidates([]);
        toast.error(e.message);
      });
  }, [open]);
  const chosen = candidates?.find((c) => c.activityId === activityId);

  const convert = async () => {
    setBusy(true);
    try {
      await request("POST", "/convert", {
        activityId,
        months: Number(months),
        firstDue,
        name: name || null,
      });
      toast.success(t("holdings:msi.converted"));
      setActivityId("");
      setName("");
      onOpenChange(false);
      // The charge became a loan: balances, holdings and envelopes all moved.
      void qc.invalidateQueries();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (id: string) => {
    setActivityId(id);
    const c = candidates?.find((x) => x.activityId === id);
    if (c) {
      setFirstDue(nextMonthSameDay(c.date));
      setName(c.notes ?? "");
    }
  };

  const monthly = chosen ? chosen.amount / Math.max(1, Number(months) || 1) : 0;
  const count = Number(months);
  const ready =
    !!chosen && Number.isInteger(count) && count >= 2 && count <= 60 && !!firstDue && !busy;

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
              sheetTitle={t("holdings:msi.charge")}
              value={activityId}
              onValueChange={pick}
              placeholder={candidates === null ? t("common:loading") : t("holdings:msi.pickCharge")}
              options={(candidates ?? []).map((c) => ({
                value: c.activityId,
                label: [c.date, c.accountName, c.notes, `${c.amount.toFixed(2)} ${c.currency}`]
                  .filter(Boolean)
                  .join(" · "),
              }))}
            />
            {candidates?.length === 0 && (
              <p className="text-muted-foreground text-xs">{t("holdings:msi.noCharges")}</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="msi-months" className="text-xs">
                {t("holdings:msi.months")}
              </Label>
              <Input
                id="msi-months"
                type="number"
                inputMode="numeric"
                min={2}
                max={60}
                step={1}
                value={months}
                onChange={(e) => setMonths(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="msi-first-due" className="text-xs">
                {t("holdings:msi.firstDue")}
              </Label>
              <Input
                id="msi-first-due"
                type="date"
                value={firstDue}
                onChange={(e) => setFirstDue(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="msi-name" className="text-xs">
              {t("holdings:msi.name")}
            </Label>
            <Input id="msi-name" value={name} onChange={(e) => setName(e.target.value)} />
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
          <Button onClick={() => void convert()} disabled={!ready}>
            {t("holdings:msi.convert")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
