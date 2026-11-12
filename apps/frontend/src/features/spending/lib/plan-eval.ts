/**
 * Tiny expression evaluator for the income plan: numbers, + - * /, parentheses,
 * round(x, n), floor(x, n), and dotted references such as `gross.salary_tc`,
 * `net.salary_vt`, `uma.monthly`. Lines are evaluated in dependency order; a
 * cycle or an unknown reference marks the line with an error instead of a value.
 */

export type PlanBlock = "gross" | "net" | "base" | "savings";
export type PlanBasis = "quincena" | "monthly" | "annual";

export interface PlanLine {
  id: string;
  block: PlanBlock;
  key: string;
  name: string;
  basis: PlanBasis;
  /** Fixed amount in `basis`; ignored when `formula` is set. */
  amount: number | null;
  /** Expression in `basis`; references resolve in the referenced line's own basis. */
  formula: string | null;
  /** Net-base lines that make up the paycheck deposit. */
  inPaycheck: boolean;
  sortOrder: number;
}

export interface PlanConstant {
  key: string;
  value: number;
  label: string;
}

export interface IncomePlan {
  lines: PlanLine[];
  constants: PlanConstant[];
}

/** Quincenas per basis. */
export const BASIS_FACTOR: Record<PlanBasis, number> = { quincena: 1, monthly: 2, annual: 24 };

export const round2 = (v: number) => Math.round(v * 100) / 100;

export interface PlanValue {
  /** Value in the line's own basis, as computed. */
  raw: number;
  quincena: number;
  monthly: number;
  annual: number;
}

export interface EvaluatedLine {
  line: PlanLine;
  value: PlanValue | null;
  error: string | null;
}

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
    } else if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) throw new Error(`bad number ${src.slice(i, j)}`);
      out.push({ t: "num", v });
      i = j;
    } else if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z0-9_.]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
    } else if ("+-*/".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else if (c === "(") {
      out.push({ t: "lp" });
      i++;
    } else if (c === ")") {
      out.push({ t: "rp" });
      i++;
    } else if (c === ",") {
      out.push({ t: "comma" });
      i++;
    } else if (c === "%") {
      // `2.5%` reads as 0.025, like the spreadsheet.
      const last = out[out.length - 1];
      if (!last || last.t !== "num") throw new Error("% needs a number before it");
      last.v /= 100;
      i++;
    } else {
      throw new Error(`unexpected '${c}'`);
    }
  }
  return out;
}

/** Dotted names a formula refers to, for dependency ordering. */
export function references(formula: string): string[] {
  try {
    return tokenize(formula)
      .filter((t): t is { t: "id"; v: string } => t.t === "id" && t.v.includes("."))
      .map((t) => t.v);
  } catch {
    return [];
  }
}

