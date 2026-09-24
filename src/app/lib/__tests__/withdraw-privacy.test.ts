import { describe, expect, test } from "bun:test";
import { assessWithdrawal } from "../withdraw-privacy";

/**
 * The warning is only worth having if it stays honest in the cases that are inconvenient.
 *
 * Two of these matter more than the rest: a long wait must not be reported as safe when the
 * amount is an exact match, and an empty pool must not be softened by a long wait. Both are the
 * shape of failure a well-meaning edit produces — somebody tidies the branches, the `high` turns
 * into a `low`, and the sentence somebody reads before withdrawing stops being true.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

const at = (agoMs: number, over: Partial<Parameters<typeof assessWithdrawal>[0]> = {}) =>
  assessWithdrawal({
    depositTimes: [NOW - agoMs],
    depositUnits: ["1000000"],
    units: "400000",
    othersInPool: 50,
    now: NOW,
    ...over,
  });

describe("timing", () => {
  test("minutes after a deposit is the case worth warning about", () => {
    const note = at(4 * MINUTE);
    expect(note.level).toBe("high");
    expect(note.sinceMinutes).toBe(4);
    expect(note.headline).toContain("4 minutes ago");
  });

  test("under a minute does not say '0 minutes ago'", () => {
    expect(at(20_000).headline).toContain("less than a minute");
  });

  test("one minute is singular", () => {
    expect(at(MINUTE).headline).toContain("1 minute ago");
  });

  test("hours later is moderate, not high", () => {
    const note = at(5 * HOUR);
    expect(note.level).toBe("moderate");
    expect(note.headline).toContain("5 hours");
  });

  test("days later, with a different amount, is low and has nothing to advise", () => {
    const note = at(9 * DAY);
    expect(note.level).toBe("low");
    expect(note.advice).toBeNull();
    expect(note.headline).toContain("9 days");
  });

  test("the most recent deposit is the one that matters", () => {
    // An old deposit does not excuse a fresh one: the fresh one is the link.
    const note = assessWithdrawal({
      depositTimes: [NOW - 30 * DAY, NOW - 2 * MINUTE],
      depositUnits: ["1"],
      units: "2",
      othersInPool: 50,
      now: NOW,
    });
    expect(note.level).toBe("high");
    expect(note.sinceMinutes).toBe(2);
  });
});

describe("amount", () => {
  test("withdrawing exactly what was deposited is caught", () => {
    expect(at(HOUR, { units: "1000000" }).exactMatch).toBe(true);
  });

  test("an exact match keeps a month-old deposit off 'low'", () => {
    // The point of the whole module: waiting does not erase a matching number.
    const note = at(30 * DAY, { units: "1000000" });
    expect(note.level).toBe("moderate");
    expect(note.advice).toContain("does not fade");
  });

  test("a different amount at the same age is low", () => {
    expect(at(30 * DAY, { units: "999999" }).level).toBe("low");
  });

  test("an empty string is not a match against a deposit of nothing", () => {
    expect(at(HOUR, { units: "", depositUnits: [""] }).exactMatch).toBe(false);
  });

  test("a fresh deposit with a matching amount advises both, in order", () => {
    const note = at(3 * MINUTE, { units: "1000000" });
    expect(note.advice).toContain("Waiting");
    expect(note.advice).toContain("different amount");
  });
});

describe("the pool", () => {
  test("no one else in it overrides everything", () => {
    // A month of waiting and a different amount do not help when there is no crowd at all.
    const note = at(30 * DAY, { othersInPool: 0, units: "7" });
    expect(note.level).toBe("high");
    expect(note.headline).toContain("only ones in this pool");
  });

  test("the empty-pool advice does not pretend the holder can fix it", () => {
    expect(at(MINUTE, { othersInPool: 0 }).advice).toContain("other people deposit");
  });
});

describe("what it does not know", () => {
  test("no deposit times says so rather than guessing", () => {
    const note = at(0, { depositTimes: [] });
    expect(note.level).toBe("unknown");
    expect(note.sinceMinutes).toBeNull();
  });

  test("it still reports an exact match it can see without timing", () => {
    expect(at(0, { depositTimes: [], units: "1000000" }).exactMatch).toBe(true);
  });

  test("a deposit timestamped in the future does not produce a negative age", () => {
    // Block timestamps and a client clock disagree by seconds routinely, and a headline reading
    // "-1 minutes ago" would discredit every other sentence on the panel.
    expect(at(-30_000).sinceMinutes).toBe(0);
  });
});
