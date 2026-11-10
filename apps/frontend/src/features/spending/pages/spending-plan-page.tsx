import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Button,
  Checkbox,
  Icons,
  Input,
  Page,
  PageContent,
  PageHeader,
  PrivacyAmount,
  ResponsiveSelect,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@wealthfolio/ui";

import { cn } from "@/lib/utils";

import { getIncomePlan, saveIncomePlan, type IncomePlanDocument } from "../adapters/income-plan";
import { FxPendingCard } from "../components/fx-pending-card";
import { PaycheckPlanCard } from "../components/paycheck-plan-card";
import { useEnvelopeMutations, useEnvelopeSnapshot } from "../hooks/use-envelopes";
import { useReconcile, type Reconcile } from "../hooks/use-reconcile";
import {
  evaluatePlan,
  round2,
  sumQuincena,
  type EvaluatedLine,
  type PlanBasis,
  type PlanBlock,
  type PlanLine,
} from "../lib/plan-eval";
import type { BillBalance, EnvelopeSnapshot } from "../types/envelopes";

const CARD = "bg-card border-border/60 rounded-xl border shadow-sm";
const PLAN_KEY = "spending_income_plan";
const BLOCKS: PlanBlock[] = ["gross", "net", "base"];
const BASES: PlanBasis[] = ["quincena", "monthly", "annual"];

