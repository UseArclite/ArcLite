import { describe, expect, test } from "bun:test";
import { venueRecordView, type RecordInput } from "../venue-record";

/**
 * The property worth defending is that the unflattering row cannot disappear.
 *
 * A venue publishing its cumulative record is only credible if the record is complete, and the
 * figure a reader is specifically hunting for is how many orders actually crossed. The easy
 * regression — hide the row when it is zero, because zero looks bad — is the one that would cost
 * more than the number it hid. The first block below exists to make that regression fail.
 */

// The venue's real mainnet figures at the time this was written.
const live: RecordInput = {
  windows: 797,
  settled: 794,
  failed: 2,
  withOrders: 4,
  withFills: 4,
  orders: 4,
  fills: 4,
  crossed: 0,
  assetsBooked: 2,
  assetsEligible: 36,
  since: "2026-09-21T00:45:49.062Z",
};

const at = (over: Partial<RecordInput> = {}) => venueRecordView({ ...live, ...over });
const row = (v: ReturnType<typeof venueRecordView>, key: string) =>
  v.rows.find((r) => r.key === key)!;

describe("the row that must never vanish", () => {
  test("crossing is reported even when it is zero", () => {
    const v = at();
    expect(row(v, "crossed").value).toBe("0");
    expect(v.neverCrossed).toBe(true);
  });

  test("it survives every shape of input, including an empty venue", () => {
    const inputs: Partial<RecordInput>[] = [
      {},
      { windows: 0, settled: 0, failed: 0, withOrders: 0, orders: 0, fills: 0, since: null },
      { orders: 1_000, crossed: 0 },
      { orders: 1_000, crossed: 999, withFills: 400 },
    ];
    for (const over of inputs) {
      expect(at(over).rows.some((r) => r.key === "crossed")).toBe(true);
    }
  });

  test("zero crossed says why, rather than leaving a bare nought", () => {
    expect(row(at(), "crossed").note).toBe("no order has yet met a counterparty");
    expect(row(at({ orders: 0 }), "crossed").note).toBe("nothing submitted yet");
  });
});

describe("denominators", () => {
  test("orders carry the share of windows that held one", () => {
    // 4 of 797 is the number that makes "797 windows" mean something. Alone it flatters.
    expect(row(at(), "orders").note).toBe("across 4 windows — 0.5% of them");
  });

  test("a vanishingly small share is not rounded to zero", () => {
    // "0.0% of them" would read as none at all, which is a different claim.
    expect(row(at({ windows: 100_000, withOrders: 1 }), "orders").note).toContain("<0.1%");
  });

  test("one window is singular", () => {
    expect(row(at({ withOrders: 1 }), "orders").note).toContain("across 1 window —");
  });
});

describe("reliability", () => {
  test("is a share, with failures named", () => {
    const v = at();
    expect(row(v, "reliability").value).toBe("99.6%");
    expect(row(v, "reliability").note).toBe("2 windows voided or failed");
  });

  test("a clean record says so rather than omitting the note", () => {
    expect(row(at({ failed: 0, settled: 797 }), "reliability").note).toBe("none failed");
  });

  test("an empty venue does not divide by zero", () => {
    expect(row(at({ windows: 0, settled: 0 }), "reliability").value).toBe("—");
  });
});

describe("the summary", () => {
  test("distinguishes nothing submitted from nothing crossing", () => {
    expect(at({ orders: 0 }).summary).toContain("No orders have been submitted");
    expect(at().summary).toContain("none has yet met a counterparty");
  });

  test("explains that nothing crossing is arithmetic, not a fault", () => {
    // The honest reading, and the one a bare zero invites somebody to get wrong.
    expect(at().summary).toContain("arithmetic rather than a fault");
  });

  test("reports crossings plainly once they exist", () => {
    expect(at({ crossed: 3, orders: 10 }).summary).toBe("3 orders crossed out of 10 submitted.");
  });
});
