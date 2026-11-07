import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icons,
  Input,
  Label,
  Page,
  PageContent,
  PageHeader,
  PrivacyAmount,
  ResponsiveSelect,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Skeleton,
} from "@wealthfolio/ui";
import { Switch } from "@wealthfolio/ui/components/ui/switch";

import { useTaxonomy } from "@/hooks/use-taxonomies";
import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

import { CategoryIcon } from "../components/category-chips";
import { SavingsPlanCard } from "../components/savings-plan-card";
import {
  useEnvelopeEntries,
  useEnvelopeMutations,
  useEnvelopeSnapshot,
} from "../hooks/use-envelopes";
import { useSpendingSettings } from "../hooks/use-spending-settings";
import { SPENDING_THEME, tint } from "../lib/theme";
import type {
  EnvelopeBalance,
  EnvelopeCategoryLink,
  EnvelopeSnapshot,
  FundingCadence,
  FundingRule,
  FundingSplit,
  PendingIncome,
} from "../types/envelopes";

const SPENDING_TAXONOMY = "spending_categories";
const INCOME_TAXONOMY = "income_sources";
const CARD = "bg-card border-border/60 rounded-xl border shadow-sm";
/** Hex, because <input type="color"> cannot hold a CSS variable. */
const DEFAULT_COLOR = "#2A573F";

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "<envelopeId>|<billId>" so one select covers envelopes and their bills. */
function potKey(envelopeId: string, billId?: string | null) {
  return `${envelopeId}|${billId ?? ""}`;
}
function parsePot(key: string): { envelopeId: string; billId: string | null } {
  const [envelopeId, billId] = key.split("|");
  return { envelopeId, billId: billId || null };
}
function potOptions(snapshot: EnvelopeSnapshot | undefined) {
  const out: { value: string; label: string }[] = [];
  for (const row of snapshot?.envelopes ?? []) {
    out.push({ value: potKey(row.envelope.id), label: row.envelope.name });
    for (const b of row.bills) {
      out.push({
        value: potKey(row.envelope.id, b.bill.id),
        label: `${row.envelope.name} · ${b.bill.name}`,
      });
    }
  }
  return out;
}
function potLabel(
  snapshot: EnvelopeSnapshot | undefined,
  envelopeId: string,
  billId: string | null,
) {
  const row = snapshot?.envelopes.find((e) => e.envelope.id === envelopeId);
  if (!row) return envelopeId;
  const bill = billId ? row.bills.find((b) => b.bill.id === billId)?.bill.name : null;
  return bill ? `${row.envelope.name} · ${bill}` : row.envelope.name;
}

export default function SpendingEnvelopesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isEnabled, isLoading: settingsLoading } = useSpendingSettings();
  const snapshot = useEnvelopeSnapshot();
  const [envelopeDialog, setEnvelopeDialog] = useState<{ open: boolean; row?: EnvelopeBalance }>({
    open: false,
  });
  const [rulesOpen, setRulesOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);

  if (!settingsLoading && !isEnabled) {
    return <Navigate to="/dashboard?tab=spending" replace />;
  }

  const data = snapshot.data;
  return (
    <Page>
      <PageHeader
        heading={t("spending:envelopes.heading")}
        text={t("spending:envelopes.subheading")}
        onBack={() => {
          if (window.history.length > 1) navigate(-1);
          else navigate("/dashboard?tab=spending");
        }}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRulesOpen(true)}>
              <Icons.Refresh className="me-1.5 h-3.5 w-3.5" />
              {t("spending:envelopes.rules")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMoveOpen(true)}
              disabled={!data || data.envelopes.length < 2}
            >
              <Icons.ArrowRight className="me-1.5 h-3.5 w-3.5" />
              {t("spending:envelopes.move")}
            </Button>
            <Button size="sm" onClick={() => setEnvelopeDialog({ open: true })}>
              <Icons.Plus className="me-1.5 h-3.5 w-3.5" />
              {t("spending:envelopes.newEnvelope")}
            </Button>
          </div>
        }
      />
      <PageContent className="space-y-5">
        {snapshot.isLoading && (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}
        {data && data.pendingIncome.length > 0 && <PendingIncomeSection snapshot={data} />}
        {data && (
          <>
            <TotalsStrip snapshot={data} />
            {data.envelopes.length === 0 ? (
              <div className={cn(CARD, "text-muted-foreground p-6 text-center text-sm")}>
                {t("spending:envelopes.empty")}
              </div>
            ) : (
              data.envelopes.map((row) => (
                <EnvelopeCard
                  key={row.envelope.id}
                  row={row}
                  snapshot={data}
                  onEdit={() => setEnvelopeDialog({ open: true, row })}
                />
              ))
            )}
            <SavingsPlanCard />
          </>
        )}
      </PageContent>

      <EnvelopeDialog
        open={envelopeDialog.open}
        row={envelopeDialog.row}
        onOpenChange={(open) => setEnvelopeDialog((s) => ({ ...s, open }))}
      />
      <MoveDialog open={moveOpen} onOpenChange={setMoveOpen} snapshot={data} />
      <RulesSheet open={rulesOpen} onOpenChange={setRulesOpen} snapshot={data} />
    </Page>
  );
}