const newId = () => Math.random().toString(36).slice(2, 10);
const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** The plan page: the spreadsheet's income block, the paycheck split, and bills annualized. */
export default function SpendingPlanPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "income";
  const snapshot = useEnvelopeSnapshot();
  const planQuery = useQuery({ queryKey: [PLAN_KEY], queryFn: getIncomePlan });

  return (
    <Page>
      <PageHeader
        heading={t("spending:plan.heading")}
        text={t("spending:plan.subheading")}
        onBack={() => navigate("/spending/envelopes")}
        actions={
          <Button variant="ghost" size="sm" onClick={() => navigate("/spending/envelopes")}>
            <Icons.Wallet className="me-1.5 h-3.5 w-3.5" />
            {t("spending:envelopes.heading")}
          </Button>
        }
      />
      <PageContent className="space-y-4">
        <Tabs value={tab} onValueChange={(v) => setParams({ tab: String(v) })}>
          <TabsList className="flex w-full max-w-lg overflow-x-auto sm:grid sm:grid-cols-4">
            <TabsTrigger value="income" className="shrink-0">{t("spending:plan.tabIncome")}</TabsTrigger>
            <TabsTrigger value="paycheck" className="shrink-0">{t("spending:plan.tabPaycheck")}</TabsTrigger>
            <TabsTrigger value="bills" className="shrink-0">{t("spending:plan.tabBills")}</TabsTrigger>
            <TabsTrigger value="reconcile" className="shrink-0">{t("spending:plan.tabReconcile")}</TabsTrigger>
          </TabsList>
          <TabsContent value="income" className="mt-4">
            {planQuery.data ? (
              <IncomeEditor initial={planQuery.data} />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </TabsContent>
          <TabsContent value="paycheck" className="mt-4">
            {snapshot.data && planQuery.data ? (
              <PaycheckTab snapshot={snapshot.data} plan={planQuery.data} />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </TabsContent>
          <TabsContent value="bills" className="mt-4">
            {snapshot.data ? <BillsTab snapshot={snapshot.data} /> : <Skeleton className="h-40 w-full" />}
          </TabsContent>
          <TabsContent value="reconcile" className="mt-4">
            {planQuery.data ? <ReconcileTab plan={planQuery.data} /> : <Skeleton className="h-40 w-full" />}
          </TabsContent>
        </Tabs>
      </PageContent>
    </Page>
  );
}

// ----------------------------- income -----------------------------

function IncomeEditor({ initial }: { initial: IncomePlanDocument }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [doc, setDoc] = useState<IncomePlanDocument>(initial);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDoc(initial);
    setDirty(false);
  }, [initial]);
  const rows = useMemo(() => evaluatePlan(doc), [doc]);
  const currency = useEnvelopeSnapshot().data?.currency ?? "MXN";
  const save = useMutation({
    mutationFn: () => saveIncomePlan(doc),
    onSuccess: () => {
      setDirty(false);
      void qc.invalidateQueries({ queryKey: [PLAN_KEY] });
      toast.success(t("spending:plan.saved"));
    },
    onError: () => toast.error(t("spending:plan.saveFailed")),
  });

  const update = (fn: (d: IncomePlanDocument) => IncomePlanDocument) => {
    setDoc((d) => fn(d));
    setDirty(true);
  };
  const setLine = (id: string, patch: Partial<PlanLine>) =>
    update((d) => ({ ...d, lines: d.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
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
        {dirty && <span className="text-muted-foreground text-xs">{t("spending:plan.unsaved")}</span>}
        <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          <Icons.Check className="me-1.5 h-3.5 w-3.5" />
          {t("common:save")}
        </Button>
      </div>
      {BLOCKS.map((block) => {
        const blockRows = rows
          .filter((r) => r.line.block === block)
          .sort((a, b) => (b.value?.annual ?? -1) - (a.value?.annual ?? -1));
        const total = sumQuincena(blockRows);
        return (
          <section key={block} className={cn(CARD, "overflow-x-auto")}>
            <div className="flex items-center justify-between px-4 pt-3">
              <h3 className="text-foreground text-sm font-semibold">
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
                  <PrivacyAmount value={round2(total * 24)} currency={currency} />
                </span>
              </div>
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
                    <PrivacyAmount value={round2(total * 2)} currency={currency} />
                  </td>
                  <td className="px-2 py-2 text-end tabular-nums">
                    <PrivacyAmount value={round2(total * 24)} currency={currency} />
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </section>
        );
      })}
      <ConstantsEditor
        doc={doc}
        onChange={(constants) => update((d) => ({ ...d, constants }))}
      />
      <p className="text-muted-foreground text-2xs">{t("spending:plan.formulaHelp")}</p>
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
            const name = e.target.value;
            onChange({ name, key: line.key.startsWith("line_") || line.key === slug(line.name) ? slug(name) || line.key : line.key });
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

/** Mobile layout of a plan line: inputs stacked, the three figures underneath. */
function LineCard({
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
            const name = e.target.value;
            onChange({ name, key: line.key.startsWith("line_") || line.key === slug(line.name) ? slug(name) || line.key : line.key });
          }}
        />
        <ResponsiveSelect
          value={line.basis}
          onValueChange={(v) => onChange({ basis: v as PlanBasis })}
          options={BASES.map((b) => ({ value: b, label: t(`spending:plan.basis_${b}`) }))}
          triggerClassName="h-8 w-28 text-xs"
        />
        <button type="button" className="text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label={t("common:delete")}>
          <Icons.Trash className="h-4 w-4" />
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
          <div key={i} className="flex items-center gap-2">
            <Input
              value={c.key}
              className="h-7 w-44 font-mono text-xs"
              onChange={(e) => set(i, { key: e.target.value.trim() })}
            />
            <Input
              type="number"
              step="0.01"
              value={c.value}
              className="h-7 w-32 text-end text-xs tabular-nums"
              onChange={(e) => set(i, { value: Number(e.target.value) })}
            />
            <Input
              value={c.label}
              placeholder={t("spending:plan.constantLabel")}
              className="h-7 flex-1 text-xs"
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

function PaycheckTab({ snapshot, plan }: { snapshot: EnvelopeSnapshot; plan: IncomePlanDocument }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const m = useEnvelopeMutations();
  const rows = useMemo(() => evaluatePlan(plan), [plan]);
  const expected = sumQuincena(rows.filter((r) => r.line.block === "base" && r.line.inPaycheck));
  const rules = snapshot.rules.filter((r) => r.active && r.splits.some((s) => (s.amount ?? 0) > 0));
  const rule = rules.find((r) => r.id === plan.paycheck?.ruleId) ?? rules[0];
  const [remainderId, setRemainderId] = useState(plan.paycheck?.remainderEnvelopeId ?? "");
  const remainder = remainderId || null;
  const fixedOthers = rule
    ? round2(
        rule.splits
          .filter((s) => (s.amount ?? 0) > 0 && !(s.envelopeId === remainder && !s.billId))
          .reduce((s, x) => s + (x.amount ?? 0), 0),
      )
    : 0;
  const currentRemainder = rule
    ? round2(
        rule.splits
          .filter((s) => s.envelopeId === remainder && !s.billId && (s.amount ?? 0) > 0)
          .reduce((s, x) => s + (x.amount ?? 0), 0),
      )
    : 0;
  const shouldBe = round2(expected - fixedOthers);
  const diff = round2(shouldBe - currentRemainder);
  const envelopeName = (id: string | null) =>
    snapshot.envelopes.find((e) => e.envelope.id === id)?.envelope.name ?? "";

  const apply = useMutation({
    mutationFn: async () => {
      if (!rule || !remainder) return;
      const splits = rule.splits.map((s) =>
        s.envelopeId === remainder && !s.billId && (s.amount ?? 0) > 0 ? { ...s, amount: shouldBe } : s,
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
          splits,
          active: rule.active,
        },
      });
      await saveIncomePlan({ ...plan, paycheck: { ruleId: rule.id, remainderEnvelopeId: remainder } });
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
            {Math.abs(diff) >= 0.01 ? (
              <div className="flex items-center justify-between pt-1">
                <span className="text-warning text-xs">
                  {t("spending:plan.offBy")} <PrivacyAmount value={diff} currency={snapshot.currency} />
                </span>
                <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending || !rule}>
                  {t("spending:plan.applyToRule")}
                </Button>
              </div>
            ) : (
              <div className="text-success pt-1 text-xs">{t("spending:plan.inSync")}</div>
            )}
          </>
        )}
        {expected === 0 && (
          <p className="text-muted-foreground pt-1 text-2xs">{t("spending:plan.flagLinesHint")}</p>
        )}
      </section>
      <PaycheckPlanCard snapshot={snapshot} />
    </div>
  );
}

// ----------------------------- bills -----------------------------

function cycleMonths(cycle: string) {
  const c = cycle.trim();
  if (c === "monthly") return 1;
  if (c === "yearly") return 12;
  const n = Number(c.split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function BillsTab({ snapshot }: { snapshot: EnvelopeSnapshot }) {
  const { t } = useTranslation();
  const currency = snapshot.currency;
  const rows = snapshot.envelopes
    .flatMap((e) => e.bills.map((b) => ({ b, envelope: e.envelope.name })))
    .map(({ b, envelope }) => {
      const quincena = round2(b.bill.expectedAmount / (cycleMonths(b.bill.cycle) * 2));
      return { b, envelope, quincena, monthly: round2(quincena * 2), annual: round2(quincena * 24) };
    })
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
              <td className="text-muted-foreground px-2 py-1.5 tabular-nums">{b.lastPayment ?? "—"}</td>
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

function ReconcileTab({ plan }: { plan: IncomePlanDocument }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading } = useReconcile();
  const [tolerance, setTolerance] = useState(String(plan.reconcile?.tolerance ?? 1));
  const saveTolerance = useMutation({
    mutationFn: () => saveIncomePlan({ ...plan, reconcile: { tolerance: Number(tolerance) || 0 } }),
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
        <div className="border-border/40 border-t pt-1.5">
          {line(t("spending:reconcile.billsDue30"), data.billsDue30, { minus: true })}
          {line(t("spending:reconcile.msiDue30"), data.msiDue30, { minus: true })}
          {line(t("spending:reconcile.float30"), data.float30, {
            strong: true,
            cls: data.float30 < 0 ? "text-destructive" : undefined,
          })}
        </div>
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
