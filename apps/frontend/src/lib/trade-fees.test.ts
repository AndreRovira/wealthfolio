import { describe, expect, it } from "vitest";

import { setTradeFeesInMeta, tradeFees, tradeFeesFromMeta } from "./trade-fees";

describe("trade fees", () => {
  it("charges the fee on the traded value and the tax on the fee", () => {
    const rates = { feePercent: 0.25, taxPercent: 16 };
    expect(tradeFees(18 * 3298.68, rates)).toEqual({ fee: 148.44, tax: 23.75 });
    expect(tradeFees(Number.NaN, rates)).toEqual({ fee: 0, tax: 0 });
  });

  it("keeps the percentages in the account meta beside what is there", () => {
    const meta = setTradeFeesInMeta('{"accounting":{"costBasisMethod":"FIFO"}}', {
      feePercent: 0.25,
      taxPercent: 16,
    });
    expect(JSON.parse(meta).accounting).toEqual({ costBasisMethod: "FIFO" });
    expect(tradeFeesFromMeta(meta)).toEqual({ feePercent: 0.25, taxPercent: 16 });
    expect(tradeFeesFromMeta("not json")).toEqual({ feePercent: 0, taxPercent: 0 });
    // A fee retyped from 0 keeps the tax beside it; both at 0 removes the entry.
    expect(tradeFeesFromMeta(setTradeFeesInMeta(meta, { feePercent: 0, taxPercent: 16 }))).toEqual({
      feePercent: 0,
      taxPercent: 16,
    });
    expect(JSON.parse(setTradeFeesInMeta(meta, { feePercent: 0, taxPercent: 0 }))).toEqual({
      accounting: { costBasisMethod: "FIFO" },
    });
  });
});
