import { describe, expect, test } from "bun:test";
import { briefUsd, describeLitMarket, feeLabel, DUST_FLOOR_USD } from "../lit-market";

/**
 * The thing to protect here is the floor. Pools exist whether or not anyone funded them, and
 * reading four fee tiers per asset turns up pairs holding a dollar. Reporting those as liquidity
 * would put an encouraging number next to a market that cannot absorb one order — the sort of
 * true-but-useless figure this dashboard keeps having to remove.
 */

const at = (over: Partial<Parameters<typeof describeLitMarket>[0]> = {}) =>
  describeLitMarket({
    symbol: "NVDA",
    quoteRaw: "3566303000000",
    quoteDecimals: 6,
    feeTier: 500,
    ...over,
  });

describe("a real market", () => {
  test("is reported with its size and its fee tier", () => {
    const m = at();
    expect(m.hasMarket).toBe(true);
    expect(m.text).toBe("$3.6M of lit NVDA liquidity on the public DEX, at 0.05%.");
  });

  test("reads the quote at its own decimals, not eighteen", () => {
    // USDG is 6dp. Treating it as 18 would report $0.0000036 and hide every real market.
    expect(at().quote).toBeCloseTo(3_566_303, 0);
  });
});

describe("the dust floor", () => {
  test("a pool holding a dollar is not a market", () => {
    const m = at({ quoteRaw: "1000000" });
    expect(m.hasMarket).toBe(false);
    expect(m.text).toContain("effectively unfunded");
  });

  test("an empty pool is not a market", () => {
    expect(at({ quoteRaw: "0" }).hasMarket).toBe(false);
  });

  test("just under the floor is still not a market, just over it is", () => {
    const under = at({ quoteRaw: String((DUST_FLOOR_USD - 1) * 1_000_000) });
    const over = at({ quoteRaw: String((DUST_FLOOR_USD + 1) * 1_000_000) });
    expect(under.hasMarket).toBe(false);
    expect(over.hasMarket).toBe(true);
  });

  test("an unfunded pool is distinguished from no pool at all", () => {
    // Different facts: one is a venue somebody may yet fund, the other is an unlisted asset.
    expect(at({ quoteRaw: "0" }).text).toContain("pool exists");
    expect(at({ quoteRaw: null, feeTier: null }).text).toContain("No lit market");
  });
});

describe("formatting", () => {
  test("money is compact but not wrong", () => {
    expect(briefUsd(3_566_303)).toBe("$3.6M");
    expect(briefUsd(42_000_000)).toBe("$42M");
    expect(briefUsd(22_296)).toBe("$22k");
    expect(briefUsd(950)).toBe("$950");
  });

  test("fee tiers read the way a person writes them", () => {
    expect(feeLabel(500)).toBe("0.05%");
    expect(feeLabel(3000)).toBe("0.3%");
    expect(feeLabel(10000)).toBe("1%");
  });
});
