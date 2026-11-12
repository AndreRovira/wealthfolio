import { resolvePlan, type IncomePlan } from "../lib/plan-eval";

/** Stored as one JSON document; the server only reads `resolved` from it. */
export interface IncomePlanDocument extends IncomePlan {
  paycheck?: { ruleId: string | null; remainderEnvelopeId: string | null };
  reconcile?: { tolerance: number };
  /** Annual rate in percent each liquid account pays, by account id. */
  liquidity?: { rates: Record<string, number> };
  /** Evaluated quincena values, rewritten on every save. See `resolvePlan`. */
  resolved?: Record<string, number>;
}

import { request as send } from "./request";

const URL = "/api/v1/spending/income-plan";

const request = <T>(method: string, body?: unknown) => send<T>(method, URL, body);

export const EMPTY_PLAN: IncomePlanDocument = { lines: [], constants: [] };

export async function getIncomePlan(): Promise<IncomePlanDocument> {
  const doc = await request<IncomePlanDocument | null>("GET");
  return doc && Array.isArray(doc.lines) ? doc : EMPTY_PLAN;
}

/** `external` is what the editor evaluates with, so the saved values match what it shows. */
export const saveIncomePlan = (doc: IncomePlanDocument, external: Record<string, number> = {}) =>
  request<IncomePlanDocument>("PUT", { ...doc, resolved: resolvePlan(doc, external) });
