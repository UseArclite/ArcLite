import { describe, expect, test } from "bun:test";
import {
  DEPOSIT_CENTS,
  ORDER_CENTS,
  quickstartPlan,
  quickstartProgress,
  quickstartStep,
  type QuickstartState,
} from "../quickstart";

/**
 * The whole point of this module is that a first attempt must not fail.
 *
 * So the tests are about the arithmetic being *safe* rather than merely correct: the order must
 * cost no more than the budget it came from, the deposit must cover it with room, and the step must
 * follow what is actually true of the vault rather than what the flow last told somebody to do.
 *
 * The decimal mismatch is the trap. Quote is six decimals, equities are eighteen, and the price is
 * 1e18-scaled — the exact combination that produced an order two orders of magnitude too large and
 * failed an entire window.
 */

const e18 = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

const plan = (price: string, baseDecimals = 18, quoteDecimals = 6) =>
  quickstartPlan({ priceE18: e18(price), baseDecimals, quoteDecimals });

/** What an order of `orderRaw` base units actually costs, in raw quote units. */
const costRaw = (orderRaw: bigint, price: string, baseDecimals = 18, quoteDecimals = 6) =>
  (orderRaw * e18(price) * 10n ** BigInt(quoteDecimals)) /
  (10n ** BigInt(baseDecimals) * 10n ** 18n);

describe("the deposit", () => {
  test("is a dollar in the quote asset's own decimals", () => {
    expect(plan("222.45").depositRaw).toBe(1_000_000n); // $1.00 at six decimals
  });

  test("follows the quote decimals rather than assuming six", () => {
    expect(plan("222.45", 18, 18).depositRaw).toBe(10n ** 18n); // $1.00 at eighteen
  });
});

describe("the order", () => {
  test("costs no more than the budget it was derived from", () => {
    // The direction that matters. Rounding up would overshoot the budget by a unit, and a
    // one-unit overshoot is what made the pre-flight refuse a real window.
    for (const price of ["222.45", "335.38", "761.55", "1.0842", "99999.99"]) {
      const p = plan(price);
      if (!p.ok) continue;
      const budget = (ORDER_CENTS * 10n ** 6n) / 100n; // 25 cents at six decimals
      expect(costRaw(p.orderRaw, price)).toBeLessThanOrEqual(budget);
    }
  });

  test("is about a quarter of a dollar at a real equity price", () => {
    const p = plan("222.45");
    // 0.001124 shares × $222.45 ≈ $0.25
    expect(p.orderRaw).toBe(1_123_848_055_742_863n);
    expect(Number(costRaw(p.orderRaw, "222.45")) / 1e6).toBeCloseTo(0.25, 2);
  });

  test("the deposit covers the order several times over", () => {
    // preflight requires headroom over the cost; a first attempt that fails its own check is
    // worse than no guidance.
    const p = plan("222.45");
    expect(p.depositRaw).toBeGreaterThan(costRaw(p.orderRaw, "222.45") * 3n);
  });

  test("scales with the asset's decimals", () => {
    const eighteen = plan("100", 18).orderRaw;
    const eight = plan("100", 8).orderRaw;
    expect(eighteen / eight).toBe(10n ** 10n);
  });
});

describe("refusing rather than guessing", () => {
  test("no price means no plan", () => {
    const p = quickstartPlan({ priceE18: 0n, baseDecimals: 18, quoteDecimals: 6 });
    expect(p.ok).toBe(false);
    expect(p.orderRaw).toBe(0n);
    expect(p.reason).toContain("reference price");
  });

  test("an order that rounds to zero is refused, not submitted", () => {
    // Zero units submits, seals and crosses for nothing — a venue that looks broken.
    const p = quickstartPlan({ priceE18: e18("1000000"), baseDecimals: 2, quoteDecimals: 6 });
    expect(p.ok).toBe(false);
    expect(p.orderRaw).toBe(0n);
  });

  test("the deposit is still stated when the order cannot be sized", () => {
    // Somebody can deposit while a feed is still loading; withholding both would stall the flow
    // on the step that does not depend on a price.
    expect(quickstartPlan({ priceE18: 0n, baseDecimals: 18, quoteDecimals: 6 }).depositRaw).toBe(
      1_000_000n,
    );
  });
});

describe("which step is in hand", () => {
  const s = (over: Partial<QuickstartState> = {}): QuickstartState => ({
    connected: true,
    unlocked: true,
    funded: true,
    ordered: false,
    resolved: false,
    ...over,
  });

  test("follows what is true, in order", () => {
    expect(quickstartStep(s({ connected: false }))).toBe("connect");
    expect(quickstartStep(s({ unlocked: false }))).toBe("unlock");
    expect(quickstartStep(s({ funded: false }))).toBe("deposit");
    expect(quickstartStep(s())).toBe("order");
    expect(quickstartStep(s({ ordered: true }))).toBe("settling");
    expect(quickstartStep(s({ ordered: true, resolved: true }))).toBe("done");
  });

  test("an already funded vault is not asked to deposit again", () => {
    // Somebody who deposited last week, or in the ordinary panel, starts at the order step.
    expect(quickstartStep(s({ funded: true }))).toBe("order");
  });

  test("locking sends it back to unlock, not forward", () => {
    // The vault's idle lock fires mid-flow. Treating that as progress would show an order button
    // that cannot sign.
    expect(quickstartStep(s({ unlocked: false, ordered: true }))).toBe("unlock");
  });

  test("progress is monotonic", () => {
    const order = ["connect", "unlock", "deposit", "order", "settling", "done"] as const;
    const values = order.map(quickstartProgress);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(quickstartProgress("done")).toBe(5);
  });
});

describe("the constants", () => {
  test("the order is a quarter of the deposit", () => {
    expect(DEPOSIT_CENTS / ORDER_CENTS).toBe(4n);
  });
});
