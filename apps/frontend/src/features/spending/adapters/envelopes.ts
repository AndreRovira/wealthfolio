// Envelopes are a fork feature served only by the web host, so this adapter
// talks to /api/v1 directly instead of going through the command table.
import { profileFetch } from "@/features/profiles/session";
import { notifyUnauthorized } from "@/lib/auth-token";

import type {
  ApplyIncomeInput,
  EntryInput,
  Envelope,
  EnvelopeBill,
  EnvelopeBillInput,
  EnvelopeCategoryLink,
  EnvelopeEntry,
  EnvelopeInput,
  EnvelopeSnapshot,
  FundingRule,
  FundingRuleInput,
  MoveInput,
} from "../types/envelopes";

const BASE = "/api/v1/spending/envelopes";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await profileFetch(`${BASE}${path}`, {
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
      // non-JSON error body
    }
    throw new Error(message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const getEnvelopeSnapshot = (asOf?: string) =>
  request<EnvelopeSnapshot>("GET", `/snapshot${asOf ? `?asOf=${asOf}` : ""}`);

export const createEnvelope = (input: EnvelopeInput) => request<Envelope>("POST", "", input);
export const updateEnvelope = (id: string, input: EnvelopeInput) =>
  request<Envelope>("PUT", `/${id}`, input);
export const deleteEnvelope = (id: string) => request<void>("DELETE", `/${id}`);
export const replaceEnvelopeLinks = (id: string, links: EnvelopeCategoryLink[]) =>
  request<void>("PUT", `/${id}/links`, links);

export const createBill = (input: EnvelopeBillInput) =>
  request<EnvelopeBill>("POST", "/bills", input);
export const updateBill = (id: string, input: EnvelopeBillInput) =>
  request<EnvelopeBill>("PUT", `/bills/${id}`, input);
export const deleteBill = (id: string) => request<void>("DELETE", `/bills/${id}`);

export const listEntries = (envelopeId?: string) =>
  request<EnvelopeEntry[]>("GET", `/entries${envelopeId ? `?envelopeId=${envelopeId}` : ""}`);
export const addEntry = (input: EntryInput) => request<EnvelopeEntry>("POST", "/entries", input);
export const deleteEntry = (id: string) => request<void>("DELETE", `/entries/${id}`);
export const moveMoney = (input: MoveInput) => request<EnvelopeEntry[]>("POST", "/move", input);

export const createRule = (input: FundingRuleInput) =>
  request<FundingRule>("POST", "/rules", input);
export const updateRule = (id: string, input: FundingRuleInput) =>
  request<FundingRule>("PUT", `/rules/${id}`, input);
export const deleteRule = (id: string) => request<void>("DELETE", `/rules/${id}`);
export const applyIncome = (input: ApplyIncomeInput) =>
  request<EnvelopeEntry[]>("POST", "/apply-income", input);
