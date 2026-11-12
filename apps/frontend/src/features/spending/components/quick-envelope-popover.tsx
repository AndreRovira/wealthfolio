import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@wealthfolio/ui";

import { useTaxonomy } from "@/hooks/use-taxonomies";
import { cn } from "@/lib/utils";

import { setActivityEnvelope } from "../adapters/envelopes";
import { ENVELOPES_KEY, useEnvelopeSnapshot } from "../hooks/use-envelopes";
import { invalidateSpendingCaches } from "../lib/invalidation";
import type { ActivityEnvelope, EnvelopeSnapshot } from "../types/envelopes";

const SPENDING_TAXONOMY = "spending_categories";
const SAVINGS_TAXONOMY = "savings_categories";

/** The pot a category feeds through the links: its own, else the nearest linked ancestor. */
function potForCategory(
  categoryId: string | null,
  snapshot: EnvelopeSnapshot | undefined,
  parents: Map<string, string | null>,
): { envelopeId: string; billId: string | null } | null {
  if (!categoryId || !snapshot) return null;
  const byCategory = new Map<string, { envelopeId: string; billId: string | null }>();
  for (const e of snapshot.envelopes) {
    e.linkedCategoryIds.forEach((id) =>
      byCategory.set(id, { envelopeId: e.envelope.id, billId: null }),
    );
    for (const b of e.bills) {
      b.linkedCategoryIds.forEach((id) =>
        byCategory.set(id, { envelopeId: e.envelope.id, billId: b.bill.id }),
      );
    }
  }
  let current: string | null = categoryId;
  for (let i = 0; i < 32 && current; i++) {
    const hit = byCategory.get(current);
    if (hit) return hit;
    current = parents.get(current) ?? null;
  }
  return null;
}

function potLabel(
  snapshot: EnvelopeSnapshot | undefined,
  pot: { envelopeId: string; billId: string | null } | null,
) {
  if (!pot || !snapshot) return null;
  const e = snapshot.envelopes.find((x) => x.envelope.id === pot.envelopeId);
  if (!e) return null;
  const bill = pot.billId ? e.bills.find((b) => b.bill.id === pot.billId)?.bill.name : null;
  return bill ? `${e.envelope.name} · ${bill}` : e.envelope.name;
}

/** Read the pin stored in activity metadata, if any. */
export function readActivityEnvelope(
  metadata: Record<string, unknown> | undefined,
): ActivityEnvelope | null {
  const raw = metadata?.envelope;
  if (!raw || typeof raw !== "object") return null;
  const v = raw as { envelopeId?: string | null; billId?: string | null };
  return { envelopeId: v.envelopeId ?? null, billId: v.billId ?? null };
}

export interface QuickEnvelopePopoverProps {
  activityId: string;
  categoryId: string | null;
  metadata: Record<string, unknown> | undefined;
  /** Spending, or a move to an investing account, shows the pot it draws from. */
  isExpense: boolean;
  /**
   * Income shows whether the deposit is split by its rule or kept out of the
   * envelopes (money they already counted, such as an expected credit).
   */
  isIncome?: boolean;
  /** The account's meta: one kept out of the envelopes shows no pot. */
  accountMeta?: string | null;
  className?: string;
}

function skipsEnvelopes(meta: string | null | undefined) {
  try {
    return meta ? JSON.parse(meta).envelopesExcluded === true : false;
  } catch {
    return false;
  }
}

