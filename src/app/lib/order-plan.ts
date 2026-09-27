/**
 * Splitting one order across several windows, without letting anything outlive your attention.
 *
 * A large order in a single window is identifiable by its own size. Five windows of a fifth each
 * sit inside whatever crowd each window has, and the aggregate tape publishes totals rather than
 * an order. So slicing is a privacy tool here, not just an execution one — which is why it is
 * worth building even though the obvious version of it cannot be built at all.
 *
 * ## Why this is not "recurring orders", and cannot be
 *
 * The thing people ask for is unattended: set it up, close the tab, come back tomorrow. Three
 * separate parts of this design refuse that, and it is worth naming each, because the refusal is
 * not a missing feature — it is the same property the venue exists to provide.
 *
 * 1. **The spend signature is bound to one window.** `batch_cross` verifies
 *    `hash2(hash2(DOMAIN_SPEND, window_id), …)`, so a signature made for window N is rejected in
 *    window N+1. One signature cannot cover a series.
 * 2. **Future window ids are not predictable.** `chain_window_id` is assigned at insert from the
 *    window's actual `opens_at`, floored to a second and forced past the last id. When the next
 *    window opens depends on when this one settles, which depends on proving and settlement
 *    latency. So a trader cannot pre-sign a bounded set of future windows either: there is
 *    nothing to sign.
 * 3. **Sealing needs the spending secret.** The order payload carries the note's `nsecret`, which
 *    is why it is built inside the vault worker and never reaches the document's scope. A plan
 *    that pre-sealed orders for later would have to hold that in ordinary page memory for hours.
 *
 * And the option neither of those blocks — having the server hold something that can seal on your
 * behalf — is the one that is out of the question, because it would hand the operator exactly the
 * pre-seal visibility that sealing exists to deny.
 *
 * What is left is honest and still useful: **a plan runs while you are here.** Each window, one
 * slice is signed and sealed fresh by the unlocked vault against that window's real key. When the
 * vault's idle lock fires, the plan pauses with its remaining slices intact and says so.
 *
 * The idle lock is what bounds this, and it bounds it without any help from here: it is driven by
 * `pointerdown`/`keydown`/`wheel`/`touchstart` only, so a slice submitting itself is not activity
 * and cannot keep the vault alive. A schedule that renewed its own key lifetime would be the
 * unbounded-key version wearing a different name.
 *
 * The plan is held in memory and nowhere else — not in `localStorage`, unlike the window
 * reminders. A reminder is "tell me when NVDA clears"; a plan is the asset, the side and the size
 * of what you are about to trade. It dies with the tab, for the same reason the keys do.
 */

export interface OrderPlan {
  /** Registry asset id of what is being traded. */
  assetId: string;
  /** For display only. */
  symbol: string;
  side: "buy" | "sell";
  /** Raw units per slice, decimal string. Each slice is an ordinary order of this size. */
  slice: string;
  /** How many slices the plan is for. */
  total: number;
  /** How many have been submitted. */
  done: number;
  /** The window each submitted slice went into, so one window never takes two. */
  windows: number[];
  state: PlanState;
  /** Why it stopped or paused, in words, when it did. */
  note: string | null;
}

export type PlanState = "running" | "paused" | "finished";

/**
 * The most slices a plan may hold.
 *
 * Windows are five minutes and the vault's idle lock defaults to fifteen, so three slices is what
 * an average session actually delivers. The cap is higher than that on purpose — somebody working
 * at the screen keeps the vault alive and can genuinely run a dozen — but it is not open-ended,
 * because a plan long enough to outlast any plausible session is an unattended plan being
 * promised by a control that cannot deliver one.
 */
export const MAX_SLICES = 12;

/**
 * How close to sealing is too close to submit into.
 *
 * Sealing, preflight, the round trip and the intake check all have to finish before `seals_at`.
 * Waiting for the next window costs five minutes; missing is a refusal the trader has to read.
 */
export const MIN_SECONDS_TO_SUBMIT = 20;

export interface PlanContext {
  plan: OrderPlan | null;
  /** The vault's status. Anything but `unlocked` cannot sign. */
  vaultUnlocked: boolean;
  /** The open window's sequence, or null when none is open. */
  windowSeq: number | null;
  secondsToSeal: number | null;
  /**
   * Whether a note that can fund one slice exists right now.
   *
   * Notes are spent whole and the change comes back as a new note at settlement, so a plan
   * normally *cannot* fire in the window straight after a slice: the change from that slice is
   * still in flight. That is a wait, not a failure, and the two must not be shown the same way.
   */
  fundable: boolean;
}

