import { profileFetch } from "@/features/profiles/session";
import { notifyUnauthorized } from "@/lib/auth-token";

import type { IncomePlan } from "../lib/plan-eval";

/** Stored as one JSON document; the server does not interpret it. */
export interface IncomePlanDocument extends IncomePlan {
  paycheck?: { ruleId: string | null; remainderEnvelopeId: string | null };
  reconcile?: { tolerance: number };
}

const URL = "/api/v1/spending/income-plan";

async function request<T>(method: string, body?: unknown): Promise<T> {
  const res = await profileFetch(URL, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 401) notifyUnauthorized();
  if (!res.ok) throw new Error(res.statusText);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export const EMPTY_PLAN: IncomePlanDocument = { lines: [], constants: [] };

export async function getIncomePlan(): Promise<IncomePlanDocument> {
  const doc = await request<IncomePlanDocument | null>("GET");
  return doc && Array.isArray(doc.lines) ? doc : EMPTY_PLAN;
}

export const saveIncomePlan = (doc: IncomePlanDocument) =>
  request<IncomePlanDocument>("PUT", doc);
