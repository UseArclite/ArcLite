import { describe, expect, test } from "bun:test";
import {
  MAX_SLICES,
  MIN_SECONDS_TO_SUBMIT,
  pausePlan,
  planAction,
  planSummary,
  recordSlice,
  resumePlan,
  startPlan,
  type OrderPlan,
  type PlanContext,
} from "../order-plan";

/**
 * A plan is a loop that spends money, so every test here is about it stopping.
 *
 * The failure that matters is not a missed slice. It is a plan that keeps going after the trader
 * left — submitting into windows nobody is watching, funded by notes nobody is checking. The vault
 * locks after fifteen idle minutes precisely so that cannot happen, and a scheduler that worked
 * around the lock, resumed itself after it, or retried its way through refusals would undo it.
 */

const plan = (over: Partial<OrderPlan> = {}): OrderPlan => ({
  ...startPlan({ assetId: "22", symbol: "NVDA", side: "buy", slice: "1000000", slices: 4 }),
  ...over,
});

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  plan: plan(),
  vaultUnlocked: true,
  windowSeq: 800,
  secondsToSeal: 200,
  fundable: true,
  ...over,
});

describe("stopping", () => {
  test("a locked vault pauses the plan and says what is left", () => {
    const a = planAction(ctx({ vaultUnlocked: false }));
    expect(a.kind).toBe("pause");
    expect(a.kind === "pause" && a.reason).toContain("4 of 4 slices left");
  });

  test("the lock wins over an open, fundable window", () => {
    // The regression that matters: everything else says go, and the plan must still not sign.
    expect(
      planAction(ctx({ vaultUnlocked: false, windowSeq: 801, fundable: true, secondsToSeal: 300 }))
        .kind,
    ).toBe("pause");
  });

  test("a paused plan does not resume when the vault reopens", () => {
    // Auto-resuming would mean the schedule survived the lock, which is what the lock is for.
    expect(planAction(ctx({ plan: pausePlan(plan(), "locked"), vaultUnlocked: true })).kind).toBe(
      "idle",
    );
  });

  test("only an explicit resume restarts it", () => {
    const resumed = resumePlan(pausePlan(plan(), "locked"));
    expect(planAction(ctx({ plan: resumed })).kind).toBe("submit");
  });

  test("a finished plan does nothing", () => {
    expect(planAction(ctx({ plan: plan({ done: 4, state: "finished" }) })).kind).toBe("idle");
  });

  test("a plan past its count finishes rather than submitting", () => {
    expect(planAction(ctx({ plan: plan({ done: 4 }) })).kind).toBe("finish");
  });

  test("no plan is idle", () => {
    expect(planAction(ctx({ plan: null })).kind).toBe("idle");
  });
});

describe("one slice per window", () => {
  test("a window that already took a slice waits", () => {
    const a = planAction(ctx({ plan: plan({ done: 1, windows: [800] }), windowSeq: 800 }));
    expect(a.kind).toBe("wait");
  });

  test("the next window takes the next slice", () => {
    expect(planAction(ctx({ plan: plan({ done: 1, windows: [800] }), windowSeq: 801 })).kind).toBe(
      "submit",
    );
  });

  test("two slices in one window is the failure, not a double submit in two", () => {
    // Slicing that put two orders in the same window would share that window's crowd and timing:
    // one larger order wearing two commitments.
    let p = plan();
    p = recordSlice(p, 800);
    expect(planAction(ctx({ plan: p, windowSeq: 800 })).kind).toBe("wait");
  });
});

describe("waiting rather than failing", () => {
  test("no open window waits", () => {
    expect(planAction(ctx({ windowSeq: null })).kind).toBe("wait");
  });

  test("too close to the seal waits for the next window", () => {
    expect(planAction(ctx({ secondsToSeal: MIN_SECONDS_TO_SUBMIT - 1 })).kind).toBe("wait");
  });

  test("a slice's change still settling is explained as change, not as a shortfall", () => {
    // A note is spent whole, so the window after a slice usually cannot fund one. Showing that as
    // "insufficient funds" would read as a broken plan.
    const a = planAction(
      ctx({ plan: plan({ done: 1, windows: [800] }), windowSeq: 801, fundable: false }),
    );
    expect(a.kind).toBe("wait");
    expect(a.kind === "wait" && a.reason).toContain("change from your last slice");
  });

  test("a first slice that cannot be funded says so plainly", () => {
    const a = planAction(ctx({ fundable: false }));
    expect(a.kind === "wait" && a.reason).toContain("No note can fund");
  });
});

describe("the plan itself", () => {
  test("slice count is clamped, not rejected", () => {
    expect(
      startPlan({ assetId: "1", symbol: "X", side: "buy", slice: "1", slices: 99 }).total,
    ).toBe(MAX_SLICES);
    expect(startPlan({ assetId: "1", symbol: "X", side: "buy", slice: "1", slices: 0 }).total).toBe(
      1,
    );
  });

  test("recording the last slice finishes it", () => {
    let p = plan({ total: 2 });
    p = recordSlice(p, 800);
    expect(p.state).toBe("running");
    p = recordSlice(p, 801);
    expect(p.state).toBe("finished");
    expect(planSummary(p)).toContain("Finished");
  });

  test("a refusal pauses rather than retrying", () => {
    // One refusal becoming a refusal per window, with nobody reading any of them, is the loop
    // this avoids.
    const p = pausePlan(plan(), "The venue refused the order.");
    expect(p.state).toBe("paused");
    expect(planAction(ctx({ plan: p })).kind).toBe("idle");
  });

  test("a paused summary states what is outstanding", () => {
    expect(planSummary(pausePlan(plan({ done: 1 }), "locked"))).toContain("3 of 4");
  });
});