export type PlanAction =
  | { kind: "idle" }
  | { kind: "submit" }
  | { kind: "wait"; reason: string }
  | { kind: "pause"; reason: string }
  | { kind: "finish" };

/**
 * What the plan should do on this observation.
 *
 * Pure, and called on every poll rather than on a timer: the window is the clock, and a plan that
 * counted minutes of its own would drift away from the thing it is pacing against.
 */
export function planAction(ctx: PlanContext): PlanAction {
  const { plan } = ctx;
  if (!plan || plan.state === "finished") return { kind: "idle" };
  if (plan.done >= plan.total) return { kind: "finish" };

  // The lock takes precedence over everything below, including a window that is open and
  // fundable. Nothing signs while the vault is shut, and pretending otherwise would produce a
  // plan that looks alive and silently does nothing.
  if (!ctx.vaultUnlocked) {
    return plan.state === "paused"
      ? { kind: "idle" }
      : {
          kind: "pause",
          reason: `Your vault locked with ${plan.total - plan.done} of ${plan.total} slices left. Open it to carry on.`,
        };
  }

  // A paused plan needs a deliberate restart. Resuming the moment the vault reopens would mean a
  // schedule survived the lock, which is the whole thing the lock is for.
  if (plan.state === "paused") return { kind: "idle" };

  if (ctx.windowSeq === null) return { kind: "wait", reason: "No window is open." };

  // One slice per window. Two in the same window share its crowd and its timing and are one
  // larger order wearing two commitments — the opposite of why somebody sliced.
  if (plan.windows.includes(ctx.windowSeq)) {
    return {
      kind: "wait",
      reason: "This window already has a slice. The next one takes the next.",
    };
  }

  if (ctx.secondsToSeal !== null && ctx.secondsToSeal < MIN_SECONDS_TO_SUBMIT) {
    return { kind: "wait", reason: "Too close to the seal. Waiting for the next window." };
  }

  if (!ctx.fundable) {
    return {
      kind: "wait",
      reason:
        plan.done > 0
          ? "Waiting for the change from your last slice to settle. A note is spent whole, so the next slice is funded by what comes back."
          : "No note can fund a slice of this size yet.",
    };
  }

  return { kind: "submit" };
}

/** Start a plan. `slices` is clamped rather than rejected, so a slider cannot make an invalid one. */
export function startPlan(input: {
  assetId: string;
  symbol: string;
  side: "buy" | "sell";
  slice: string;
  slices: number;
}): OrderPlan {
  return {
    assetId: input.assetId,
    symbol: input.symbol,
    side: input.side,
    slice: input.slice,
    total: Math.max(1, Math.min(MAX_SLICES, Math.floor(input.slices))),
    done: 0,
    windows: [],
    state: "running",
    note: null,
  };
}

/** Record a slice that the venue accepted. */
export function recordSlice(plan: OrderPlan, windowSeq: number): OrderPlan {
  const done = plan.done + 1;
  return {
    ...plan,
    done,
    windows: [...plan.windows, windowSeq],
    state: done >= plan.total ? "finished" : "running",
    note:
      done >= plan.total
        ? `All ${plan.total} slices submitted.`
        : `${done} of ${plan.total} submitted.`,
  };
}

/**
 * Pause a plan, for the idle lock or for a refusal.
 *
 * A refused slice pauses rather than retrying. The venue refuses an order for a reason — the
 * window closed, the asset deferred, the note was already offered — and a plan that resubmitted
 * into the next window would turn one refusal into a series of them with nobody reading any.
 */
export function pausePlan(plan: OrderPlan, reason: string): OrderPlan {
  return { ...plan, state: "paused", note: reason };
}

/** Resume a paused plan. Only ever from a click. */
export function resumePlan(plan: OrderPlan): OrderPlan {
  return { ...plan, state: "running", note: null };
}

/** What the panel says about a plan, so the wording lives with the logic that produces it. */
export function planSummary(plan: OrderPlan): string {
  const left = plan.total - plan.done;
  if (plan.state === "finished") return `Finished — ${plan.total} of ${plan.total} submitted.`;
  if (plan.state === "paused") return `Paused — ${left} of ${plan.total} slices left.`;
  return `Running — ${plan.done} of ${plan.total} submitted, one per window.`;
}
