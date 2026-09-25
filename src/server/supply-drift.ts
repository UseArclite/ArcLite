/**
 * Whether an asset's token supply has moved in a way that should stop it crossing.
 *
 * ## What this is, and what it is not
 *
 * The integration spec asked for a *reserve*-drift breaker: supply versus attested reserves, so
 * that a token which stops being backed stops trading. That is the right property and it cannot
 * be built today, because the attested half has no source on this chain — Chainlink publishes no
 * Proof-of-Reserve feed on 4663 (0 of 58 feeds carry one), Prism documents no API or registry
 * contract, and Robinhood's own asset registry has no supply or reserve field at all.
 *
 * What is available is the half Prism's own documentation says Reserve Watch starts from: the
 * token's `totalSupply()`, read straight from its contract. So this detects **that the issuer
 * minted or burned**, not that the result is unbacked. It is a weaker claim and is named as one
 * everywhere it surfaces. Calling it proof-of-reserve would be the single most misleading thing
 * this venue could say about itself.
 *
 * It is still worth having. These tokens are mintable by their issuer; until now a supply change
 * was completely invisible here and the venue would have gone on crossing at the Chainlink price
 * as though nothing had happened. And it is the scaffolding an actual PoR feed plugs into on the
 * day one exists — only `attested` would be new.
 *
 * ## Why a multiplier change excuses a supply change
 *
 * A stock split, a dividend or a consolidation moves supply *and* the issuer's `uiMultiplier`
 * together — that is what the multiplier is for. The pair is an announced corporate action and
 * the venue already has a guard for it (`MULTIPLIER_PENDING`, plus the `EventCalendar` blackout
 * around `effectiveAt`). Flagging it again here would defer assets for doing the expected thing.
 *
 * A supply move with no multiplier move is the one nobody announced.
 */

export interface SupplyReading {
  /** Raw `totalSupply()`. */
  supply: bigint;
  /** `uiMultiplier()` at the same read, 1e18-scaled. */
  multiplier: bigint;
}

export interface SupplyState {
  /** The previous reading. A step is measured against this. Null before the first read. */
  lastSupply: bigint | null;
  /** The longer-run anchor, refreshed on a schedule so a slow drain still has something to fail. */
  baselineSupply: bigint | null;
  /** When that anchor was adopted, so it can be aged out. */
  baselineAt: number | null;
  /** The multiplier when the anchor was adopted. */
  baselineMultiplier: bigint | null;
  /** Consecutive failed reads before this one. */
  failedReads: number;
}

export interface DriftVerdict {
  /** Stop crossing this asset. */
  drifted: boolean;
  /** Signed basis points against the baseline. Positive is a mint. */
  driftBps: number;
  /** Adopt the current reading as the new baseline. */
  rebase: boolean;
  /** Said plainly, for the dashboard. Null when nothing is wrong. */
  reason: string | null;
}

/**
 * How far supply may move **in one step** before it is worth stopping over.
 *
 * This replaces a cumulative-drift check that was wrong in a way no threshold could fix. The
 * first version compared each reading against a baseline that only moved when a corporate action
 * explained it, so ordinary issuance accumulated until it crossed any bound you picked. Every
 * asset would eventually trip, given enough hours — and on mainnet, 14 of 35 did, inside a day.
 *
 * Measured against the real thing rather than guessed: a tokenized equity's supply moves
 * continuously as its issuer mints and burns against actual flows. Over eleven hours of
 * minute-by-minute readings, NVDA moved 370 bps in total and never more than **55 bps in a single
 * minute**. Gradual drift is the product working. A step change is not.
 *
 * So the question became "how much did this move since we last looked", and 500 bps is an order
 * of magnitude above observed normal movement while still catching a mint that would materially
 * change what a token represents.
 */
export const STEP_TOLERANCE_BPS = 500;

/**
 * The slow-drain bound.
 *
 * A step check alone can be walked past: mint under the step limit every minute and the guard
 * never fires. This is the backstop — total movement against a baseline that is deliberately
 * rebased on a schedule rather than never. At the observed rate (~34 bps/hour) an hour of normal
 * issuance is nowhere near it.
 */
