import { describe, expect, it } from "vitest";

import { evaluatePlan, type IncomePlan } from "./plan-eval";

const plan: IncomePlan = {
  constants: [{ key: "uma.monthly", value: 3519.3, label: "UMA monthly" }],
  lines: [
    { id: "1", block: "gross", key: "salary_vt", name: "Salary VT", basis: "monthly", amount: 100000, formula: null, inPaycheck: false, sortOrder: 0 },
    { id: "2", block: "net", key: "salary_vt", name: "Salary VT", basis: "monthly", amount: null, formula: "gross.salary_vt - gross.salary_vt * 2.5%", inPaycheck: false, sortOrder: 0 },
    { id: "3", block: "gross", key: "sunday", name: "Sunday", basis: "monthly", amount: 561.35, formula: null, inPaycheck: false, sortOrder: 1 },
    { id: "4", block: "net", key: "sunday", name: "Sunday", basis: "monthly", amount: null, formula: "floor(uma.monthly + (gross.sunday - uma.monthly) * 0.7, 1)", inPaycheck: false, sortOrder: 1 },
    { id: "5", block: "base", key: "salary_vt", name: "Salary VT", basis: "quincena", amount: null, formula: "net.salary_vt / 2", inPaycheck: true, sortOrder: 0 },
    { id: "6", block: "net", key: "loop", name: "Loop", basis: "monthly", amount: null, formula: "net.loop + 1", inPaycheck: false, sortOrder: 9 },
    { id: "7", block: "net", key: "bad", name: "Bad", basis: "monthly", amount: null, formula: "gross.nope * 2", inPaycheck: false, sortOrder: 9 },
  ],
};

describe("evaluatePlan", () => {
  const rows = evaluatePlan(plan);
  const by = (k: string) => rows.find((r) => `${r.line.block}.${r.line.key}` === k)!;

  it("derives quincena, monthly and annual with 2 decimals", () => {
    expect(by("net.salary_vt").value).toEqual({ raw: 97500, quincena: 48750, monthly: 97500, annual: 1170000 });
  });
  it("supports constants and floor like the spreadsheet", () => {
    // 3519.3 + (561.35 - 3519.3) * 0.7 = 1448.735 -> floor to 1 decimal
    expect(by("net.sunday").value?.raw).toBeCloseTo(1448.7, 5);
  });
  it("references other lines in their own basis", () => {
    expect(by("base.salary_vt").value?.quincena).toBe(48750);
  });
  it("flags cycles and unknown references", () => {
    expect(by("net.loop").error).toMatch(/cycle/);
    expect(by("net.bad").error).toMatch(/unknown gross.nope/);
  });
});
