import { describe, expect, test } from "bun:test";
import { since, venuePulse } from "../venue-pulse";

/**
 * The states that must stay distinguishable.
 *
 * The bug this replaced was not a wrong number — it was one number meaning four things. A quiet
 * venue, a dead venue, a brand-new venue and a busy venue between windows all rendered as "0
 * orders in this window". The tests below exist to keep those four apart; a change that collapsed
 * any two of them back together would be the regression, and it would pass any test that only
 * checked the count.
 */

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const at = (over: Partial<Parameters<typeof venuePulse>[0]> = {}) =>
  venuePulse({
    orderCount: 0,
    orders24h: 0,
    windows24h: 288,
    lastOrderAt: null,
    now: NOW,
    ...over,
  });

describe("a window with orders in it", () => {
  test("counts them, and says nothing else when there is nothing else to say", () => {
    const p = at({ orderCount: 7, orders24h: 7 });
    expect(p.label).toBe("orders in this window");
    expect(p.context).toBeNull();
  });

  test("one order is singular", () => {
    expect(at({ orderCount: 1, orders24h: 1 }).label).toBe("order in this window");
  });

  test("adds the day's total only when it says something the window does not", () => {
    expect(at({ orderCount: 2, orders24h: 19 }).context).toBe("19 in the last 24 hours");
  });
});

describe("the four faces of zero", () => {
  test("quiet window, busy day", () => {
    const p = at({ orders24h: 19, windows24h: 288 });
    expect(p.label).toBe("orders in this window yet");
    expect(p.context).toBe("19 in the last 24 hours, across 288 windows");
    expect(p.neverAnyOrders).toBe(false);
  });

  test("quiet day, but the venue has been used", () => {
    const p = at({ lastOrderAt: new Date(NOW - 72 * HOUR).toISOString() });
    expect(p.context).toBe("nothing in the last 24 hours either — the last one was 3 days ago");
    expect(p.neverAnyOrders).toBe(false);
  });

  test("never used at all is said outright, and flagged", () => {
    const p = at();
    expect(p.context).toBe("nothing has been submitted here yet");
    // The flag exists so the UI can render this differently from a quiet day. Collapsing the two
    // is exactly the thing this module was built to stop.
    expect(p.neverAnyOrders).toBe(true);
  });

  test("a venue used today is never reported as never used", () => {
    expect(at({ orders24h: 1 }).neverAnyOrders).toBe(false);
  });
});

describe("gaps", () => {
  test("reads in minutes, then hours, then days", () => {
    expect(since(0)).toBe("just now");
    expect(since(60_000)).toBe("1 minute ago");
    expect(since(45 * 60_000)).toBe("45 minutes ago");
    expect(since(5 * HOUR)).toBe("5 hours ago");
    expect(since(72 * HOUR)).toBe("3 days ago");
  });

  test("a future timestamp does not become a negative gap", () => {
    // The server clock and the browser's disagree by seconds routinely, and "the last one was
    // -1 minutes ago" would discredit the rest of the panel.
    const p = at({ lastOrderAt: new Date(NOW + 30_000).toISOString() });
    expect(p.context).toContain("just now");
  });

  test("a missing window count still produces a sentence", () => {
    expect(at({ orders24h: 4, windows24h: 0 }).context).toBe("4 in the last 24 hours");
  });
});