function evaluate(src: string, lookup: (name: string) => number): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expr = (): number => {
    let v = term();
    while (peek()?.t === "op" && (peek() as { v: string }).v.match(/[+-]/)) {
      const op = (next() as { v: string }).v;
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (peek()?.t === "op" && (peek() as { v: string }).v.match(/[*/]/)) {
      const op = (next() as { v: string }).v;
      const r = unary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const unary = (): number => {
    if (peek()?.t === "op" && (peek() as { v: string }).v === "-") {
      next();
      return -unary();
    }
    return atom();
  };
  const atom = (): number => {
    const t = next();
    if (!t) throw new Error("unexpected end");
    if (t.t === "num") return t.v;
    if (t.t === "lp") {
      const v = expr();
      if (next()?.t !== "rp") throw new Error("missing )");
      return v;
    }
    if (t.t === "id") {
      if (peek()?.t === "lp") {
        next();
        const args: number[] = [expr()];
        while (peek()?.t === "comma") {
          next();
          args.push(expr());
        }
        if (next()?.t !== "rp") throw new Error("missing )");
        const n = args[1] ?? 0;
        const k = 10 ** n;
        if (t.v === "round") return Math.round(args[0] * k) / k;
        if (t.v === "floor") return Math.floor(args[0] * k) / k;
        if (t.v === "ceil") return Math.ceil(args[0] * k) / k;
        throw new Error(`unknown function ${t.v}`);
      }
      return lookup(t.v);
    }
    throw new Error("unexpected token");
  };
  const v = expr();
  if (p !== toks.length) throw new Error("trailing input");
  if (!Number.isFinite(v)) throw new Error("not a number");
  return v;
}

/**
 * Prorated blocks keep full precision in every column, like the spreadsheet.
 * Net base is what actually gets paid, so its quincena rounds to 2 decimals
 * and the other columns follow from that.
 */
export function toValue(raw: number, basis: PlanBasis, exact: boolean): PlanValue {
  const q = raw / BASIS_FACTOR[basis];
  const quincena = exact ? q : round2(q);
  return { raw, quincena, monthly: quincena * 2, annual: quincena * 24 };
}

/**
 * Evaluate every line; references see the referenced line in its own basis.
 * `external` adds live figures from outside the plan (bill shares, envelope
 * funding, liquidity income) that formulas read like constants.
 */
export function evaluatePlan(
  plan: IncomePlan,
  external: Record<string, number> = {},
): EvaluatedLine[] {
  const byRef = new Map<string, PlanLine>();
  // Two lines under one key would both show the later one's value and count twice.
  const dupes = new Set<string>();
  for (const l of plan.lines) {
    const ref = `${l.block}.${l.key}`;
    if (byRef.has(ref)) dupes.add(ref);
    byRef.set(ref, l);
  }
  const constants = new Map([
    ...Object.entries(external),
    ...plan.constants.map((c) => [c.key, c.value] as [string, number]),
  ]);
  const values = new Map<string, PlanValue>();
  const errors = new Map<string, string>();
  const visiting = new Set<string>();

  const resolve = (ref: string): PlanValue => {
    const hit = values.get(ref);
    if (hit) return hit;
    if (errors.has(ref)) throw new Error(`${ref}: ${errors.get(ref)}`);
    const line = byRef.get(ref);
    if (!line) throw new Error(`unknown ${ref}`);
    if (visiting.has(ref)) throw new Error(`cycle at ${ref}`);
    visiting.add(ref);
    try {
      const raw =
        line.formula && line.formula.trim()
          ? evaluate(line.formula, (name) => {
              if (constants.has(name)) return constants.get(name)!;
              if (name.includes(".")) return resolve(name).raw;
              throw new Error(`unknown ${name}`);
            })
          : (line.amount ?? 0);
      const v = toValue(raw, line.basis, line.block !== "base");
      values.set(ref, v);
      return v;
    } catch (e) {
      errors.set(ref, (e as Error).message);
      throw e;
    } finally {
      visiting.delete(ref);
    }
  };

  return plan.lines.map((line) => {
    const ref = `${line.block}.${line.key}`;
    if (dupes.has(ref)) return { line, value: null, error: `duplicate ${ref}` };
    try {
      return { line, value: resolve(ref), error: null };
    } catch (e) {
      return { line, value: null, error: errors.get(ref) ?? (e as Error).message };
    }
  });
}

export const sumQuincena = (rows: EvaluatedLine[]) =>
  round2(rows.reduce((s, r) => s + (r.value?.quincena ?? 0), 0));

/** Key under which the expected net paycheck travels to the server. */
export const PLAN_EXPECTED_KEY = "paycheck.expected";

/** Quincena total of the net-base lines that make up the paycheck deposit. */
export const expectedPaycheck = (rows: EvaluatedLine[]) =>
  sumQuincena(rows.filter((r) => r.line.block === "base" && r.line.inPaycheck));

/**
 * Per-quincena value of every line plus the expected paycheck, in cents. Saved
 * with the plan so the server can fill rule lines that point at the plan
 * without evaluating formulas itself.
 */
export function resolvePlan(
  plan: IncomePlan,
  external: Record<string, number> = {},
): Record<string, number> {
  const rows = evaluatePlan(plan, external);
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.value) out[`${r.line.block}.${r.line.key}`] = round2(r.value.quincena);
  }
  out[PLAN_EXPECTED_KEY] = expectedPaycheck(rows);
  return out;
}

/**
 * What the liquid accounts earn: balance x annual rate / 12 per account. The
 * total and the weighted rate cover only accounts that have a rate (percent),
 * so an account nobody rated does not drag the average down.
 */
export function liquidityYield(rows: { balance: number; rate?: number | null }[]) {
  let total = 0;
  let annual = 0;
  for (const r of rows) {
    if (r.rate == null) continue;
    total += r.balance;
    annual += (r.balance * r.rate) / 100;
  }
  return { total: round2(total), income: annual / 12, rate: total ? (annual / total) * 100 : 0 };
}
