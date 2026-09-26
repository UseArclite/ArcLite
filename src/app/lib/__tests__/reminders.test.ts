import { describe, expect, test } from "bun:test";
import {
  addWatch,
  fireWatches,
  pruneWatches,
  removeWatch,
  SEALING_SECONDS,
  WATCH_MAX_AGE_MS,
  watchId,
  type MarketView,
  type Watch,
} from "../reminders";

/**
 * Every failure mode of a reminder is the same failure: firing when it should not.
 *
 * Fire on first load and opening the dashboard sets off every watch at once. Fire on each poll and
 * a one-minute warning becomes twelve notifications. Fire across windows and a watch somebody set
 * yesterday goes off forever. A notification nobody asked for at that moment is worse than no
 * notification at all, because it is the reason people turn the feature off.
 *
 * So these tests are almost entirely about silence.
 */

const NOW = 1_700_000_000_000;
const view = (over: Partial<MarketView> = {}): MarketView => ({
  deferred: { NVDA: true, AAPL: false },
  secondsToSeal: 300,
  windowSeq: 800,
  ...over,
});

const undeferred: Watch = { kind: "undeferred", symbol: "NVDA", at: NOW };
const sealing: Watch = { kind: "sealing", at: NOW };

describe("silence", () => {
  test("nothing fires on the first observation", () => {
    // No previous state means no transition. Otherwise every watch on an asset that happens to be
    // trading would fire the moment the page loads.
    expect(fireWatches([undeferred, sealing], null, view({ deferred: { NVDA: false } }))).toEqual(
      [],
    );
  });

  test("an unchanged condition does not fire", () => {
    const v = view({ deferred: { NVDA: false } });
    expect(fireWatches([undeferred], v, v)).toEqual([]);
  });

  test("an asset the market has not reported is unknown, not cleared", () => {
    // `undefined` is missing data. Treating it as "not deferred" would fire a watch because the
    // market endpoint hiccuped.
    const before = view({ deferred: { NVDA: true } });
    const after = view({ deferred: {} });
    expect(fireWatches([undeferred], before, after)).toEqual([]);
  });

  test("becoming deferred does not fire an undeferred watch", () => {
    const before = view({ deferred: { NVDA: false } });
    const after = view({ deferred: { NVDA: true } });
    expect(fireWatches([undeferred], before, after)).toEqual([]);
  });
});

describe("an asset clearing", () => {
  test("fires exactly once on the transition", () => {
    const before = view({ deferred: { NVDA: true } });
    const after = view({ deferred: { NVDA: false } });
    const fired = fireWatches([undeferred], before, after);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.title).toBe("NVDA is trading again");
  });

  test("a watch on one asset is not fired by another clearing", () => {
    const before = view({ deferred: { NVDA: true, AAPL: true } });
    const after = view({ deferred: { NVDA: true, AAPL: false } });
    expect(fireWatches([undeferred], before, after)).toEqual([]);
  });
});

describe("the sealing warning", () => {
  test("fires when the countdown crosses the threshold", () => {
    const before = view({ secondsToSeal: SEALING_SECONDS + 5 });
    const after = view({ secondsToSeal: SEALING_SECONDS - 5 });
    expect(fireWatches([sealing], before, after)).toHaveLength(1);
  });

  test("does not fire again while the countdown stays under it", () => {
    // The regression that turns one warning into twelve.
    const before = view({ secondsToSeal: 40 });
    const after = view({ secondsToSeal: 35 });
    expect(fireWatches([sealing], before, after)).toEqual([]);
  });

  test("does not fire across a window boundary", () => {
    // Without the window check, the countdown resetting and falling again in the next window
    // would look like a fresh crossing every five minutes, forever.
    const before = view({ secondsToSeal: 300, windowSeq: 800 });
    const after = view({ secondsToSeal: 30, windowSeq: 801 });
    expect(fireWatches([sealing], before, after)).toEqual([]);
  });

  test("stays quiet when no window is open", () => {
    expect(fireWatches([sealing], view(), view({ secondsToSeal: null, windowSeq: null }))).toEqual(
      [],
    );
  });
});

describe("the watch list", () => {
  test("adding the same watch twice is idempotent", () => {
    expect(addWatch([undeferred], { ...undeferred, at: NOW + 500 })).toHaveLength(1);
  });

  test("watches are identified by kind and symbol, not by time", () => {
    expect(watchId(undeferred)).toBe("undeferred:NVDA");
    expect(watchId(sealing)).toBe("sealing:");
  });

  test("removing works by id", () => {
    expect(removeWatch([undeferred, sealing], "undeferred:NVDA")).toEqual([sealing]);
  });

  test("stale watches are dropped", () => {
    // An intention from last week is not one now, and a watch that outlives its reason is a
    // notification somebody has forgotten they asked for.
    const old = { ...undeferred, at: NOW - WATCH_MAX_AGE_MS - 1 };
    expect(pruneWatches([old, sealing], NOW)).toEqual([sealing]);
  });
});