// ----------------------------- totals -----------------------------

function TotalsStrip({ snapshot }: { snapshot: EnvelopeSnapshot }) {
  const { t } = useTranslation();
  const funded = snapshot.envelopes.reduce((s, e) => s + e.fundedThisMonth, 0);
  const spent = snapshot.envelopes.reduce((s, e) => s + e.spentThisMonth, 0);
  const cell = (label: string, value: number, strong?: boolean) => (
    <div className="min-w-0">
      <div className="text-muted-foreground text-2xs uppercase tracking-wide">{label}</div>
      <div
        className={cn(
          "truncate text-sm tabular-nums",
          strong && "font-semibold",
          value < 0 && "text-destructive",
        )}
      >
        <PrivacyAmount value={value} currency={snapshot.currency} />
      </div>
    </div>
  );
  return (
    <div className={cn(CARD, "grid grid-cols-3 gap-4 px-4 py-3")}>
      {cell(t("spending:envelopes.fundedThisMonth"), funded)}
      {cell(t("spending:envelopes.spentThisMonth"), spent)}
      {cell(t("spending:envelopes.totalBalance"), snapshot.totalBalance, true)}
    </div>
  );
}

// ----------------------------- envelope card -----------------------------

function EnvelopeCard({
  row,
  snapshot,
  onEdit,
}: {
  row: EnvelopeBalance;
  snapshot: EnvelopeSnapshot;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const [open, setOpen] = useState(true);
  const [entryOpen, setEntryOpen] = useState<{ open: boolean; billId?: string | null }>({
    open: false,
  });
  const [billDialog, setBillDialog] = useState<{
    open: boolean;
    bill?: EnvelopeBalance["bills"][number]["bill"];
  }>({ open: false });
  const [linksOpen, setLinksOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const accent = row.envelope.color ?? SPENDING_THEME.deep;
  const currency = snapshot.currency;
  const negative = row.balance < 0;

  return (
    <section className={cn(CARD, "overflow-hidden")}>
      <div className="flex items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:text-foreground -ms-1 flex h-6 w-6 shrink-0 items-center justify-center rounded"
          aria-expanded={open}
          aria-label={row.envelope.name}
        >
          <Icons.ChevronRight
            className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
          />
        </button>
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: tint(accent, 0.12), color: accent }}
        >
          <CategoryIcon icon={row.envelope.icon ?? null} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-semibold">{row.envelope.name}</div>
          <div className="text-muted-foreground text-2xs truncate tabular-nums">
            {t("spending:envelopes.thisMonth")}:{" "}
            <PrivacyAmount value={row.fundedThisMonth} currency={currency} />{" "}
            {t("spending:envelopes.in")} ·{" "}
            <PrivacyAmount value={row.spentThisMonth} currency={currency} />{" "}
            {t("spending:envelopes.out")}
            {row.linkedCategoryIds.length > 0 && (
              <> · {t("spending:envelopes.linkedCount", { count: row.linkedCategoryIds.length })}</>
            )}
          </div>
        </div>
        <div className="text-end">
          <div className={cn("text-sm font-semibold tabular-nums", negative && "text-destructive")}>
            <PrivacyAmount value={row.balance} currency={currency} />
          </div>
          <div className="text-muted-foreground text-2xs uppercase tracking-wide">
            {t("spending:envelopes.balance")}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-7 w-7 shrink-0 p-0"
                aria-label={t("spending:envelopes.actions")}
              />
            }
          >
            <Icons.MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem className="text-xs" onClick={() => setEntryOpen({ open: true })}>
              <Icons.Plus className="me-2 h-3.5 w-3.5" />
              {t("spending:envelopes.fundOrAdjust")}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onClick={() => setBillDialog({ open: true })}>
              <Icons.Receipt className="me-2 h-3.5 w-3.5" />
              {t("spending:envelopes.addBill")}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onClick={() => setLinksOpen(true)}>
              <Icons.Link className="me-2 h-3.5 w-3.5" />
              {t("spending:envelopes.linkCategories")}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-xs" onClick={() => setHistoryOpen(true)}>
              <Icons.History className="me-2 h-3.5 w-3.5" />
              {t("spending:envelopes.history")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-xs" onClick={onEdit}>
              <Icons.Pencil className="me-2 h-3.5 w-3.5" />
              {t("common:edit")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive text-xs"
              onClick={() => setConfirmDelete(true)}
            >
              <Icons.Trash className="me-2 h-3.5 w-3.5" />
              {t("common:delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {open && row.bills.length > 0 && (
        <div className="border-border/60 divide-border/40 divide-y border-t">
          {row.bills.map((b) => (
            <div
              key={b.bill.id}
              className="hover:bg-muted/15 flex items-center gap-2 px-3 py-1.5 text-xs sm:gap-3 sm:px-4"
            >
              <span className="w-5" />
              <span className="text-foreground min-w-0 flex-1 truncate">
                {b.bill.name}
                {b.bill.dueDay != null && (
                  <span className="text-muted-foreground">
                    {" "}
                    · {t("spending:envelopes.dueDay", { day: b.bill.dueDay })}
                  </span>
                )}
              </span>
              <span className="text-muted-foreground hidden w-24 shrink-0 text-end tabular-nums sm:inline">
                <PrivacyAmount value={b.bill.expectedAmount} currency={currency} />
              </span>
              <span
                className={cn(
                  "w-24 shrink-0 text-end font-medium tabular-nums",
                  b.balance < 0 ? "text-destructive" : "text-foreground",
                )}
              >
                <PrivacyAmount value={b.balance} currency={currency} />
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground h-6 w-6 shrink-0 p-0"
                      aria-label={t("spending:envelopes.actions")}
                    />
                  }
                >
                  <Icons.MoreHorizontal className="h-3.5 w-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    className="text-xs"
                    onClick={() => setEntryOpen({ open: true, billId: b.bill.id })}
                  >
                    <Icons.Plus className="me-2 h-3.5 w-3.5" />
                    {t("spending:envelopes.fundOrAdjust")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-xs"
                    onClick={() => setBillDialog({ open: true, bill: b.bill })}
                  >
                    <Icons.Pencil className="me-2 h-3.5 w-3.5" />
                    {t("common:edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive text-xs"
                    onClick={() => m.deleteBill.mutate(b.bill.id)}
                  >
                    <Icons.Trash className="me-2 h-3.5 w-3.5" />
                    {t("common:delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}

      <EntryDialog
        open={entryOpen.open}
        onOpenChange={(o) => setEntryOpen((s) => ({ ...s, open: o }))}
        row={row}
        billId={entryOpen.billId ?? null}
      />
      <BillDialog
        open={billDialog.open}
        onOpenChange={(o) => setBillDialog((s) => ({ ...s, open: o }))}
        envelopeId={row.envelope.id}
        bill={billDialog.bill}
      />
      <LinksDialog open={linksOpen} onOpenChange={setLinksOpen} row={row} />
      <HistorySheet
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        row={row}
        snapshot={snapshot}
      />
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("spending:envelopes.deleteTitle", { name: row.envelope.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("spending:envelopes.deleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => m.deleteEnvelope.mutate(row.envelope.id)}>
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// ----------------------------- small form bits -----------------------------

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function num(v: string) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ----------------------------- envelope dialog -----------------------------

function EnvelopeDialog({
  open,
  onOpenChange,
  row,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row?: EnvelopeBalance;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const e = row?.envelope;
  const [name, setName] = useState(e?.name ?? "");
  const [color, setColor] = useState(e?.color ?? DEFAULT_COLOR);
  const [startDate, setStartDate] = useState(e?.startDate ?? today());
  const [allowNegative, setAllowNegative] = useState(e?.allowNegative ?? false);
  const [opening, setOpening] = useState("");
  const [key, setKey] = useState(e?.id ?? "new");
  if (open && key !== (e?.id ?? "new")) {
    setKey(e?.id ?? "new");
    setName(e?.name ?? "");
    setColor(e?.color ?? DEFAULT_COLOR);
    setStartDate(e?.startDate ?? today());
    setAllowNegative(e?.allowNegative ?? false);
    setOpening("");
  }

  const save = async () => {
    const input = { name, color, startDate, allowNegative };
    if (e) {
      await m.updateEnvelope.mutateAsync({ id: e.id, input });
    } else {
      const created = await m.createEnvelope.mutateAsync(input);
      if (num(opening) !== 0) {
        await m.addEntry.mutateAsync({
          envelopeId: (created as { id: string }).id,
          entryDate: startDate,
          amount: num(opening),
          kind: "adjustment",
          note: t("spending:envelopes.openingBalance"),
        });
      }
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {e ? t("spending:envelopes.editEnvelope") : t("spending:envelopes.newEnvelope")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={t("spending:envelopes.name")}>
            <Input value={name} onChange={(ev) => setName(ev.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("spending:envelopes.color")}>
              <Input
                type="color"
                value={color}
                onChange={(ev) => setColor(ev.target.value)}
                className="h-9 p-1"
              />
            </Field>
            <Field label={t("spending:envelopes.startDate")}>
              <Input
                type="date"
                value={startDate}
                onChange={(ev) => setStartDate(ev.target.value)}
              />
            </Field>
          </div>
          {!e && (
            <Field label={t("spending:envelopes.openingBalance")}>
              <Input
                type="number"
                step="0.01"
                value={opening}
                onChange={(ev) => setOpening(ev.target.value)}
                placeholder="0"
              />
            </Field>
          )}
          <label className="flex items-center justify-between gap-3 text-xs">
            <span>
              <span className="text-foreground block">{t("spending:envelopes.allowNegative")}</span>
              <span className="text-muted-foreground">
                {t("spending:envelopes.allowNegativeDesc")}
              </span>
            </span>
            <Switch checked={allowNegative} onCheckedChange={setAllowNegative} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim()}>
            {t("common:save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------- bill dialog -----------------------------

function BillDialog({
  open,
  onOpenChange,
  envelopeId,
  bill,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  envelopeId: string;
  bill?: EnvelopeBalance["bills"][number]["bill"];
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const [name, setName] = useState(bill?.name ?? "");
  const [amount, setAmount] = useState(bill ? String(bill.expectedAmount) : "");
  const [dueDay, setDueDay] = useState(bill?.dueDay != null ? String(bill.dueDay) : "");
  const [cycle, setCycle] = useState(bill?.cycle ?? "monthly");
  const [opening, setOpening] = useState("");
  const [key, setKey] = useState(bill?.id ?? "new");
  if (open && key !== (bill?.id ?? "new")) {
    setKey(bill?.id ?? "new");
    setName(bill?.name ?? "");
    setAmount(bill ? String(bill.expectedAmount) : "");
    setDueDay(bill?.dueDay != null ? String(bill.dueDay) : "");
    setCycle(bill?.cycle ?? "monthly");
    setOpening("");
  }

  const save = async () => {
    const input = {
      envelopeId,
      name,
      expectedAmount: num(amount),
      dueDay: dueDay ? Number(dueDay) : null,
      cycle,
    };
    if (bill) {
      await m.updateBill.mutateAsync({ id: bill.id, input });
    } else {
      const created = (await m.createBill.mutateAsync(input)) as { id: string };
      if (num(opening) !== 0) {
        await m.addEntry.mutateAsync({
          envelopeId,
          billId: created.id,
          entryDate: today(),
          amount: num(opening),
          kind: "adjustment",
          note: t("spending:envelopes.openingBalance"),
        });
      }
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {bill ? t("spending:envelopes.editBill") : t("spending:envelopes.addBill")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={t("spending:envelopes.name")}>
            <Input value={name} onChange={(ev) => setName(ev.target.value)} autoFocus />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label={t("spending:envelopes.expectedAmount")}>
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(ev) => setAmount(ev.target.value)}
              />
            </Field>
            <Field label={t("spending:envelopes.dueDayLabel")}>
              <Input
                type="number"
                min={1}
                max={31}
                value={dueDay}
                onChange={(ev) => setDueDay(ev.target.value)}
              />
            </Field>
            <Field label={t("spending:envelopes.cycle")}>
              <ResponsiveSelect
                value={cycle}
                onValueChange={setCycle}
                options={[
                  { value: "monthly", label: t("spending:envelopes.monthly") },
                  { value: "yearly", label: t("spending:envelopes.yearly") },
                ]}
              />
            </Field>
          </div>
          {!bill && (
            <Field label={t("spending:envelopes.openingBalance")}>
              <Input
                type="number"
                step="0.01"
                value={opening}
                onChange={(ev) => setOpening(ev.target.value)}
                placeholder="0"
              />
            </Field>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim()}>
            {t("common:save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------- entry dialog -----------------------------

function EntryDialog({
  open,
  onOpenChange,
  row,
  billId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EnvelopeBalance;
  billId: string | null;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [kind, setKind] = useState<"funding" | "adjustment">("funding");
  const [note, setNote] = useState("");
  const [target, setTarget] = useState(billId ?? "");
  const [seenBill, setSeenBill] = useState(billId);
  if (seenBill !== billId) {
    setSeenBill(billId);
    setTarget(billId ?? "");
  }

  const save = async () => {
    await m.addEntry.mutateAsync({
      envelopeId: row.envelope.id,
      billId: target || null,
      entryDate: date,
      amount: num(amount),
      kind,
      note: note || null,
    });
    setAmount("");
    setNote("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("spending:envelopes.fundOrAdjust")} · {row.envelope.name}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("spending:envelopes.amount")}>
              <Input
                type="number"
                step="0.01"
                value={amount}
                onChange={(ev) => setAmount(ev.target.value)}
                autoFocus
              />
            </Field>
            <Field label={t("spending:envelopes.date")}>
              <Input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("spending:envelopes.kind")}>
              <ResponsiveSelect
                value={kind}
                onValueChange={(v) => setKind(v as "funding" | "adjustment")}
                options={[
                  { value: "funding", label: t("spending:envelopes.kindFunding") },
                  { value: "adjustment", label: t("spending:envelopes.kindAdjustment") },
                ]}
              />
            </Field>
            <Field label={t("spending:envelopes.pot")}>
              <ResponsiveSelect
                value={target}
                onValueChange={setTarget}
                options={[
                  { value: "", label: t("spending:envelopes.envelopeItself") },
                  ...row.bills.map((b) => ({ value: b.bill.id, label: b.bill.name })),
                ]}
              />
            </Field>
          </div>
          <Field label={t("spending:envelopes.note")}>
            <Input value={note} onChange={(ev) => setNote(ev.target.value)} />
          </Field>
          <p className="text-muted-foreground text-2xs">{t("spending:envelopes.entryHint")}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={num(amount) === 0}>
            {t("common:save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------- move dialog -----------------------------

function MoveDialog({
  open,
  onOpenChange,
  snapshot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: EnvelopeSnapshot | undefined;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const options = useMemo(() => potOptions(snapshot), [snapshot]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");

  const save = async () => {
    const f = parsePot(from);
    const d = parsePot(to);
    await m.moveMoney.mutateAsync({
      entryDate: date,
      amount: num(amount),
      fromEnvelopeId: f.envelopeId,
      fromBillId: f.billId,
      toEnvelopeId: d.envelopeId,
      toBillId: d.billId,
      note: note || null,
    });
    setAmount("");
    setNote("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("spending:envelopes.moveTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Field label={t("spending:envelopes.from")}>
            <ResponsiveSelect
              value={from}
              onValueChange={setFrom}
              options={options}
              placeholder={t("spending:envelopes.pickPot")}
            />
          </Field>
          <Field label={t("spending:envelopes.to")}>
            <ResponsiveSelect
              value={to}
              onValueChange={setTo}
              options={options}
              placeholder={t("spending:envelopes.pickPot")}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("spending:envelopes.amount")}>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={amount}
                onChange={(ev) => setAmount(ev.target.value)}
              />
            </Field>
            <Field label={t("spending:envelopes.date")}>
              <Input type="date" value={date} onChange={(ev) => setDate(ev.target.value)} />
            </Field>
          </div>
          <Field label={t("spending:envelopes.note")}>
            <Input value={note} onChange={(ev) => setNote(ev.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!from || !to || from === to || num(amount) <= 0}
          >
            {t("spending:envelopes.move")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------- links dialog -----------------------------

function LinksDialog({
  open,
  onOpenChange,
  row,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EnvelopeBalance;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const taxonomy = useTaxonomy(SPENDING_TAXONOMY);
  const categories = useMemo(() => {
    const cats = (taxonomy.data?.categories ?? [])
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const byParent = new Map<string | null, TaxonomyCategory[]>();
    for (const c of cats) {
      const key = c.parentId ?? null;
      byParent.set(key, [...(byParent.get(key) ?? []), c]);
    }
    const out: { category: TaxonomyCategory; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of byParent.get(parent) ?? []) {
        out.push({ category: c, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [taxonomy.data?.categories]);

  // categoryId -> "" (envelope) | billId
  const initial = useMemo(() => {
    const map = new Map<string, string>();
    row.linkedCategoryIds.forEach((id) => map.set(id, ""));
    row.bills.forEach((b) => b.linkedCategoryIds.forEach((id) => map.set(id, b.bill.id)));
    return map;
  }, [row]);
  const [links, setLinks] = useState<Map<string, string>>(initial);
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setLinks(initial);
  }

  const save = async () => {
    const out: EnvelopeCategoryLink[] = [...links.entries()].map(([categoryId, billId]) => ({
      categoryId,
      envelopeId: row.envelope.id,
      billId: billId || null,
    }));
    await m.replaceLinks.mutateAsync({ id: row.envelope.id, links: out });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("spending:envelopes.linkCategories")} · {row.envelope.name}
          </DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-xs">{t("spending:envelopes.linkHint")}</p>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto pe-1">
          {categories.map(({ category, depth }) => {
            const checked = links.has(category.id);
            return (
              <div
                key={category.id}
                className="flex items-center gap-2 text-xs"
                style={{ paddingInlineStart: depth * 16 }}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) =>
                    setLinks((prev) => {
                      const next = new Map(prev);
                      if (v) next.set(category.id, "");
                      else next.delete(category.id);
                      return next;
                    })
                  }
                  id={`link-${category.id}`}
                />
                <label htmlFor={`link-${category.id}`} className="min-w-0 flex-1 truncate">
                  {category.name}
                </label>
                {checked && row.bills.length > 0 && (
                  <ResponsiveSelect
                    value={links.get(category.id) ?? ""}
                    onValueChange={(v) => setLinks((prev) => new Map(prev).set(category.id, v))}
                    options={[
                      { value: "", label: t("spending:envelopes.envelopeItself") },
                      ...row.bills.map((b) => ({ value: b.bill.id, label: b.bill.name })),
                    ]}
                    triggerClassName="h-7 w-40 text-xs"
                  />
                )}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("common:save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ----------------------------- history sheet -----------------------------

function HistorySheet({
  open,
  onOpenChange,
  row,
  snapshot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: EnvelopeBalance;
  snapshot: EnvelopeSnapshot;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const entries = useEnvelopeEntries(open ? row.envelope.id : null);
  const billName = (id: string | null) => row.bills.find((b) => b.bill.id === id)?.bill.name;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="inline-end" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>
            {t("spending:envelopes.history")} · {row.envelope.name}
          </SheetTitle>
        </SheetHeader>
        <div className="divide-border/40 -mx-1 flex-1 divide-y overflow-y-auto text-xs">
          {entries.data?.length === 0 && (
            <div className="text-muted-foreground p-4 text-center">
              {t("spending:envelopes.noEntries")}
            </div>
          )}
          {entries.data?.map((e) => (
            <div key={e.id} className="flex items-center gap-2 px-2 py-2">
              <span className="text-muted-foreground w-20 shrink-0 tabular-nums">
                {e.entryDate}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <Badge variant="outline" className="text-2xs me-1.5">
                  {t(`spending:envelopes.kind_${e.kind}`)}
                </Badge>
                {e.note}
                {e.billId && <span className="text-muted-foreground"> · {billName(e.billId)}</span>}
              </span>
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  e.amount < 0 ? "text-destructive" : "text-success",
                )}
              >
                <PrivacyAmount value={e.amount} currency={snapshot.currency} />
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-6 w-6 shrink-0 p-0"
                aria-label={t("common:delete")}
                onClick={() => m.deleteEntry.mutate(e.id)}
              >
                <Icons.Trash className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ----------------------------- pending income -----------------------------

function PendingIncomeSection({ snapshot }: { snapshot: EnvelopeSnapshot }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <h3 className="text-muted-foreground text-2xs font-semibold uppercase tracking-wide">
        {t("spending:envelopes.pendingIncome")}
      </h3>
      {snapshot.pendingIncome.map((p) => (
        <PendingIncomeCard key={`${p.ruleId}:${p.activityId}`} item={p} snapshot={snapshot} />
      ))}
    </div>
  );
}

function PendingIncomeCard({
  item,
  snapshot,
}: {
  item: PendingIncome;
  snapshot: EnvelopeSnapshot;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const [amounts, setAmounts] = useState(item.proposed.map((p) => String(p.amount)));
  const total = amounts.reduce((s, a) => s + num(a), 0);
  const apply = () =>
    m.applyIncome.mutate({
      ruleId: item.ruleId,
      activityId: item.activityId,
      entryDate: item.date,
      splits: item.proposed.map((p, i) => ({ ...p, amount: num(amounts[i]) })),
    });
  return (
    <div className={cn(CARD, "space-y-2 px-4 py-3")}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span>
          <span className="font-semibold">{item.ruleName}</span>
          <span className="text-muted-foreground"> · {item.date}</span>
        </span>
        <span className="font-semibold tabular-nums">
          <PrivacyAmount value={item.amount} currency={snapshot.currency} />
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {item.proposed.map((p, i) => (
          <div
            key={`${p.envelopeId}|${p.billId ?? ""}`}
            className="flex items-center gap-2 text-xs"
          >
            <span className="min-w-0 flex-1 truncate">
              {potLabel(snapshot, p.envelopeId, p.billId)}
            </span>
            <Input
              type="number"
              step="0.01"
              value={amounts[i]}
              onChange={(ev) =>
                setAmounts((prev) => prev.map((a, j) => (j === i ? ev.target.value : a)))
              }
              className="h-7 w-32 text-end text-xs tabular-nums"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-3 text-xs">
        <span
          className={cn(
            "text-muted-foreground tabular-nums",
            Math.abs(total - item.amount) > 0.005 && "text-warning",
          )}
        >
          {t("spending:envelopes.splitTotal")}:{" "}
          <PrivacyAmount value={total} currency={snapshot.currency} />
        </span>
        <Button size="sm" onClick={apply} disabled={m.applyIncome.isPending}>
          {t("spending:envelopes.applySplit")}
        </Button>
      </div>
    </div>
  );
}

// ----------------------------- rules -----------------------------

function RulesSheet({
  open,
  onOpenChange,
  snapshot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: EnvelopeSnapshot | undefined;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const [editing, setEditing] = useState<{ open: boolean; rule?: FundingRule }>({ open: false });
  const cadenceLabel: Record<FundingCadence, string> = {
    biweekly: t("spending:envelopes.cadenceBiweekly"),
    semimonthly: t("spending:envelopes.cadenceSemimonthly"),
    monthly: t("spending:envelopes.cadenceMonthly"),
    on_income: t("spending:envelopes.cadenceOnIncome"),
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="inline-end" className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t("spending:envelopes.rules")}</SheetTitle>
        </SheetHeader>
        <p className="text-muted-foreground text-xs">{t("spending:envelopes.rulesHint")}</p>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {snapshot?.rules.map((r) => (
            <div key={r.id} className={cn(CARD, "flex items-center gap-2 px-3 py-2 text-xs")}>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">
                  {r.name}
                  {!r.active && (
                    <Badge variant="outline" className="text-2xs ms-2">
                      {t("spending:envelopes.inactive")}
                    </Badge>
                  )}
                </div>
                <div className="text-muted-foreground truncate">
                  {cadenceLabel[r.cadence]}
                  {(r.cadence === "biweekly" || r.cadence === "semimonthly") &&
                    r.anchorDate &&
                    ` · ${t("spending:envelopes.from")} ${r.anchorDate}`}
                  {r.cadence === "monthly" &&
                    r.dayOfMonth != null &&
                    ` · ${t("spending:envelopes.dueDay", { day: r.dayOfMonth })}`}
                  {" · "}
                  {r.splits
                    .map(
                      (s) =>
                        `${potLabel(snapshot, s.envelopeId, s.billId ?? null)} ${s.amount != null ? s.amount : `${s.percent ?? 0}%`}`,
                    )
                    .join(", ")}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                aria-label={t("common:edit")}
                onClick={() => setEditing({ open: true, rule: r })}
              >
                <Icons.Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive h-7 w-7 p-0"
                aria-label={t("common:delete")}
                onClick={() => m.deleteRule.mutate(r.id)}
              >
                <Icons.Trash className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button size="sm" onClick={() => setEditing({ open: true })}>
          <Icons.Plus className="me-1.5 h-3.5 w-3.5" />
          {t("spending:envelopes.newRule")}
        </Button>
        <RuleDialog
          open={editing.open}
          onOpenChange={(o) => setEditing((s) => ({ ...s, open: o }))}
          rule={editing.rule}
          snapshot={snapshot}
        />
      </SheetContent>
    </Sheet>
  );
}

function RuleDialog({
  open,
  onOpenChange,
  rule,
  snapshot,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule?: FundingRule;
  snapshot: EnvelopeSnapshot | undefined;
}) {
  const { t } = useTranslation();
  const m = useEnvelopeMutations();
  const income = useTaxonomy(INCOME_TAXONOMY);
  const pots = useMemo(() => potOptions(snapshot), [snapshot]);
  const [name, setName] = useState(rule?.name ?? "");
  const [cadence, setCadence] = useState<FundingCadence>(rule?.cadence ?? "biweekly");
  const [anchor, setAnchor] = useState(rule?.anchorDate ?? today());
  const [day, setDay] = useState(rule?.dayOfMonth != null ? String(rule.dayOfMonth) : "22");
  const [incomeCategory, setIncomeCategory] = useState(rule?.incomeCategoryId ?? "");
  const [active, setActive] = useState(rule?.active ?? true);
  const [splits, setSplits] = useState<FundingSplit[]>(rule?.splits ?? []);
  const [key, setKey] = useState(rule?.id ?? "new");
  if (open && key !== (rule?.id ?? "new")) {
    setKey(rule?.id ?? "new");
    setName(rule?.name ?? "");
    setCadence(rule?.cadence ?? "biweekly");
    setAnchor(rule?.anchorDate ?? today());
    setDay(rule?.dayOfMonth != null ? String(rule.dayOfMonth) : "22");
    setIncomeCategory(rule?.incomeCategoryId ?? "");
    setActive(rule?.active ?? true);
    setSplits(rule?.splits ?? []);
  }
  const incomeOptions = (income.data?.categories ?? [])
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({ value: c.id, label: c.parentId ? `  ${c.name}` : c.name }));

  const save = async () => {
    const input = {
      name,
      cadence,
      anchorDate: anchor || null,
      dayOfMonth: cadence === "monthly" ? Number(day) : null,
      incomeCategoryId: cadence === "on_income" ? incomeCategory || null : null,
      splits: splits.filter((s) => s.envelopeId),
      active,
    };
    if (rule) await m.updateRule.mutateAsync({ id: rule.id, input });
    else await m.createRule.mutateAsync(input);
    onOpenChange(false);
  };

  const setSplit = (i: number, patch: Partial<FundingSplit>) =>
    setSplits((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {rule ? t("spending:envelopes.editRule") : t("spending:envelopes.newRule")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("spending:envelopes.name")}>
              <Input value={name} onChange={(ev) => setName(ev.target.value)} autoFocus />
            </Field>
            <Field label={t("spending:envelopes.cadence")}>
              <ResponsiveSelect
                value={cadence}
                onValueChange={(v) => setCadence(v as FundingCadence)}
                options={[
                  { value: "biweekly", label: t("spending:envelopes.cadenceBiweekly") },
                  { value: "semimonthly", label: t("spending:envelopes.cadenceSemimonthly") },
                  { value: "monthly", label: t("spending:envelopes.cadenceMonthly") },
                  { value: "on_income", label: t("spending:envelopes.cadenceOnIncome") },
                ]}
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label={
                cadence === "on_income"
                  ? t("spending:envelopes.since")
                  : t("spending:envelopes.firstDate")
              }
            >
              <Input type="date" value={anchor} onChange={(ev) => setAnchor(ev.target.value)} />
            </Field>
            {cadence === "monthly" && (
              <Field label={t("spending:envelopes.dayOfMonth")}>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={day}
                  onChange={(ev) => setDay(ev.target.value)}
                />
              </Field>
            )}
            {cadence === "on_income" && (
              <Field label={t("spending:envelopes.incomeCategory")}>
                <ResponsiveSelect
                  value={incomeCategory}
                  onValueChange={setIncomeCategory}
                  options={incomeOptions}
                  placeholder={t("spending:envelopes.pickCategory")}
                />
              </Field>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{t("spending:envelopes.splits")}</Label>
            <p className="text-muted-foreground text-2xs">
              {cadence === "on_income"
                ? t("spending:envelopes.splitHintIncome")
                : t("spending:envelopes.splitHintFixed")}
            </p>
            {splits.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <ResponsiveSelect
                  value={potKey(s.envelopeId, s.billId)}
                  onValueChange={(v) => {
                    const p = parsePot(v);
                    setSplit(i, { envelopeId: p.envelopeId, billId: p.billId });
                  }}
                  options={pots}
                  placeholder={t("spending:envelopes.pickPot")}
                  triggerClassName="h-8 flex-1 text-xs"
                />
                <Input
                  type="number"
                  step="0.01"
                  className="h-8 w-28 text-end text-xs tabular-nums"
                  placeholder={t("spending:envelopes.amount")}
                  value={s.amount ?? ""}
                  onChange={(ev) =>
                    setSplit(i, {
                      amount: ev.target.value === "" ? null : Number(ev.target.value),
                      percent: null,
                    })
                  }
                />
                {cadence === "on_income" && (
                  <Input
                    type="number"
                    step="0.01"
                    className="h-8 w-20 text-end text-xs tabular-nums"
                    placeholder="%"
                    value={s.percent ?? ""}
                    onChange={(ev) =>
                      setSplit(i, {
                        percent: ev.target.value === "" ? null : Number(ev.target.value),
                        amount: null,
                      })
                    }
                  />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  aria-label={t("common:delete")}
                  onClick={() => setSplits((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Icons.X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setSplits((prev) => [
                  ...prev,
                  { envelopeId: "", billId: null, amount: null, percent: null },
                ])
              }
            >
              <Icons.Plus className="me-1.5 h-3.5 w-3.5" />
              {t("spending:envelopes.addSplit")}
            </Button>
          </div>
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-foreground">{t("spending:envelopes.active")}</span>
            <Switch checked={active} onCheckedChange={setActive} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={!name.trim() || splits.length === 0}>
            {t("common:save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
