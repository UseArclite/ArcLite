import { describe, expect, test } from "bun:test";
import { describeCrossing } from "../crossing-history";

/**
 * Three states that must not merge, and one sentence that must never appear.
 *
 * The three: an asset nobody has offered, an asset offered but never crossed, and an asset that
 * crosses. A redesign that rendered the first two the same way would be telling somebody their
 * order is unlikely to fill when in fact nobody has ever tried — a different thing, and one they
 * might act on by not trying either.
 *
 * The sentence that must never appear is a probability. There is no arithmetic here that produces
 * a percentage, and the test at the bottom exists so nobody adds one.
 */

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const at = (over: Partial<Parameters<typeof describeCrossing>[0]> = {}) =>
  describeCrossing({ symbol: "NVDA", booked: 0, crossed: 0, lastCrossAt: null, now: NOW, ...over });

describe("an asset nobody has offered", () => {
  test("says nothing has been offered, not that it never crosses", () => {
    const c = at();
    expect(c.text).toBe("No orders in NVDA have reached a crossing yet.");
    expect(c.neverBooked).toBe(true);
    expect(c.hasCrossed).toBe(false);
  });
});

describe("an asset offered but never crossed", () => {
  test("is distinct from never offered", () => {
    const c = at({ booked: 2 });
    expect(c.text).toBe("NVDA has had a book in 2 windows and crossed in none of them.");
    expect(c.neverBooked).toBe(false);
    expect(c.hasCrossed).toBe(false);
  });

  test("one window reads as a sentence, not as '1 windows'", () => {
    expect(at({ booked: 1 }).text).toBe("NVDA has had a book in one window, and it did not cross.");
  });
});

describe("an asset that crosses", () => {
  test("reports the record and when it last happened", () => {
    const c = at({ booked: 11, crossed: 9, lastCrossAt: new Date(NOW - 2 * HOUR).toISOString() });
    expect(c.text).toBe(
      "NVDA has crossed in 9 of 11 windows with a book · last cross 2 hours ago.",
    );
    expect(c.hasCrossed).toBe(true);
  });

  test("a perfect record is said as one rather than as 'N of N'", () => {
    const c = at({ booked: 3, crossed: 3, lastCrossAt: new Date(NOW - HOUR).toISOString() });
    expect(c.text).toContain("every one of its 3 windows");
  });

  test("a crossing with no timestamp still produces a clean sentence", () => {
    const c = at({ booked: 4, crossed: 1 });
    expect(c.text).toBe("NVDA has crossed in 1 of 4 windows with a book.");
    expect(c.text).not.toContain("last cross");
  });

  test("a future timestamp does not become a negative gap", () => {
    const c = at({ booked: 2, crossed: 1, lastCrossAt: new Date(NOW + 30_000).toISOString() });
    expect(c.text).toContain("just now");
  });
});

describe("what it must never say", () => {
  test("no percentage, no likelihood, no forecast", () => {
    // With this little history a probability would be a claim the data cannot support, and it
    // would be read as a promise. Every branch is a count of something that already happened.
    for (const input of [
      {},
      { booked: 2 },
      { booked: 11, crossed: 9, lastCrossAt: new Date(NOW - HOUR).toISOString() },
      { booked: 1, crossed: 1, lastCrossAt: new Date(NOW - HOUR).toISOString() },
    ]) {
      const { text } = at(input);
      expect(text).not.toMatch(/%|percent|likely|chance|probabilit|expect|should cross/i);
    }
  });
});
