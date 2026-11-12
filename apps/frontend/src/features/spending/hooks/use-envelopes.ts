import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import * as api from "../adapters/envelopes";
import type {
  ApplyIncomeInput,
  EntryInput,
  EnvelopeBillInput,
  EnvelopeCategoryLink,
  EnvelopeInput,
  FundingRuleInput,
  MoveInput,
} from "../types/envelopes";

export const ENVELOPES_KEY = "spending_envelopes";

export function useEnvelopeSnapshot(asOf?: string) {
  return useQuery({
    queryKey: [ENVELOPES_KEY, "snapshot", asOf ?? null],
    queryFn: () => api.getEnvelopeSnapshot(asOf),
  });
}

export function useEnvelopeEntries(envelopeId: string | null) {
  return useQuery({
    queryKey: [ENVELOPES_KEY, "entries", envelopeId],
    queryFn: () => api.listEntries(envelopeId ?? undefined),
    enabled: !!envelopeId,
  });
}

export function useEnvelopeMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [ENVELOPES_KEY] });
  const opts = (what: string) => ({
    onSuccess: invalidate,
    // The reason the server gives (a pot that may not go negative, a missing rule) beats a generic line.
    onError: (e: Error) => toast.error(e.message || `Failed to ${what}.`),
  });

  const all = {
    createEnvelope: useMutation({
      mutationFn: (i: EnvelopeInput) => api.createEnvelope(i),
      ...opts("create envelope"),
    }),
    updateEnvelope: useMutation({
      mutationFn: (a: { id: string; input: EnvelopeInput }) => api.updateEnvelope(a.id, a.input),
      ...opts("update envelope"),
    }),
    deleteEnvelope: useMutation({
      mutationFn: (id: string) => api.deleteEnvelope(id),
      ...opts("delete envelope"),
    }),
    replaceLinks: useMutation({
      mutationFn: (a: { id: string; links: EnvelopeCategoryLink[] }) =>
        api.replaceEnvelopeLinks(a.id, a.links),
      ...opts("save links"),
    }),
    createBill: useMutation({
      mutationFn: (i: EnvelopeBillInput) => api.createBill(i),
      ...opts("create bill"),
    }),
    updateBill: useMutation({
      mutationFn: (a: { id: string; input: EnvelopeBillInput }) => api.updateBill(a.id, a.input),
      ...opts("update bill"),
    }),
    deleteBill: useMutation({
      mutationFn: (id: string) => api.deleteBill(id),
      ...opts("delete bill"),
    }),
    markBillPaid: useMutation({
      mutationFn: (id: string) => api.markBillPaid(id),
      ...opts("mark bill paid"),
    }),
    addEntry: useMutation({
      mutationFn: (i: EntryInput) => api.addEntry(i),
      ...opts("save entry"),
    }),
    deleteEntry: useMutation({
      mutationFn: (id: string) => api.deleteEntry(id),
      ...opts("delete entry"),
    }),
    moveMoney: useMutation({
      mutationFn: (i: MoveInput) => api.moveMoney(i),
      ...opts("move money"),
    }),
    createRule: useMutation({
      mutationFn: (i: FundingRuleInput) => api.createRule(i),
      ...opts("create rule"),
    }),
    updateRule: useMutation({
      mutationFn: (a: { id: string; input: FundingRuleInput }) => api.updateRule(a.id, a.input),
      ...opts("update rule"),
    }),
    deleteRule: useMutation({
      mutationFn: (id: string) => api.deleteRule(id),
      ...opts("delete rule"),
    }),
    applyIncome: useMutation({
      mutationFn: (i: ApplyIncomeInput) => api.applyIncome(i),
      ...opts("apply income"),
    }),
  };
  // One flag for every save button: a second tap must not write twice.
  return { ...all, busy: Object.values(all).some((x) => x.isPending) };
}
