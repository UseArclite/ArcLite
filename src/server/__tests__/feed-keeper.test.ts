import { describe, expect, test } from "bun:test";
import { nextAnswer } from "../feed-keeper";

/**
 * The stand-in feeds drive the whole testnet venue: the reference every window crosses at, the
 * staleness guard, and the chart. A walk that wandered would make tNVDA stop being worth $222
 * and every worked example in the repo wrong — so the bound is the property that matters, not
 * the movement.
 */
describe("the testnet feed walk", () => {
  const NVDA = 22_244_729_849n; // $222.45 at 8 decimals
  const DRIFT_BPS = 200;

  test("stays inside the band however long it runs", () => {
    const low = NVDA - (NVDA * BigInt(DRIFT_BPS)) / 10_000n;
    const high = NVDA + (NVDA * BigInt(DRIFT_BPS)) / 10_000n;

    let price = NVDA;
    let moved = false;
    // A day of minutes. A walk that escapes does so slowly, so a short run proves nothing.
    for (let i = 0; i < 1440; i++) {
      price = nextAnswer(price, NVDA, DRIFT_BPS);
      expect(price).toBeGreaterThanOrEqual(low);
      expect(price).toBeLessThanOrEqual(high);
      if (price !== NVDA) moved = true;
    }
    expect(moved).toBe(true);
  });

  test("a pinned feed never moves", () => {
    // The quote asset. A dollar that is not a dollar is its own bug, and every expected figure
    // in the pipeline is denominated in it.
    let price = 100_000_000n;
    for (let i = 0; i < 100; i++) price = nextAnswer(price, 100_000_000n, 0);
    expect(price).toBe(100_000_000n);
  });

  test("recovers to the band if it starts outside it", () => {
    // A feed seeded wrong, or left somewhere odd by an earlier experiment, must be pulled back
    // rather than clamped against a bound it can never leave.
    const far = NVDA * 3n;
    expect(nextAnswer(far, NVDA, DRIFT_BPS)).toBeLessThanOrEqual(
      NVDA + (NVDA * BigInt(DRIFT_BPS)) / 10_000n,
    );
  });
});
