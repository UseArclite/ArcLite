import { describe, expect, test } from "bun:test";
import { migrationPlan, MIGRATION_STEPS, type MigrationInput } from "../migration";

/**
 * Migration is the one action on this venue that costs privacy to perform.
 *
 * It is a public withdrawal followed by a public deposit from the same address, usually for the
 * same amount — the two links the withdrawal guard warns about, produced together, in their
 * purest form. A panel that presented it as a tidy "Migrate" button would be hiding the only
 * thing somebody needs in order to decide.
 *
 * So these tests are about what must always be said, not about what is computed.
 */

const at = (over: Partial<MigrationInput> = {}) =>
  migrationPlan({
    legacy: [{ pool: "0xold", assetId: "22", units: "1000000" }],
    liveCrowd: 0,
    deployed: true,
    ...over,
  });

describe("nothing to move", () => {
  test("is idle and says nothing", () => {
    const p = at({ legacy: [] });
    expect(p.idle).toBe(true);
    expect(p.headline).toBe("");
  });
});

describe("what must always be said", () => {
  test("every non-idle plan states that the move is public, both ways", () => {
    for (const over of [
      {},
      { liveCrowd: 5 },
      { liveCrowd: 500 },
      {
        legacy: [
          { pool: "0xa", assetId: "1", units: "1" },
          { pool: "0xb", assetId: "2", units: "2" },
        ],
      },
    ]) {
      const p = at(over);
      expect(p.idle).toBe(false);
      expect(p.headline).toContain("public");
      expect(p.headline).toContain("same address");
    }
  });

  test("a healthy crowd does not make the move private", () => {
    // The tempting regression: crowd is large, so stop warning. The crowd protects the note once
    // it is in; it does nothing about the two transactions that put it there.
    const p = at({ liveCrowd: 5_000 });
    expect(p.privacy).toBe("linkable");
    expect(p.reason).toContain("two public transactions");
  });
});

describe("being first", () => {
  test("an empty pool is reported as no privacy, not as weak privacy", () => {
    const p = at({ liveCrowd: 0 });
    expect(p.privacy).toBe("none");
    expect(p.reason).toContain("hides among none");
  });

  test("it says what migrating does buy, and what it does not", () => {
    const p = at({ liveCrowd: 0 });
    expect(p.reason).toContain("the ability to trade, not privacy");
    // The genuinely useful half: a first note is what lets the next person hide.
    expect(p.reason).toContain("whoever comes next");
  });

  test("it offers the option of doing nothing", () => {
    // Leaving a note in a retired pool is safe and costs nothing. Somebody not trading yet should
    // be told that rather than nudged into a public round trip for no gain.
    expect(at({ liveCrowd: 0 }).advice).toContain("leaving the note where it is costs nothing");
  });

  test("one other commitment is singular", () => {
    expect(at({ liveCrowd: 1 }).reason).toContain("1 other commitment.");
  });
});

describe("no live pool", () => {
  test("does not instruct a move that cannot happen", () => {
    const p = at({ deployed: false });
    expect(p.headline).toContain("no live pool");
    expect(p.reason).toContain("stay withdrawable");
  });
});

describe("the steps", () => {
  test("are two, named as two transactions rather than one action", () => {
    expect(MIGRATION_STEPS.map((s) => s.key)).toEqual(["withdraw", "deposit"]);
  });

  test("the withdrawal step keeps the always-open promise", () => {
    const withdraw = MIGRATION_STEPS[0]!;
    expect(withdraw.detail).toContain("no pause");
    expect(withdraw.detail).toContain("does not change because it was replaced");
  });
});
