import { describe, expect, test } from "bun:test";
import { elapsed, PROOF_STAGES, proofStages } from "../proof-stages";

/**
 * This panel exists to be believed. It is the screen where the product claims that a withdrawal
 * is proved on the holder's own machine and that the venue cannot stop it — so a stage that
 * misrepresents what is happening costs more here than anywhere else in the app.
 *
 * Two properties follow. Exactly one stage is ever current, and no stage claims work the worker
 * does not do.
 */

describe("the stage list", () => {
  test("shows nothing when no withdrawal is running", () => {
    // Not an empty row of pending steps: those would imply something is in flight.
    expect(proofStages(null)).toEqual([]);
  });

  test("marks exactly one stage current, at every phase", () => {
    for (const { phase } of PROOF_STAGES) {
      const current = proofStages(phase).filter((s) => s.state === "current");
      expect(current).toHaveLength(1);
      expect(current[0]!.phase).toBe(phase);
    }
  });

  test("everything before the current stage is done, everything after is pending", () => {
    const stages = proofStages("proving");
    expect(stages.map((s) => s.state)).toEqual(["done", "done", "current", "todo"]);
  });

  test("the first phase has nothing behind it", () => {
    expect(proofStages("locating").map((s) => s.state)).toEqual([
      "current",
      "todo",
      "todo",
      "todo",
    ]);
  });

  test("the last phase leaves nothing pending", () => {
    expect(proofStages("broadcasting").map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "current",
    ]);
  });

  test("an unknown phase never reports completed work", () => {
    // A worker newer than this bundle. Showing everything as pending is wrong harmlessly;
    // marking stages done that may not have happened would not be.
    const stages = proofStages("something-new" as never);
    expect(stages.filter((s) => s.state === "done")).toHaveLength(0);
  });
});

describe("what the stages may claim", () => {
  test("no stage claims a verification step, because the worker does not verify", () => {
    // "Verifying locally" would read beautifully and would be a lie. The worker builds a witness
    // and proves; there is no local verify. A progress display that invents a step is a spinner
    // that lies, which is worse than a spinner.
    for (const s of PROOF_STAGES) {
      expect(`${s.title} ${s.detail}`).not.toMatch(/verif/i);
    }
  });

  test("every stage says where the work happens", () => {
    // The point of the panel is that none of this needs a server. Each stage should carry that
    // rather than relying on one line at the bottom.
    const text = PROOF_STAGES.map((s) => s.detail).join(" ");
    expect(text).toMatch(/this browser|this machine|here/i);
    expect(text).not.toMatch(/our server|we prove|upload/i);
  });
});

describe("the timer", () => {
  test("reads in tenths", () => {
    expect(elapsed(1_000, 4_200)).toBe("3.2s");
  });

  test("never runs backwards", () => {
    // Clock adjustments mid-proof should not produce a negative elapsed time.
    expect(elapsed(5_000, 4_000)).toBe("0.0s");
  });
});
