import { describe, expect, it } from "vitest";

import { setTradeFeesInMeta, tradeFees, tradeFeesFromMeta } from "./trade-fees";

describe("trade fees", () => {
  it("charges the fee and the tax as the brokers bill them", () => {
    const rates = { feePercent: 0.25, taxPercent: 16 };
    // Traded value, fee and tax from real Actinver and GBM confirmations.
    const billed = [
      [18 * 3298.68, 148.44, 23.75],
      [58584.9, 146.46, 23.44],
      [12466, 31.16, 4.99],
      [18750, 46.88, 7.5],
      [6250, 15.62, 2.5],
      [29835.81, 74.59, 11.93],
      [103795.3, 259.49, 41.52],
      [391 * 12.29, 12.01, 1.93],
      [750.2, 1.88, 0.3],
      [12.3, 0.03, 0.01],
    ];
    for (const [gross, fee, tax] of billed) {
      expect([gross, tradeFees(gross, rates)]).toEqual([gross, { fee, tax }]);
    }
    expect(tradeFees(Number.NaN, rates)).toEqual({ fee: 0, tax: 0 });
    expect(tradeFees(1000, { feePercent: 0, taxPercent: 16 })).toEqual({ fee: 0, tax: 0 });
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
