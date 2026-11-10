/**
 * Tiny expression evaluator for the income plan: numbers, + - * /, parentheses,
 * round(x, n), floor(x, n), and dotted references such as `gross.salary_tc`,
 * `net.salary_vt`, `uma.monthly`. Lines are evaluated in dependency order; a
 * cycle or an unknown reference marks the line with an error instead of a value.
 */

export type PlanBlock = "gross" | "net" | "base";
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

/** Quincenas per basis: the quincena is the stored unit, 2 decimals. */
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

export function toValue(raw: number, basis: PlanBasis): PlanValue {
  const quincena = round2(raw / BASIS_FACTOR[basis]);
  return { raw, quincena, monthly: round2(quincena * 2), annual: round2(quincena * 24) };
}

/** Evaluate every line; references see the referenced line in its own basis. */
export function evaluatePlan(plan: IncomePlan): EvaluatedLine[] {
  const byRef = new Map<string, PlanLine>();
  for (const l of plan.lines) byRef.set(`${l.block}.${l.key}`, l);
  const constants = new Map(plan.constants.map((c) => [c.key, c.value]));
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
      const v = toValue(raw, line.basis);
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
    try {
      return { line, value: resolve(ref), error: null };
    } catch (e) {
      return { line, value: null, error: errors.get(ref) ?? (e as Error).message };
    }
  });
}

export const sumQuincena = (rows: EvaluatedLine[]) =>
  round2(rows.reduce((s, r) => s + (r.value?.quincena ?? 0), 0));
