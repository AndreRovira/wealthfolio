import { describe, expect, it } from "vitest";

import { billDueState } from "./envelope-status";

describe("billDueState", () => {
  it("counts days to the next due day and whether the pot covers the cost", () => {
    expect(billDueState(25, 500, 500, "2026-11-07")).toEqual({
      daysLeft: 18,
      ready: true,
      overdue: false,
    });
  });
  it("flags a passed due day as overdue when the pot is short", () => {
    expect(billDueState(5, 100, 500, "2026-11-07")).toEqual({
      daysLeft: 28,
      ready: false,
      overdue: true,
    });
  });
  it("clamps the due day to short months", () => {
    expect(billDueState(31, 0, 10, "2026-02-10")).toEqual({
      daysLeft: 18,
      ready: false,
      overdue: false,
    });
  });
  it("has no countdown without a due day", () => {
    expect(billDueState(null, 10, 5, "2026-11-07")).toEqual({
      daysLeft: null,
      ready: true,
      overdue: false,
    });
  });
});
