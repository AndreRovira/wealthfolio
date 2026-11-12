import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Button,
  Checkbox,
  Icons,
  Input,
  PrivacyAmount,
  ResponsiveSelect,
  Skeleton,
} from "@wealthfolio/ui";

import { SwipablePage, type SwipablePageView } from "@/components/page";
import { cn } from "@/lib/utils";

import { getIncomePlan, saveIncomePlan, type IncomePlanDocument } from "../adapters/income-plan";
import { FxPendingCard } from "../components/fx-pending-card";
import { LoadFailed } from "../components/load-failed";
import { PaycheckPlanCard } from "../components/paycheck-plan-card";
import { ENVELOPES_KEY, useEnvelopeMutations, useEnvelopeSnapshot } from "../hooks/use-envelopes";
import { useReconcile, type Reconcile } from "../hooks/use-reconcile";
import { billLastPaid, billShares } from "../lib/bill-cycle";
import {
  evaluatePlan,
  expectedPaycheck,
  liquidityYield,
  resolvePlan,
  round2,
  sumQuincena,
  type EvaluatedLine,
  type PlanBasis,
  type PlanBlock,
  type PlanLine,
} from "../lib/plan-eval";
import {
  SOURCE_BILL,
  SOURCE_REMAINDER,
  type BillBalance,
  type EnvelopeSnapshot,
  type FundingSplit,
} from "../types/envelopes";

const CARD = "bg-card border-border/60 rounded-xl border shadow-sm";
const PLAN_KEY = "spending_income_plan";
const BLOCKS: PlanBlock[] = ["gross", "net", "base"];
const SAVINGS_BLOCKS: PlanBlock[] = ["savings"];
const BASES: PlanBasis[] = ["quincena", "monthly", "annual"];
/** One chart colour per block, so the three income tables and savings read apart at a glance. */
const BLOCK_COLOR: Record<PlanBlock, string> = {
  gross: "var(--chart-1)",
  net: "var(--chart-2)",
  base: "var(--chart-3)",
  savings: "var(--success)",
};

const newId = () => Math.random().toString(36).slice(2, 10);
const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** Live figures the plan's formulas read, and the liquid accounts they come from. */
function usePlanExternals(
  doc: IncomePlanDocument | undefined,
  snapshot: EnvelopeSnapshot | undefined,
) {
  const cash = useReconcile().data?.cash;
  const rates = doc?.liquidity?.rates;
  const liquid = useMemo<LiquidRow[]>(
    () =>
      (cash ?? [])
        .filter((r) => !r.excluded)
        .map((r) => ({
          id: r.account.id,
          name: r.account.name,
          balance: r.balance,
          rate: rates?.[r.account.id],
        })),
    [cash, rates],
  );
  const external = useMemo(
    () => planExternals(snapshot, liquidityYield(liquid).income),
    [snapshot, liquid],
  );
  return { liquid, external };
}

/** The plan page: the spreadsheet's income block, the paycheck split, and bills annualized. */
export default function SpendingPlanPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const snapshot = useEnvelopeSnapshot();
  const planQuery = useQuery({ queryKey: [PLAN_KEY], queryFn: getIncomePlan });
  const saved = planQuery.data;
  // Unsaved edits live above the tabs, so moving to another tab keeps them.
  const [draft, setDraft] = useState<IncomePlanDocument | null>(null);
  const doc = draft ?? saved;
  const { liquid, external } = usePlanExternals(doc, snapshot.data);
  const save = useMutation({
    mutationFn: (sent: IncomePlanDocument) => saveIncomePlan(sent, external),
    onSuccess: (_res, sent) => {
      qc.setQueryData([PLAN_KEY], sent);
      // Edits typed while the save was on its way stay as the draft.
      setDraft((d) => (d === sent ? null : d));
      void qc.invalidateQueries({ queryKey: [PLAN_KEY] });
      // Rule lines that read the plan change with it.
      void qc.invalidateQueries({ queryKey: [ENVELOPES_KEY] });
      toast.success(t("spending:plan.saved"));
    },
    onError: () => toast.error(t("spending:plan.saveFailed")),
  });

  const loading = <Skeleton className="h-40 w-full" />;
  const failed = planQuery.isError || snapshot.isError;
  const pane = (ready: unknown, render: () => ReactNode) =>
    failed ? (
      <LoadFailed
        onRetry={() => {
          void planQuery.refetch();
          void snapshot.refetch();
        }}
      />
    ) : ready ? (
      render()
    ) : (
      loading
    );
  const editor = (savings: boolean) =>
    pane(doc && saved, () => (
      <IncomeEditor
        doc={doc!}
        saved={saved!}
        savings={savings}
        dirty={draft !== null}
        saving={save.isPending}
        external={external}
        liquid={liquid}
        currency={snapshot.data?.currency ?? "MXN"}
        onChange={(fn) => setDraft((d) => fn(d ?? saved!))}
        onSave={() => save.mutate(doc!)}
      />
    ));
  const toEnvelopes = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={t("spending:envelopes.heading")}
      onClick={() => navigate("/spending/envelopes")}
    >
      <Icons.Wallet className="h-3.5 w-3.5 md:me-1.5" />
      <span className="hidden md:inline">{t("spending:envelopes.heading")}</span>
    </Button>
  );
  // Same swipeable tabs as the dashboard and holdings pages.
  const views: SwipablePageView[] = [
    { value: "income", label: t("spending:plan.tabIncome"), icon: Icons.DollarSign, content: editor(false) },
    {
      value: "paycheck",
      label: t("spending:plan.tabPaycheck"),
      icon: Icons.Banknote,
      content: pane(snapshot.data && doc, () => (
        <PaycheckTab snapshot={snapshot.data!} plan={doc!} external={external} dirty={draft !== null} />
      )),
    },
    {
      value: "bills",
      label: t("spending:plan.tabBills"),
      icon: Icons.Receipt,
      content: pane(snapshot.data, () => <BillsTab snapshot={snapshot.data!} />),
    },
    { value: "savings", label: t("spending:plan.tabSavings"), icon: Icons.PiggyBank, content: editor(true) },
    {
      value: "reconcile",
      label: t("spending:plan.tabReconcile"),
      icon: Icons.ListChecks,
      content: pane(saved, () => <ReconcileTab plan={saved!} external={external} />),
    },
  ].map((v) => ({ ...v, actions: toEnvelopes }));

  return (
    <SwipablePage
      views={views}
      defaultView="income"
      title={t("spending:plan.heading")}
      mobileActionsPlacement="header"
    />
  );
}

