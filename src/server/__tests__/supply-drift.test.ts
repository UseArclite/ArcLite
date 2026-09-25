import { describe, expect, test } from "bun:test";
import {
  assessFailure,
  assessSupply,
  driftBps,
  MAX_FAILED_READS,
  type SupplyState,
} from "../supply-drift";

/**
 * A circuit breaker is only worth having if it trips when it should and stays quiet when it
 * shouldn't. Both failures are expensive: a breaker that cries wolf gets switched off, and one
 * that sleeps through a mint lets the venue cross a token that has stopped meaning what it meant.
 *
 * The case worth guarding hardest is the third describe block. "We could not read it" must never
 * resolve to "it is fine" — that is the failure mode where a breaker looks healthy while checking
 * nothing at all, which is worse than having no breaker, because somebody is relying on it.
 */

const ONE = 10n ** 18n;
const base = (over: Partial<SupplyState> = {}): SupplyState => ({
  baselineSupply: 1_000_000n * ONE,
  baselineMultiplier: ONE,
  failedReads: 0,
  ...over,
});

describe("ordinary life", () => {
  test("no change is no drift", () => {
    const v = assessSupply({ supply: 1_000_000n * ONE, multiplier: ONE }, base());
    expect(v.drifted).toBe(false);
    expect(v.driftBps).toBe(0);
    expect(v.reason).toBeNull();
  });

  test("a small move stays under the bar and does not rebase", () => {
    // +1%, inside the 2% tolerance.
    const v = assessSupply({ supply: 1_010_000n * ONE, multiplier: ONE }, base());
    expect(v.drifted).toBe(false);
    expect(v.driftBps).toBe(100);
    // Not rebasing matters: drift is measured from a fixed point, so a slow creep of sub-tolerance
    // moves still adds up to a trip rather than resetting the baseline each time.
    expect(v.rebase).toBe(false);
  });

  test("the first sight of an asset is a baseline, not a fault", () => {
    const v = assessSupply(
      { supply: 5n * ONE, multiplier: ONE },
      base({ baselineSupply: null, baselineMultiplier: null }),
    );
    expect(v.drifted).toBe(false);
    expect(v.rebase).toBe(true);
  });
});

describe("the event worth stopping for", () => {
  test("an unexplained mint trips the breaker", () => {
    const v = assessSupply({ supply: 1_100_000n * ONE, multiplier: ONE }, base());
    expect(v.drifted).toBe(true);
    expect(v.driftBps).toBe(1000);
    expect(v.reason).toContain("minted 10.00%");
  });

  test("an unexplained burn trips it too", () => {
    const v = assessSupply({ supply: 900_000n * ONE, multiplier: ONE }, base());
    expect(v.drifted).toBe(true);
    expect(v.driftBps).toBe(-1000);
    expect(v.reason).toContain("burned 10.00%");
  });

  test("a tripped asset does not rebase itself quiet", () => {
    // If it rebased, the next cycle would compare against the new supply, find no change, and
    // clear the alarm on its own. Nobody would ever see it.
    expect(assessSupply({ supply: 2_000_000n * ONE, multiplier: ONE }, base()).rebase).toBe(false);
  });

  test("a corporate action explains a supply change and rebases instead", () => {
    // A split moves supply and the multiplier together. The multiplier guard already defers this
    // asset around effectiveAt; flagging it here would defer assets for behaving correctly.
    const v = assessSupply({ supply: 2_000_000n * ONE, multiplier: 2n * ONE }, base());
    expect(v.drifted).toBe(false);
    expect(v.rebase).toBe(true);
    expect(v.reason).toBeNull();
  });
});

describe("not being able to check is not the same as being fine", () => {
  test("a single failure is tolerated", () => {
    expect(assessFailure(base({ failedReads: 0 })).drifted).toBe(false);
  });

  test("enough consecutive failures trip the breaker", () => {
    const v = assessFailure(base({ failedReads: MAX_FAILED_READS - 1 }));
    expect(v.drifted).toBe(true);
    expect(v.reason).toContain("could not be read");
  });

  test("a failure never rebases the baseline", () => {
    // Rebasing on a failure would silently adopt whatever came next as normal.
    for (const failedReads of [0, 1, 2, 3, 9]) {
      expect(assessFailure(base({ failedReads })).rebase).toBe(false);
    }
  });
});

describe("the arithmetic", () => {
  test("is exact on figures far past a float's precision", () => {
    // 18-decimal supplies exceed 2^53 by orders of magnitude. A float here would round the
    // difference away and report no drift at all.
    const from = 89_125_927_850_270_000_000_000n;
    const to = from + from / 10n;
    expect(driftBps(from, to)).toBe(1000);
  });

  test("a one-unit move in a huge supply is not mistaken for a drift", () => {
    const from = 89_125_927_850_270_000_000_000n;
    expect(driftBps(from, from + 1n)).toBe(0);
  });

  test("supply arriving from nothing is a full-scale move, not a divide by zero", () => {
    expect(driftBps(0n, 0n)).toBe(0);
    expect(driftBps(0n, 1n)).toBe(10_000);
  });
});
