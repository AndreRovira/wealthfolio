import { useTranslation } from "react-i18next";

import { PrivacyAmount } from "@wealthfolio/ui";

import { cn } from "@/lib/utils";

import { SPENDING_THEME } from "../lib/theme";
import type { EnvelopeSnapshot, FundingRule } from "../types/envelopes";

const CARD = "bg-card border-border/60 rounded-xl border shadow-sm";

/** Rules with fixed lines are the paycheck plan: net in, lines out, rest over. */
function planRules(snapshot: EnvelopeSnapshot) {
  return snapshot.rules.filter(
    (r) => r.active && r.splits.some((s) => s.amount != null),
  );
}

function PlanRows({ rule, snapshot }: { rule: FundingRule; snapshot: EnvelopeSnapshot }) {
  const { t } = useTranslation();
  const name = (id: string) =>
    snapshot.envelopes.find((e) => e.envelope.id === id)?.envelope.name ?? id;
  // Each envelope keeps the colour it has on the envelopes page.
  const color = (id: string) =>
    snapshot.envelopes.find((e) => e.envelope.id === id)?.envelope.color ?? SPENDING_THEME.deep;
  const fixedByEnvelope = new Map<string, number>();
  for (const s of rule.splits) {
    // Components can be negative (vouchers paid outside the deposit).
    if (s.amount != null) {
      fixedByEnvelope.set(s.envelopeId, (fixedByEnvelope.get(s.envelopeId) ?? 0) + (s.amount ?? 0));
    }
  }
  const expected = [...fixedByEnvelope.values()].reduce((a, b) => a + b, 0);
  const surplus = rule.splits.filter((s) => s.amount == null && (s.percent ?? 0) > 0);
  const row = (
    label: string,
    value: number | null,
    opts?: { strong?: boolean; minus?: boolean; dot?: string },
  ) => (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className={cn(opts?.strong ? "text-foreground font-medium" : "text-muted-foreground")}>
        {opts?.dot && (
          <span
            className="me-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
            style={{ backgroundColor: opts.dot }}
          />
        )}
        {label}
      </span>
      {value !== null && (
        <span className={cn("tabular-nums", opts?.strong && "font-semibold")}>
          {opts?.minus ? "− " : ""}
          <PrivacyAmount value={value} currency={snapshot.currency} />
        </span>
      )}
    </div>
  );
  return (
    <div className="space-y-1 px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-foreground text-sm font-semibold">{rule.name}</span>
        <span className="text-muted-foreground text-2xs">
          {rule.cadence === "on_income"
            ? t("spending:envelopes.plan.perDeposit")
            : t("spending:envelopes.plan.perPeriod")}
        </span>
      </div>
      {row(t("spending:envelopes.plan.expected"), expected, { strong: true })}
      {[...fixedByEnvelope.entries()]
        .filter(([, amount]) => amount !== 0)
        .map(([id, amount]) => (
          <div key={id}>{row(name(id), amount, { minus: true, dot: color(id) })}</div>
        ))}
      <div className="border-border/40 mt-1.5 border-t pt-1.5">
        {surplus.length > 0 &&
          row(
            `${t("spending:envelopes.plan.surplus")}: ${surplus
              .map((s) => `${name(s.envelopeId)} ${s.percent}%`)
              .join(" · ")}`,
            null,
          )}
        {rule.cadence === "on_income" &&
          row(
            `${t("spending:envelopes.plan.shortfall")}: ${
              rule.shortfallEnvelopeId
                ? name(rule.shortfallEnvelopeId)
                : t("spending:envelopes.plan.none")
            }`,
            null,
          )}
      </div>
    </div>
  );
}

/** The paycheck arithmetic the spreadsheet used to hold, read from the rules. */
export function PaycheckPlanCard({ snapshot }: { snapshot: EnvelopeSnapshot }) {
  const { t } = useTranslation();
  const rules = planRules(snapshot);
  if (rules.length === 0) return null;
  return (
    <section className={cn(CARD, "divide-border/40 divide-y")}>
      <div className="text-muted-foreground px-4 pt-3 text-2xs uppercase tracking-wide">
        {t("spending:envelopes.plan.title")}
      </div>
      {rules.map((r) => (
        <PlanRows key={r.id} rule={r} snapshot={snapshot} />
      ))}
    </section>
  );
}