// ----------------------------- income -----------------------------

/**
 * Editor for the plan's blocks. `savings` shows the SAVINGS block with its rate
 * against net prorated and the liquidity accounts instead of the income blocks.
 */
function IncomeEditor({
  doc,
  saved,
  savings,
  dirty,
  saving,
  external,
  liquid,
  currency,
  onChange,
  onSave,
}: {
  doc: IncomePlanDocument;
  saved: IncomePlanDocument;
  savings: boolean;
  dirty: boolean;
  saving: boolean;
  external: Record<string, number>;
  liquid: LiquidRow[];
  currency: string;
  onChange: (fn: (d: IncomePlanDocument) => IncomePlanDocument) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => evaluatePlan(doc, external), [doc, external]);
  // Rows keep the saved plan's order, largest first: sorting by the amount being
  // typed would move the row under the keyboard. Lines not saved yet go last.
  const rank = useMemo(
    () => new Map(evaluatePlan(saved, external).map((r) => [r.line.id, r.value?.annual ?? -1])),
    [saved, external],
  );
  const hasErrors = rows.some((r) => r.error);
  const netTotal = sumQuincena(rows.filter((r) => r.line.block === "net"));
  const update = onChange;
  const setLine = (id: string, patch: Partial<PlanLine>) =>
    update((d) => ({
      ...d,
      lines: d.lines.map((l) =>
        l.id !== id
          ? l
          : {
              ...l,
              ...patch,
              // A saved line keeps its key: formulas and rule lines point at it.
              ...(patch.name !== undefined && !rank.has(id)
                ? { key: slug(patch.name) || l.key }
                : {}),
            },
      ),
    }));
  const addLine = (block: PlanBlock) =>
    update((d) => ({
      ...d,
      lines: [
        ...d.lines,
        {
          id: newId(),
          block,
          key: `line_${d.lines.length + 1}`,
          name: "",
          basis: "monthly",
          amount: 0,
          formula: null,
          inPaycheck: false,
          sortOrder: d.lines.length,
        },
      ],
    }));
  const removeLine = (id: string) =>
    update((d) => ({ ...d, lines: d.lines.filter((l) => l.id !== id) }));

  const grossByKey = new Map(
    rows.filter((r) => r.line.block === "gross").map((r) => [r.line.key, r.value?.monthly ?? null]),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        {hasErrors ? (
          <span className="text-destructive text-xs">{t("spending:plan.fixErrors")}</span>
        ) : (
          dirty && <span className="text-muted-foreground text-xs">{t("spending:plan.unsaved")}</span>
        )}
        {/* A line in error would save as zero and pull the paycheck split with it. */}
        <Button size="sm" onClick={onSave} disabled={!dirty || saving || hasErrors}>
          <Icons.Check className="me-1.5 h-3.5 w-3.5" />
          {t("common:save")}
        </Button>
      </div>
      {(savings ? SAVINGS_BLOCKS : BLOCKS).map((block) => {
        const blockRows = rows
          .filter((r) => r.line.block === block)
          .sort((a, b) => (rank.get(b.line.id) ?? -2) - (rank.get(a.line.id) ?? -2));
        const total = sumQuincena(blockRows);
        const totalMonthly = round2(blockRows.reduce((s, r) => s + (r.value?.monthly ?? 0), 0));
        const totalAnnual = round2(blockRows.reduce((s, r) => s + (r.value?.annual ?? 0), 0));
        return (
          <section key={block} className={cn(CARD, "overflow-x-auto")}>
            <div className="flex items-center justify-between px-4 pt-3">
              <h3 className="text-foreground flex items-center gap-2 text-sm font-semibold">
                <span
                  className="h-3.5 w-1 rounded-full"
                  style={{ backgroundColor: BLOCK_COLOR[block] }}
                />
                {t(`spending:plan.block_${block}`)}
              </h3>
              <Button variant="ghost" size="sm" onClick={() => addLine(block)}>
                <Icons.Plus className="me-1 h-3.5 w-3.5" />
                {t("spending:plan.addLine")}
              </Button>
            </div>
            <div className="space-y-2 px-3 pb-3 sm:hidden">
              {blockRows.map((r) => (
                <LineCard
                  key={r.line.id}
                  row={r}
                  block={block}
                  currency={currency}
                  gross={block === "net" ? (grossByKey.get(r.line.key) ?? null) : null}
                  onChange={(patch) => setLine(r.line.id, patch)}
                  onRemove={() => removeLine(r.line.id)}
                />
              ))}
              <div className="flex items-center justify-between px-1 pt-1 text-xs font-semibold">
                <span>{t("spending:plan.total")}</span>
                <span className="tabular-nums">
                  <PrivacyAmount value={total} currency={currency} /> ·{" "}
                  <PrivacyAmount value={totalAnnual} currency={currency} />
                </span>
              </div>
              {savings && netTotal > 0 && (
                <div className="flex items-center justify-between px-1 text-xs font-semibold">
                  <span>{t("spending:plan.savingsRate")}</span>
                  <span className="tabular-nums">{((total / netTotal) * 100).toFixed(2)}%</span>
                </div>
              )}
            </div>
            <table className="hidden w-full text-xs sm:table">
              <thead className="text-muted-foreground text-2xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2 text-start font-normal">{t("spending:plan.colName")}</th>
                  <th className="px-2 py-2 text-start font-normal">{t("spending:plan.colBasis")}</th>
                  <th className="px-2 py-2 text-start font-normal">{t("spending:plan.colAmountOrFormula")}</th>
                  <th className="px-2 py-2 text-end font-normal">{t("spending:plan.colQuincena")}</th>
                  <th className="px-2 py-2 text-end font-normal">{t("spending:plan.colMonthly")}</th>
                  <th className="px-2 py-2 text-end font-normal">{t("spending:plan.colAnnual")}</th>
                  {block === "net" && (
                    <th className="px-2 py-2 text-end font-normal">{t("spending:plan.colWithheld")}</th>
                  )}
                  {block === "base" && (
                    <th className="px-2 py-2 text-center font-normal">{t("spending:plan.colPaycheck")}</th>
                  )}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-border/40 divide-y">
                {blockRows.map((r) => (
                  <LineRow
                    key={r.line.id}
                    row={r}
                    block={block}
                    currency={currency}
                    gross={block === "net" ? (grossByKey.get(r.line.key) ?? null) : null}
                    onChange={(patch) => setLine(r.line.id, patch)}
                    onRemove={() => removeLine(r.line.id)}
                  />
                ))}
              </tbody>
              <tfoot className="border-border/60 border-t font-semibold">
                <tr>
                  <td className="px-4 py-2" colSpan={3}>
                    {t("spending:plan.total")}
                  </td>
                  <td className="px-2 py-2 text-end tabular-nums">
                    <PrivacyAmount value={total} currency={currency} />
                  </td>
                  <td className="px-2 py-2 text-end tabular-nums">
                    <PrivacyAmount value={totalMonthly} currency={currency} />
                  </td>
                  <td className="px-2 py-2 text-end tabular-nums">
                    <PrivacyAmount value={totalAnnual} currency={currency} />
                  </td>
                  <td colSpan={2} />
                </tr>
                {savings && netTotal > 0 && (
                  <tr>
                    <td className="px-4 pb-2" colSpan={4}>
                      {t("spending:plan.savingsRate")}
                    </td>
                    <td className="px-2 pb-2 text-end tabular-nums">
                      {((total / netTotal) * 100).toFixed(2)}%
                    </td>
                    <td colSpan={3} />
                  </tr>
                )}
              </tfoot>
            </table>
          </section>
        );
      })}
      {savings ? (
        <LiquidityCard
          rows={liquid}
          currency={currency}
          onRate={(id, rate) =>
            update((d) => {
              const next = { ...d.liquidity?.rates };
              if (rate === null) delete next[id];
              else next[id] = rate;
              return { ...d, liquidity: { rates: next } };
            })
          }
        />
      ) : (
        <ConstantsEditor
          doc={doc}
          onChange={(constants) => update((d) => ({ ...d, constants }))}
        />
      )}
      <p className="text-muted-foreground text-2xs">
        {t(savings ? "spending:plan.savingsHelp" : "spending:plan.formulaHelp")}
      </p>
    </div>
  );
}

