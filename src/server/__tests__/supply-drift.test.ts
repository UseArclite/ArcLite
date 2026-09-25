import { describe, expect, test } from "bun:test";
import {
  assessFailure,
  assessSupply,
  BASELINE_MAX_AGE_MS,
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
const NOW = 1_700_000_000_000;
const base = (over: Partial<SupplyState> = {}): SupplyState => ({
  lastSupply: 1_000_000n * ONE,
  baselineSupply: 1_000_000n * ONE,
  baselineAt: NOW - 60_000,
  baselineMultiplier: ONE,
  failedReads: 0,
  ...over,
});

const at = (state: SupplyState, supply: bigint, multiplier = ONE) =>
  assessSupply({ supply, multiplier }, state, NOW);

describe("ordinary life", () => {
  test("no change is no drift", () => {
    const v = at(base(), 1_000_000n * ONE);
    expect(v.drifted).toBe(false);
    expect(v.driftBps).toBe(0);
    expect(v.reason).toBeNull();
  });

  test("an ordinary minute of issuance is not an event", () => {
    // Measured, not guessed: over eleven hours of mainnet readings the largest single-minute
    // move on NVDA was 55 bps. This is 100.
    expect(at(base(), 1_010_000n * ONE).drifted).toBe(false);
  });

  test("the first sight of an asset is a baseline, not a fault", () => {
    const v = at(
      base({ lastSupply: null, baselineSupply: null, baselineMultiplier: null }),
      5n * ONE,
    );
    expect(v.drifted).toBe(false);
    expect(v.rebase).toBe(true);
  });
});

describe("the bug that blacked out fourteen mainnet assets", () => {
  /**
   * The first version measured against a baseline that only moved when a corporate action
   * explained it. Ordinary issuance therefore accumulated until it crossed any threshold — a
   * day of normal minting put 14 of 35 assets into an on-chain blackout for working correctly.
   *
   * These pin the fix: normal drift must stay quiet indefinitely, and the anchor must age out.
   */
  test("a day of normal issuance never trips", () => {
    // 34 bps an hour, the observed mainnet rate, for 24 hours — 816 bps in total, far past the
    // old 200 bps bound and comfortably inside this one.
    let supply = 1_000_000n * ONE;
    let state = base();
    for (let minute = 0; minute < 24 * 60; minute++) {
      // A little under a basis point a minute, drifting one way all day.
      const next = supply + supply / 20_000n;
      const now = NOW + minute * 60_000;
      const v = assessSupply({ supply: next, multiplier: ONE }, state, now);
      expect(v.drifted).toBe(false);
      state = {
        ...state,
        lastSupply: next,
        baselineSupply: v.rebase ? next : state.baselineSupply,
        baselineAt: v.rebase ? now : state.baselineAt,
      };
      supply = next;
    }
  });

  test("the anchor ages out rather than standing forever", () => {
    const stale = base({ baselineAt: NOW - BASELINE_MAX_AGE_MS - 1 });
    expect(at(stale, 1_000_100n * ONE).rebase).toBe(true);
    const fresh = base({ baselineAt: NOW - 1000 });
    expect(at(fresh, 1_000_100n * ONE).rebase).toBe(false);
  });
});

describe("the event worth stopping for", () => {
  test("a sudden mint trips the breaker", () => {
    const v = at(base(), 1_100_000n * ONE);
    expect(v.drifted).toBe(true);
    expect(v.driftBps).toBe(1000);
    expect(v.reason).toContain("minted 10.00%");
    expect(v.reason).toContain("in a single check");
  });

  test("a sudden burn trips it too", () => {
    const v = at(base(), 900_000n * ONE);
    expect(v.drifted).toBe(true);
    expect(v.reason).toContain("burned 10.00%");
  });

  test("a slow drain under the step limit still trips on the hour", () => {
    // The reason a step check alone is not enough: mint just under the per-check bound every
    // minute and nothing would ever fire. The anchor catches it.
    const state = base({ lastSupply: 1_300_000n * ONE, baselineAt: NOW - 60_000 });
    const v = at(state, 1_340_000n * ONE);
    expect(v.drifted).toBe(true);
    expect(v.reason).toContain("within the hour");
  });

  test("a tripped asset does not rebase itself quiet", () => {
    // If it rebased, the next cycle would find no change and clear the alarm on its own.
    expect(at(base(), 2_000_000n * ONE).rebase).toBe(false);
  });

  test("a corporate action explains a supply change and rebases instead", () => {
    const v = at(base(), 2_000_000n * ONE, 2n * ONE);
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