/** Which pot a transaction draws from: the category's link by default, or a pin. */
export function QuickEnvelopePopover({
  activityId,
  categoryId,
  metadata,
  isExpense,
  isIncome = false,
  accountMeta,
  className,
}: QuickEnvelopePopoverProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const snapshot = useEnvelopeSnapshot();
  const taxonomy = useTaxonomy(SPENDING_TAXONOMY);
  // A move to an investing account picks its pot through a savings category.
  const savings = useTaxonomy(SAVINGS_TAXONOMY);
  const parents = useMemo(
    () =>
      new Map(
        [...(taxonomy.data?.categories ?? []), ...(savings.data?.categories ?? [])].map((c) => [
          c.id,
          c.parentId ?? null,
        ]),
      ),
    [taxonomy.data?.categories, savings.data?.categories],
  );
  const pin = readActivityEnvelope(metadata);
  const auto = potForCategory(categoryId, snapshot.data, parents);
  const effective = pin
    ? pin.envelopeId
      ? { envelopeId: pin.envelopeId, billId: pin.billId }
      : null
    : auto;
  const excluded = pin !== null && !pin.envelopeId;
  const label = isIncome
    ? excluded
      ? null
      : t("spending:envelopes.incomeByRule")
    : potLabel(snapshot.data, effective);

  const save = useMutation({
    mutationFn: (envelope: ActivityEnvelope | null) => setActivityEnvelope(activityId, envelope),
    onSuccess: () => {
      invalidateSpendingCaches(qc);
      void qc.invalidateQueries({ queryKey: [ENVELOPES_KEY] });
    },
    onError: () => toast.error(t("spending:envelopes.pinFailed")),
  });

  if ((!isExpense && !isIncome) || skipsEnvelopes(accountMeta)) return null;

  const choose = (envelope: ActivityEnvelope | null) => {
    save.mutate(envelope);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("spending:envelopes.pickPot")}
            className={cn(
              "hover:bg-muted/60 inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs transition-colors",
              (isIncome ? excluded : pin) ? "text-foreground" : "text-muted-foreground",
              className,
            )}
          />
        }
      >
        <Icons.Wallet className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="truncate">
          {label ?? t("spending:envelopes.noPot")}
          {(isIncome ? excluded : pin) && (
            <span className="text-muted-foreground"> · {t("spending:envelopes.pinned")}</span>
          )}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={t("spending:envelopes.pickPot")} />
          <CommandList>
            <CommandEmpty>{t("spending:envelopes.noPot")}</CommandEmpty>
            <CommandGroup>
              <CommandItem value="__auto" onSelect={() => choose(null)}>
                <Icons.Refresh className="me-2 h-3.5 w-3.5" />
                {isIncome
                  ? t("spending:envelopes.incomeByRule")
                  : t("spending:envelopes.autoByCategory")}
                {!isIncome && auto && (
                  <span className="text-muted-foreground ms-1 truncate">
                    · {potLabel(snapshot.data, auto)}
                  </span>
                )}
                {(isIncome ? !excluded : !pin) && <Icons.Check className="ms-auto h-3.5 w-3.5" />}
              </CommandItem>
              <CommandItem
                value="__none"
                onSelect={() => choose({ envelopeId: null, billId: null })}
              >
                <Icons.X className="me-2 h-3.5 w-3.5" />
                {t("spending:envelopes.noPot")}
                {excluded && <Icons.Check className="ms-auto h-3.5 w-3.5" />}
              </CommandItem>
            </CommandGroup>
            {!isIncome && <CommandSeparator />}
            {(isIncome ? [] : (snapshot.data?.envelopes ?? [])).map((e) => (
              <CommandGroup key={e.envelope.id} heading={e.envelope.name}>
                <CommandItem
                  value={e.envelope.name}
                  onSelect={() => choose({ envelopeId: e.envelope.id, billId: null })}
                >
                  {e.envelope.name}
                  {pin?.envelopeId === e.envelope.id && !pin.billId && (
                    <Icons.Check className="ms-auto h-3.5 w-3.5" />
                  )}
                </CommandItem>
                {e.bills.map((b) => (
                  <CommandItem
                    key={b.bill.id}
                    value={`${e.envelope.name} ${b.bill.name}`}
                    onSelect={() => choose({ envelopeId: e.envelope.id, billId: b.bill.id })}
                    className="ps-6"
                  >
                    {b.bill.name}
                    {pin?.billId === b.bill.id && <Icons.Check className="ms-auto h-3.5 w-3.5" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