function LineRow({
  row,
  block,
  currency,
  gross,
  onChange,
  onRemove,
}: {
  row: EvaluatedLine;
  block: PlanBlock;
  currency: string;
  gross: number | null;
  onChange: (patch: Partial<PlanLine>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const { line, value, error } = row;
  const isFormula = line.formula !== null;
  const withheld = gross !== null && value ? round2(gross - value.monthly) : null;
  const cell = (v: number | undefined) => (
    <td className="px-2 py-1.5 text-end tabular-nums">
      {v === undefined ? <span className="text-destructive">—</span> : <PrivacyAmount value={v} currency={currency} />}
    </td>
  );
  return (
    <tr className={cn(error && "bg-destructive/5")}>
      <td className="px-4 py-1.5">
        <Input
          value={line.name}
          placeholder={t("spending:plan.colName")}
          className="h-7 text-xs"
          onChange={(e) => {
            onChange({ name: e.target.value });
          }}
        />
        <div className="text-muted-foreground mt-0.5 font-mono text-2xs">
          {line.block}.{line.key}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <ResponsiveSelect
          value={line.basis}
          onValueChange={(v) => onChange({ basis: v as PlanBasis })}
          options={BASES.map((b) => ({ value: b, label: t(`spending:plan.basis_${b}`) }))}
          triggerClassName="h-7 text-xs"
        />
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground font-mono text-2xs"
            title={t("spending:plan.toggleFormula")}
            onClick={() =>
              onChange(
                isFormula
                  ? { formula: null, amount: value?.raw ?? 0 }
                  : { formula: String(line.amount ?? 0), amount: null },
              )
            }
          >
            {isFormula ? "fx" : "#"}
          </button>
          {isFormula ? (
            <Input
              value={line.formula ?? ""}
              className="h-7 font-mono text-xs"
              onChange={(e) => onChange({ formula: e.target.value })}
            />
          ) : (
            <Input
              type="number"
              step="0.01"
              value={line.amount ?? ""}
              className="h-7 text-end text-xs tabular-nums"
              onChange={(e) => onChange({ amount: e.target.value === "" ? null : Number(e.target.value) })}
            />
          )}
        </div>
        {error && <div className="text-destructive mt-0.5 text-2xs">{error}</div>}
      </td>
      {cell(value?.quincena)}
      {cell(value?.monthly)}
      {cell(value?.annual)}
      {block === "net" && (
        <td className="text-muted-foreground px-2 py-1.5 text-end tabular-nums">
          {withheld !== null && gross ? (
            <>
              <PrivacyAmount value={withheld} currency={currency} />
              <span className="ms-1">({((withheld / gross) * 100).toFixed(1)}%)</span>
            </>
          ) : (
            ""
          )}
        </td>
      )}
      {block === "base" && (
        <td className="px-2 py-1.5 text-center">
          <Checkbox
            checked={line.inPaycheck}
            onCheckedChange={(v) => onChange({ inPaycheck: Boolean(v) })}
            aria-label={t("spending:plan.colPaycheck")}
          />
        </td>
      )}
      <td className="px-2 py-1.5 text-end">
        <button
          type="button"
          className="text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={t("common:delete")}
        >
          <Icons.Trash className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  );
}

type LineProps = Parameters<typeof LineRow>[0];

/** Mobile layout of a plan line: one row to read, opened into the editor on tap. */
function LineCard(props: LineProps) {
  const { line, value, error } = props.row;
  // A plan is read far more often than edited; a new line opens ready to fill in.
  const [open, setOpen] = useState(line.name === "");
  if (open) return <LineCardEditor {...props} onCollapse={() => setOpen(false)} />;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className={cn(
        "border-border/40 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-start text-xs",
        error && "bg-destructive/5",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="text-foreground block truncate">{line.name || "—"}</span>
        <span
          className={cn(
            "block truncate font-mono text-2xs",
            error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error ?? `${line.block}.${line.key}`}
        </span>
      </span>
      {value && (
        <span className="shrink-0 text-end tabular-nums">
          <span className="text-foreground block font-medium">
            <PrivacyAmount value={value.annual} currency={props.currency} />
          </span>
          <span className="text-muted-foreground block text-2xs">
            <PrivacyAmount value={value.quincena} currency={props.currency} /> ·{" "}
            <PrivacyAmount value={value.monthly} currency={props.currency} />
          </span>
        </span>
      )}
      <Icons.ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
    </button>
  );
}

function LineCardEditor({
  row,
  block,
  currency,
  gross,
  onChange,
  onRemove,
  onCollapse,
}: LineProps & { onCollapse: () => void }) {
  const { t } = useTranslation();
  const { line, value, error } = row;
  const isFormula = line.formula !== null;
  const withheld = gross !== null && value ? round2(gross - value.monthly) : null;
  const fig = (label: string, v: number | undefined) => (
    <div className="min-w-0">
      <div className="text-muted-foreground text-2xs uppercase">{label}</div>
      <div className="truncate tabular-nums">
        {v === undefined ? "—" : <PrivacyAmount value={v} currency={currency} />}
      </div>
    </div>
  );
  return (
    <div className={cn("border-border/40 rounded-lg border p-2 text-xs", error && "bg-destructive/5")}>
      <div className="flex items-center gap-2">
        <Input
          value={line.name}
          placeholder={t("spending:plan.colName")}
          className="h-8 flex-1 text-xs"
          onChange={(e) => {
            onChange({ name: e.target.value });
          }}
        />
        <ResponsiveSelect
          value={line.basis}
          onValueChange={(v) => onChange({ basis: v as PlanBasis })}
          options={BASES.map((b) => ({ value: b, label: t(`spending:plan.basis_${b}`) }))}
          triggerClassName="h-8 w-28 text-xs"
        />
        <button type="button" className="text-muted-foreground hover:text-destructive p-1.5" onClick={onRemove} aria-label={t("common:delete")}>
          <Icons.Trash className="h-4 w-4" />
        </button>
        <button type="button" className="text-muted-foreground hover:text-foreground p-1.5" onClick={onCollapse} aria-label={t("common:close")}>
          <Icons.ChevronUp className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground w-6 font-mono text-2xs"
          title={t("spending:plan.toggleFormula")}
          onClick={() =>
            onChange(
              isFormula ? { formula: null, amount: value?.raw ?? 0 } : { formula: String(line.amount ?? 0), amount: null },
            )
          }
        >
          {isFormula ? "fx" : "#"}
        </button>
        {isFormula ? (
          <Input value={line.formula ?? ""} className="h-8 flex-1 font-mono text-xs" onChange={(e) => onChange({ formula: e.target.value })} />
        ) : (
          <Input
            type="number"
            step="0.01"
            inputMode="decimal"
            value={line.amount ?? ""}
            className="h-8 flex-1 text-end text-xs tabular-nums"
            onChange={(e) => onChange({ amount: e.target.value === "" ? null : Number(e.target.value) })}
          />
        )}
        {block === "base" && (
          <label className="text-muted-foreground flex items-center gap-1 text-2xs">
            <Checkbox checked={line.inPaycheck} onCheckedChange={(v) => onChange({ inPaycheck: Boolean(v) })} />
            {t("spending:plan.colPaycheck")}
          </label>
        )}
      </div>
      {error && <div className="text-destructive mt-1 text-2xs">{error}</div>}
      <div className="mt-1.5 grid grid-cols-3 gap-2">
        {fig(t("spending:plan.colQuincena"), value?.quincena)}
        {fig(t("spending:plan.colMonthly"), value?.monthly)}
        {fig(t("spending:plan.colAnnual"), value?.annual)}
      </div>
      {block === "net" && withheld !== null && gross ? (
        <div className="text-muted-foreground mt-1 text-2xs">
          {t("spending:plan.colWithheld")}: <PrivacyAmount value={withheld} currency={currency} /> ({((withheld / gross) * 100).toFixed(1)}%)
        </div>
      ) : null}
      <div className="text-muted-foreground mt-1 font-mono text-2xs">{line.block}.{line.key}</div>
    </div>
  );
}

/**
 * Live figures savings formulas can read: `bill.<name>` and `envelope.<name>`
 * per quincena (a bill's share, an envelope's scheduled funding) and
 * `liquidity.income` per month.
 */
function planExternals(snapshot: EnvelopeSnapshot | undefined, liquidityIncome: number) {
  const out: Record<string, number> = { "liquidity.income": liquidityIncome };
  for (const e of snapshot?.envelopes ?? []) {
    out[`envelope.${slug(e.envelope.name)}`] = e.periodTarget;
    for (const b of e.bills) {
      out[`bill.${slug(b.bill.name)}`] = billShares(b.bill.expectedAmount, b.bill.cycle).quincena;
    }
  }
  return out;
}

interface LiquidRow {
  id: string;
  name: string;
  balance: number;
  rate?: number;
}

/** The spreadsheet's LIQUIDITY block: what each liquid account earns a month. */
function LiquidityCard({
  rows,
  currency,
  onRate,
}: {
  rows: LiquidRow[];
  currency: string;
  onRate: (id: string, rate: number | null) => void;
}) {
  const { t } = useTranslation();
  const totals = liquidityYield(rows);
  const sorted = [...rows].sort(
    (a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.balance - a.balance,
  );
  return (
    <section className={cn(CARD, "overflow-x-auto")}>
      <h3 className="text-foreground px-4 pt-3 text-sm font-semibold">
        {t("spending:plan.liquidityTitle")}
      </h3>
      <table className="w-full text-xs">
        <thead className="text-muted-foreground text-2xs uppercase tracking-wide">
          <tr>
            <th className="px-4 py-2 text-start font-normal">{t("spending:plan.colAccount")}</th>
            <th className="hidden px-2 py-2 text-end font-normal sm:table-cell">
              {t("spending:plan.colBalance")}
            </th>
            <th className="px-2 py-2 text-end font-normal">{t("spending:plan.colRate")}</th>
            <th className="px-4 py-2 text-end font-normal">{t("spending:plan.colMonthlyIncome")}</th>
          </tr>
        </thead>
        <tbody className="divide-border/40 divide-y">
          {sorted.map((r) => (
            <tr key={r.id} className={cn(r.rate == null && "text-muted-foreground")}>
              <td className="px-4 py-1.5">
                {r.name}
                <span className="text-muted-foreground block text-2xs tabular-nums sm:hidden">
                  <PrivacyAmount value={r.balance} currency={currency} />
                </span>
              </td>
              <td className="hidden px-2 py-1.5 text-end tabular-nums sm:table-cell">
                <PrivacyAmount value={r.balance} currency={currency} />
              </td>
              <td className="px-2 py-1.5">
                <div className="flex items-center justify-end gap-1">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={r.rate ?? ""}
                    placeholder="—"
                    aria-label={`${t("spending:plan.colRate")} ${r.name}`}
                    className="h-7 w-16 text-end text-xs tabular-nums"
                    onChange={(e) =>
                      onRate(r.id, e.target.value === "" ? null : Number(e.target.value))
                    }
                  />
                  %
                </div>
              </td>
              <td className="px-4 py-1.5 text-end tabular-nums">
                {r.rate == null ? (
                  "—"
                ) : (
                  <PrivacyAmount value={(r.balance * r.rate) / 1200} currency={currency} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-border/60 border-t font-semibold">
          <tr>
            <td className="px-4 py-2">
              {t("spending:plan.total")}
              <span className="block text-2xs font-normal tabular-nums sm:hidden">
                <PrivacyAmount value={totals.total} currency={currency} />
              </span>
            </td>
            <td className="hidden px-2 py-2 text-end tabular-nums sm:table-cell">
              <PrivacyAmount value={totals.total} currency={currency} />
            </td>
            <td className="px-2 py-2 text-end tabular-nums">{totals.rate.toFixed(2)}%</td>
            <td className="px-4 py-2 text-end tabular-nums">
              <PrivacyAmount value={totals.income} currency={currency} />
            </td>
          </tr>
        </tfoot>
      </table>
      <p className="text-muted-foreground px-4 pb-3 text-2xs">{t("spending:plan.liquidityHint")}</p>
    </section>
  );
}

function ConstantsEditor({
  doc,
  onChange,
}: {
  doc: IncomePlanDocument;
  onChange: (constants: IncomePlanDocument["constants"]) => void;
}) {
  const { t } = useTranslation();
  const set = (i: number, patch: Partial<IncomePlanDocument["constants"][number]>) =>
    onChange(doc.constants.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <section className={cn(CARD, "p-4")}>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">{t("spending:plan.constants")}</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...doc.constants, { key: "uma.daily", value: 0, label: "" }])}
        >
          <Icons.Plus className="me-1 h-3.5 w-3.5" />
          {t("spending:plan.addLine")}
        </Button>
      </div>
      <div className="space-y-1.5">
        {doc.constants.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input
              value={c.key}
              className="h-7 w-36 font-mono text-xs sm:w-44"
              onChange={(e) => set(i, { key: e.target.value.trim() })}
            />
            <Input
              type="number"
              step="0.01"
              value={c.value}
              className="h-7 w-24 text-end text-xs tabular-nums sm:w-32"
              onChange={(e) => set(i, { value: Number(e.target.value) })}
            />
            <Input
              value={c.label}
              placeholder={t("spending:plan.constantLabel")}
              className="h-7 min-w-32 flex-1 text-xs"
              onChange={(e) => set(i, { label: e.target.value })}
            />
            <button
              type="button"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onChange(doc.constants.filter((_, j) => j !== i))}
              aria-label={t("common:delete")}
            >
              <Icons.Trash className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

// ----------------------------- paycheck -----------------------------

function PaycheckTab({
  snapshot,
  plan,
  external,
  dirty,
}: {
  snapshot: EnvelopeSnapshot;
  plan: IncomePlanDocument;
  external: Record<string, number>;
  /** The plan has unsaved edits: the figures preview them, the rule waits for the save. */
  dirty: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const m = useEnvelopeMutations();
  const expected = useMemo(() => expectedPaycheck(evaluatePlan(plan, external)), [plan, external]);
  const planRefs = useMemo(() => resolvePlan(plan, external), [plan, external]);
  const rules = snapshot.rules.filter((r) => r.active && r.splits.some((s) => s.amount != null));
  const rule = rules.find((r) => r.id === plan.paycheck?.ruleId) ?? rules[0];
  const linked = rule?.splits.find((s) => s.source === SOURCE_REMAINDER);
  const [remainderId, setRemainderId] = useState(
    linked?.envelopeId ?? plan.paycheck?.remainderEnvelopeId ?? "",
  );
  const remainder = remainderId || null;
  // The line that takes what is left: the one already linked, else the
  // envelope's first fixed line.
  const target =
    linked?.envelopeId === remainder
      ? linked
      : rule?.splits.find((s) => s.envelopeId === remainder && !s.billId && s.amount != null);
  const fixedOthers = rule
    ? round2(rule.splits.filter((s) => s !== target).reduce((sum, s) => sum + (s.amount ?? 0), 0))
    : 0;
  const currentRemainder = target?.amount ?? 0;
  const shouldBe = round2(expected - fixedOthers);
  const diff = round2(shouldBe - currentRemainder);
  const automatic = target != null && target === linked && Math.abs(diff) < 0.01;
  const envelopeName = (id: string | null) =>
    snapshot.envelopes.find((e) => e.envelope.id === id)?.envelope.name ?? "";
  // Rule lines pointing at a plan line that was renamed or removed keep their
  // last amount on the server, so name them here.
  const planRef = (s: FundingSplit) =>
    s.source && s.source !== SOURCE_BILL && s.source !== SOURCE_REMAINDER
      ? s.source.replace(/^-/, "").trim()
      : null;
  const missing = (rule?.splits ?? []).filter((s) => {
    const ref = planRef(s);
    return ref !== null && !(ref in planRefs);
  });

  const apply = useMutation({
    mutationFn: async () => {
      if (!rule || !target) return;
      // Plan first: the server works the remainder out from its saved values.
      await saveIncomePlan(
        { ...plan, paycheck: { ruleId: rule.id, remainderEnvelopeId: remainder } },
        external,
      );
      await m.updateRule.mutateAsync({
        id: rule.id,
        input: {
          name: rule.name,
          cadence: rule.cadence,
          anchorDate: rule.anchorDate,
          dayOfMonth: rule.dayOfMonth,
          incomeCategoryId: rule.incomeCategoryId,
          shortfallEnvelopeId: rule.shortfallEnvelopeId,
          splits: rule.splits.map((s) =>
            s === target
              ? { ...s, amount: shouldBe, percent: null, source: SOURCE_REMAINDER }
              : s.source === SOURCE_REMAINDER
                ? { ...s, source: null }
                : s,
          ),
          active: rule.active,
        },
      });
      void qc.invalidateQueries({ queryKey: [PLAN_KEY] });
    },
    onError: () => toast.error(t("spending:plan.saveFailed")),
  });

  const line = (label: string, v: number, strong?: boolean, minus?: boolean) => (
    <div className="flex items-center justify-between text-xs">
      <span className={strong ? "text-foreground font-medium" : "text-muted-foreground"}>{label}</span>
      <span className={cn("tabular-nums", strong && "font-semibold")}>
        {minus ? "− " : ""}
        <PrivacyAmount value={v} currency={snapshot.currency} />
      </span>
    </div>
  );

  return (
    <div className="space-y-4">
      <section className={cn(CARD, "space-y-1.5 p-4")}>
        <h3 className="text-foreground mb-2 text-sm font-semibold">{t("spending:plan.paycheckMath")}</h3>
        {line(t("spending:plan.expectedFromPlan"), expected, true)}
        {line(t("spending:plan.fixedOtherLines"), fixedOthers, false, true)}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-muted-foreground text-xs">{t("spending:plan.remainderGoesTo")}</span>
          <ResponsiveSelect
            value={remainderId}
            onValueChange={setRemainderId}
            options={snapshot.envelopes.map((e) => ({ value: e.envelope.id, label: e.envelope.name }))}
            placeholder={t("spending:envelopes.pickPot")}
            triggerClassName="h-7 w-48 text-xs"
          />
        </div>
        {remainder && (
          <>
            {line(t("spending:plan.remainderShouldBe", { name: envelopeName(remainder) }), shouldBe, true)}
            {line(t("spending:plan.ruleHasNow"), currentRemainder)}
            {automatic ? (
              <div className="text-success pt-1 text-xs">{t("spending:plan.inSync")}</div>
            ) : (
              <div className="flex items-center justify-between gap-2 pt-1">
                <span className="text-warning text-xs">
                  {Math.abs(diff) >= 0.01 ? (
                    <>
                      {t("spending:plan.offBy")}{" "}
                      <PrivacyAmount value={diff} currency={snapshot.currency} />
                    </>
                  ) : (
                    t("spending:plan.notLinked")
                  )}
                </span>
                {dirty && <span className="text-muted-foreground text-2xs">{t("spending:plan.unsaved")}</span>}
                {/* Never write a remainder worked out from a missing or negative paycheck. */}
                <Button
                  size="sm"
                  onClick={() => apply.mutate()}
                  disabled={apply.isPending || !target || dirty || expected <= 0 || shouldBe < 0}
                >
                  {t("spending:plan.applyToRule")}
                </Button>
              </div>
            )}
          </>
        )}
        {missing.map((s, i) => (
          <p key={i} className="text-destructive pt-1 text-2xs">
            {t("spending:plan.missingRef", {
              line: s.label || envelopeName(s.envelopeId),
              ref: planRef(s),
            })}
          </p>
        ))}
        {expected === 0 && (
          <p className="text-muted-foreground pt-1 text-2xs">{t("spending:plan.flagLinesHint")}</p>
        )}
      </section>
      <PaycheckPlanCard snapshot={snapshot} />
    </div>
  );
}

// ----------------------------- bills -----------------------------

function BillsTab({ snapshot }: { snapshot: EnvelopeSnapshot }) {
  const { t } = useTranslation();
  const currency = snapshot.currency;
  const rows = snapshot.envelopes
    .flatMap((e) => e.bills.map((b) => ({ b, envelope: e.envelope.name })))
    .map(({ b, envelope }) => ({ b, envelope, ...billShares(b.bill.expectedAmount, b.bill.cycle) }))
    .sort((a, b) => b.annual - a.annual);
  const total = (k: "quincena" | "monthly" | "annual") => round2(rows.reduce((s, r) => s + r[k], 0));
  const num = (v: number, cls?: string) => (
    <td className={cn("px-2 py-1.5 text-end tabular-nums", cls)}>
      <PrivacyAmount value={v} currency={currency} />
    </td>
  );
  const stateText = (b: BillBalance) =>
    b.state === "overdue"
      ? t("spending:envelopes.overdue")
      : b.state === "underfunded"
        ? t("spending:envelopes.underfunded")
        : b.daysLeft === null
          ? ""
          : b.daysLeft === 0
            ? t("spending:envelopes.dueToday")
            : t("spending:envelopes.dueIn", { count: b.daysLeft });
  return (
    <section className={cn(CARD, "overflow-x-auto")}>
      <div className="divide-border/40 divide-y sm:hidden">
        {rows.map(({ b, envelope, quincena, monthly, annual }) => (
          <div key={b.bill.id} className="px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-foreground truncate">{b.bill.name}</div>
                <div className="text-muted-foreground text-2xs">
                  {envelope} · {b.bill.cycle}
                </div>
              </div>
              <div className="shrink-0 text-end">
                <div className="font-medium tabular-nums">
                  <PrivacyAmount value={annual} currency={currency} />
                </div>
                <div className="text-muted-foreground text-2xs tabular-nums">
                  <PrivacyAmount value={quincena} currency={currency} /> · <PrivacyAmount value={monthly} currency={currency} />
                </div>
              </div>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2 text-2xs">
              <span
                className={cn(
                  b.state === "overdue" ? "text-destructive" : b.state === "ready" ? "text-success" : "text-muted-foreground",
                )}
              >
                {b.bill.nextDue ?? "—"} · {stateText(b)}
                {b.state === "ready" && ` · ${t("spending:envelopes.ready")}`}
              </span>
              <span className={cn("tabular-nums", b.balance < 0 ? "text-destructive" : b.state === "ready" ? "text-success" : "")}>
                <PrivacyAmount value={b.balance} currency={currency} />
              </span>
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold">
          <span>{t("spending:plan.total")}</span>
          <span className="tabular-nums">
            <PrivacyAmount value={total("annual")} currency={currency} />
          </span>
        </div>
      </div>
      <table className="hidden w-full text-xs sm:table">
        <thead className="text-muted-foreground text-2xs uppercase tracking-wide">
          <tr>
            <th className="px-4 py-2 text-start font-normal">{t("spending:plan.tabBills")}</th>
            <th className="px-2 py-2 text-start font-normal">{t("spending:envelopes.cycle")}</th>
            <th className="px-2 py-2 text-end font-normal">{t("spending:plan.colQuincena")}</th>
            <th className="px-2 py-2 text-end font-normal">{t("spending:plan.colMonthly")}</th>
            <th className="px-2 py-2 text-end font-normal">{t("spending:plan.colAnnual")}</th>
            <th className="px-2 py-2 text-start font-normal">{t("spending:plan.colLastPaid")}</th>
            <th className="px-2 py-2 text-start font-normal">{t("spending:envelopes.nextDue")}</th>
            <th className="px-2 py-2 text-end font-normal">{t("spending:envelopes.balance")}</th>
          </tr>
        </thead>
        <tbody className="divide-border/40 divide-y">
          {rows.map(({ b, envelope, quincena, monthly, annual }) => (
            <tr key={b.bill.id}>
              <td className="px-4 py-1.5">
                <div className="text-foreground">{b.bill.name}</div>
                <div className="text-muted-foreground text-2xs">{envelope}</div>
              </td>
              <td className="text-muted-foreground px-2 py-1.5">{b.bill.cycle}</td>
              {num(quincena)}
              {num(monthly)}
              {num(annual, "font-medium")}
              <td
                className={cn(
                  "text-muted-foreground px-2 py-1.5 tabular-nums",
                  !billLastPaid(b).recorded && "italic",
                )}
                title={
                  billLastPaid(b).date && !billLastPaid(b).recorded
                    ? t("spending:envelopes.savingSinceHint")
                    : undefined
                }
              >
                {billLastPaid(b).date ?? "—"}
              </td>
              <td className="px-2 py-1.5 tabular-nums">
                <div>{b.bill.nextDue ?? "—"}</div>
                <div
                  className={cn(
                    "text-2xs",
                    b.state === "overdue"
                      ? "text-destructive"
                      : b.state === "ready"
                        ? "text-success"
                        : "text-muted-foreground",
                  )}
                >
                  {stateText(b)}
                  {b.state === "ready" && ` · ${t("spending:envelopes.ready")}`}
                </div>
              </td>
              {num(b.balance, b.balance < 0 ? "text-destructive" : b.state === "ready" ? "text-success" : "")}
            </tr>
          ))}
        </tbody>
        <tfoot className="border-border/60 border-t font-semibold">
          <tr>
            <td className="px-4 py-2" colSpan={2}>
              {t("spending:plan.total")}
            </td>
            {num(total("quincena"))}
            {num(total("monthly"))}
            {num(total("annual"))}
            <td colSpan={3} />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

// ----------------------------- reconcile -----------------------------

function ReconcileTab({
  plan,
  external,
}: {
  plan: IncomePlanDocument;
  external: Record<string, number>;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useReconcile();
  const [tolerance, setTolerance] = useState(String(plan.reconcile?.tolerance ?? 1));
  const saveTolerance = useMutation({
    mutationFn: () =>
      saveIncomePlan({ ...plan, reconcile: { tolerance: Number(tolerance) || 0 } }, external),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [PLAN_KEY] }),
    onError: () => toast.error(t("spending:plan.saveFailed")),
  });
  if (!data) return isLoading ? <Skeleton className="h-40 w-full" /> : null;
  const tol = Number(tolerance) || 0;
  const ok = Math.abs(data.difference) <= tol;
  const line = (label: string, v: number, opts?: { strong?: boolean; minus?: boolean; cls?: string }) => (
    <div className="flex items-center justify-between text-xs">
      <span className={opts?.strong ? "text-foreground font-medium" : "text-muted-foreground"}>{label}</span>
      <span className={cn("tabular-nums", opts?.strong && "font-semibold", opts?.cls)}>
        {opts?.minus ? "− " : ""}
        <PrivacyAmount value={v} currency={data.currency} />
      </span>
    </div>
  );
  const rows = (list: Reconcile["cash"]) =>
    list.map((r) => (
      <div
        key={r.account.id}
        className={cn("flex items-center justify-between text-xs", r.excluded && "text-muted-foreground line-through")}
      >
        <span>{r.account.name}</span>
        <span className="tabular-nums">
          <PrivacyAmount value={r.balance} currency={data.currency} />
        </span>
      </div>
    ));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className={cn(CARD, "space-y-1.5 p-4")}>
        <h3 className="text-foreground mb-2 text-sm font-semibold">{t("spending:reconcile.title")}</h3>
        {line(t("spending:reconcile.liquidity"), data.liquidity, { strong: true })}
        {line(t("spending:reconcile.cardDebt"), data.cardDebt, { minus: true })}
        {line(t("spending:reconcile.msiRemaining"), data.msiRemaining, { minus: true })}
        {line(t("spending:reconcile.envelopes"), data.envelopes, { minus: true })}
        <div className="border-border/40 border-t pt-1.5">
          {line(t("spending:reconcile.difference"), data.difference, {
            strong: true,
            cls: ok ? "text-success" : "text-destructive",
          })}
        </div>
        <p className="text-muted-foreground pt-1 text-2xs">
          {ok ? t("spending:reconcile.okHint") : t("spending:reconcile.offHint")}
        </p>
        <div className="flex items-center gap-2 pt-2">
          <span className="text-muted-foreground text-xs">{t("spending:reconcile.tolerance")}</span>
          <Input
            type="number"
            step="0.01"
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            className="h-7 w-24 text-end text-xs"
          />
          <Button size="sm" variant="outline" onClick={() => saveTolerance.mutate()} disabled={saveTolerance.isPending}>
            {t("common:save")}
          </Button>
        </div>
      </section>
      <section className={cn(CARD, "space-y-1.5 p-4")}>
        <h3 className="text-foreground mb-2 text-sm font-semibold">{t("spending:reconcile.float")}</h3>
        {line(t("spending:reconcile.liquidity"), data.liquidity)}
        {line(t("spending:reconcile.taxEnvelope"), data.liquidity - data.float - data.cardDebt, { minus: true })}
        {line(t("spending:reconcile.cardDebt"), data.cardDebt, { minus: true })}
        {line(t("spending:reconcile.float"), data.float, { strong: true })}
      </section>
      <section className={cn(CARD, "space-y-1 p-4")}>
        <h3 className="text-foreground mb-2 text-sm font-semibold">{t("spending:reconcile.liquidity")}</h3>
        {rows(data.cash)}
        <p className="text-muted-foreground pt-1 text-2xs">{t("spending:reconcile.excludedHint")}</p>
      </section>
      <section className={cn(CARD, "space-y-1 p-4")}>
        <h3 className="text-foreground mb-2 text-sm font-semibold">{t("spending:reconcile.cardDebt")}</h3>
        {rows(data.cards)}
      </section>
      <div className="lg:col-span-2">
        <FxPendingCard currency={data.currency} />
      </div>
    </div>
  );
}