export const WINDOW_TOLERANCE_BPS = 3_000;

/** How long a baseline stands before it is refreshed. Long enough to bound a slow drain. */
export const BASELINE_MAX_AGE_MS = 60 * 60_000;

/**
 * How many consecutive unreadable cycles before an asset is treated as drifted.
 *
 * Fail-closed, and the number is small on purpose. "We could not check" and "it is fine" must
 * never render the same, and the cost of being wrong in the safe direction is that an asset
 * stops crossing for a few minutes.
 */
export const MAX_FAILED_READS = 3;

/** Signed basis points from `from` to `to`. Integer arithmetic throughout: no float touches a supply figure. */
export function driftBps(from: bigint, to: bigint): number {
  if (from === 0n) return to === 0n ? 0 : 10_000;
  const delta = ((to - from) * 10_000n) / from;
  // Clamped only for display sanity; the verdict is decided on the comparison, not this number.
  const clamped = delta > 1_000_000n ? 1_000_000n : delta < -1_000_000n ? -1_000_000n : delta;
  return Number(clamped);
}

/** A failed read. Kept separate so the caller cannot accidentally treat "unknown" as "unchanged". */
export function assessFailure(state: SupplyState): DriftVerdict {
  const failed = state.failedReads + 1;
  if (failed < MAX_FAILED_READS) {
    return { drifted: false, driftBps: 0, rebase: false, reason: null };
  }
  return {
    drifted: true,
    driftBps: 0,
    rebase: false,
    reason: `The token's supply could not be read for ${failed} checks in a row, so it cannot be confirmed unchanged.`,
  };
}

export function assessSupply(
  reading: SupplyReading,
  state: SupplyState,
  now: number = Date.now(),
): DriftVerdict {
  // The first sight of an asset is a baseline, never a fault — otherwise every newly listed
  // asset would be deferred on the day it arrived.
  if (state.lastSupply === null || state.baselineSupply === null) {
    return { drifted: false, driftBps: 0, rebase: true, reason: null };
  }

  const step = driftBps(state.lastSupply, reading.supply);
  const sinceBaseline = driftBps(state.baselineSupply, reading.supply);
  const baselineStale = state.baselineAt === null || now - state.baselineAt > BASELINE_MAX_AGE_MS;

  // An announced corporate action moves supply and the multiplier together. The multiplier guard
  // already defers this asset around `effectiveAt`; flagging it again would defer assets for
  // behaving correctly.
  if (state.baselineMultiplier !== null && reading.multiplier !== state.baselineMultiplier) {
    return { drifted: false, driftBps: step, rebase: true, reason: null };
  }

  const tripped =
    Math.abs(step) > STEP_TOLERANCE_BPS || Math.abs(sinceBaseline) > WINDOW_TOLERANCE_BPS;

  if (!tripped) {
    return {
      drifted: false,
      driftBps: step,
      // Age the anchor out rather than holding it forever. A baseline that never moves turns
      // ordinary issuance into an eventual trip — which is exactly how the first version of this
      // put 14 of 35 mainnet assets into a blackout for working normally.
      rebase: baselineStale,
      reason: null,
    };
  }

  const bps = Math.abs(step) > STEP_TOLERANCE_BPS ? step : sinceBaseline;
  const pct = (Math.abs(bps) / 100).toFixed(2);
  const over = Math.abs(step) > STEP_TOLERANCE_BPS ? "in a single check" : "within the hour";
  return {
    drifted: true,
    driftBps: bps,
    // Deliberately not rebased: an unexplained move stays flagged until somebody decides it is
    // explained. Rebasing here would clear the alarm by itself on the next cycle.
    rebase: false,
    reason:
      bps > 0
        ? `The issuer minted ${pct}% more of this token ${over}, with no corporate action to explain it. What each token represents may have changed.`
        : `The issuer burned ${pct}% of this token's supply ${over}, with no corporate action to explain it. What each token represents may have changed.`,
  };
}
