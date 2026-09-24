import { describe, expect, test } from "bun:test";
import {
  describeOutcome,
  newOutcomes,
  resolutionOf,
  type WatchedReceipt,
} from "../settlement-watch";

/**
 * What is worth interrupting somebody for.
 *
 * Every interesting case here is a *sequence* — which outcomes appeared while this browser was
 * watching, not which outcomes exist — and that is exactly what cannot be checked by looking at
 * a toast. The case that decides whether the feature survives contact with a user is the first
 * one: opening the dashboard after a week must announce nothing.
 */

const receipt = (over: Partial<WatchedReceipt> = {}): WatchedReceipt => ({
  commitment: "0xc1",
  windowSeq: 223,
  windowStatus: "SETTLED",
  settledTx: "0xtx",
  fill: {
    reason: "matched",
    filledRaw: "1000000000000000000",
    quoteRaw: "228410000",
    assetId: 7,
    side: "buy",
    quantityRaw: "1000000000000000000",
  },
  ...over,
});

const names = {
  symbol: (id: number) => (id === 7 ? "CLSK" : `asset ${id}`),
  amount: (raw: string) => (Number(raw) / 1e18).toString(),
};

describe("what counts as an outcome", () => {
  test("a fill is one", () => {
    expect(resolutionOf(receipt())).toBe("filled");
    expect(resolutionOf(receipt({ fill: { ...receipt().fill!, reason: "partial" } }))).toBe(
      "partial",
    );
    expect(resolutionOf(receipt({ fill: { ...receipt().fill!, reason: "unmatched" } }))).toBe(
      "unmatched",
    );
  });

  test("a guarded asset is reported as deferred, not as a failure", () => {
    for (const reason of ["stale", "event"]) {
      expect(resolutionOf(receipt({ fill: { ...receipt().fill!, reason } }))).toBe("deferred");
    }
  });

  test("a window that failed or voided is an outcome in its own right", () => {
    // Good news that otherwise looks like silence: nothing crossed and the note was never spent.
    for (const status of ["FAILED", "VOID"]) {
      expect(resolutionOf(receipt({ windowStatus: status, fill: null }))).toBe("void");
    }
  });

  test("a sealed order still waiting is not", () => {
    expect(resolutionOf(receipt({ windowStatus: "SEALED", fill: null }))).toBeNull();
    expect(resolutionOf(receipt({ windowStatus: "PROVING", fill: null }))).toBeNull();
  });
});

describe("what gets announced", () => {
  test("the first look announces nothing — the case that decides the feature", () => {
    // A trader opening the dashboard after a week has dozens of settled orders and none of them
    // are news. Announcing them all would be the last time notifications stayed on.
    const receipts = [receipt({ commitment: "0xa" }), receipt({ commitment: "0xb" })];
    const { resolved } = newOutcomes(receipts, new Set());
    // The caller seeds from `resolved` without announcing; the next pass is where news starts.
    const seeded = new Set(resolved);
    expect(seeded.size).toBe(2);
    expect(newOutcomes(receipts, seeded).announce).toEqual([]);
  });

  test("an outcome that appears while watching is announced once", () => {
    const seen = new Set(["0xa"]);
    const receipts = [receipt({ commitment: "0xa" }), receipt({ commitment: "0xb" })];
    const first = newOutcomes(receipts, seen);
    expect(first.announce.map((o) => o.commitment)).toEqual(["0xb"]);

    // And not again on the next poll.
    for (const c of first.resolved) seen.add(c);
    expect(newOutcomes(receipts, seen).announce).toEqual([]);
  });

  test("an order still in flight is not resolved, so it stays announceable", () => {
    const pending = receipt({ commitment: "0xp", windowStatus: "SEALED", fill: null });
    const { announce, resolved } = newOutcomes([pending], new Set());
    expect(announce).toEqual([]);
    expect(resolved).toEqual([]);
  });

  test("resolved lists everything settled, so the seed cannot miss one", () => {
    const receipts = [
      receipt({ commitment: "0xa" }),
      receipt({ commitment: "0xb", windowStatus: "VOID", fill: null }),
      receipt({ commitment: "0xc", windowStatus: "SEALED", fill: null }),
    ];
    expect(newOutcomes(receipts, new Set()).resolved.sort()).toEqual(["0xa", "0xb"]);
  });
});

describe("what it says", () => {
  test("a fill names the side, the size and the asset", () => {
    const o = newOutcomes([receipt()], new Set()).announce[0]!;
    const { title, body } = describeOutcome(o, names);
    expect(title).toContain("Buy filled");
    expect(title).toContain("CLSK");
    expect(body).toContain("Window 223");
  });

  test("unmatched is explained rather than left as a word", () => {
    // The expected result on a venue with few participants. Left as "unmatched" it reads as a
    // failure; it is not one, and the note is untouched.
    const o = newOutcomes(
      [receipt({ fill: { ...receipt().fill!, reason: "unmatched" } })],
      new Set(),
    ).announce[0]!;
    const { title, body } = describeOutcome(o, names);
    expect(title).toContain("No counterparty");
    expect(body).toContain("note is unchanged");
  });

  test("a void window says the note was never spent", () => {
    const o = newOutcomes([receipt({ windowStatus: "VOID", fill: null })], new Set()).announce[0]!;
    expect(describeOutcome(o, names).body).toContain("never spent");
  });

  test("a deferred asset names the asset that was guarded", () => {
    const o = newOutcomes([receipt({ fill: { ...receipt().fill!, reason: "stale" } })], new Set())
      .announce[0]!;
    expect(describeOutcome(o, names).title).toContain("deferred");
    expect(describeOutcome(o, names).body).toContain("CLSK");
  });
});
