import { describe, expect, test } from "bun:test";
import { describeWindow, type WindowRow } from "../window-outcome";

/**
 * The property to protect is that a window which did not settle always says no note was spent.
 *
 * `VOID` and `FAILED` read as money-losing events and are not: nullifiers publish only at
 * settlement, so a window that never settled left every note valid and every order resting. A
 * trader seeing a red label with no explanation would reasonably assume the opposite, and that is
 * the one wrong conclusion this table could cause.
 */

const row = (over: Partial<WindowRow> = {}): WindowRow => ({
  seq: 500,
  status: "SETTLED",
  orderCount: 0,
  fillCount: 0,
  opensAt: "2026-09-25T00:00:00.000Z",
  settledAt: "2026-09-25T00:05:00.000Z",
  settledTx: null,
  ...over,
});

describe("settled windows", () => {
  test("with fills, count them", () => {
    const o = describeWindow(row({ orderCount: 4, fillCount: 3 }));
    expect(o.tone).toBe("settled");
    expect(o.note).toBe("3 fills");
  });

  test("one fill is singular", () => {
    expect(describeWindow(row({ orderCount: 2, fillCount: 1 })).note).toBe("1 fill");
  });

  test("an empty book is distinguished from a book that found nobody", () => {
    // Different facts on a young venue: nobody showed up, versus people showed up and did not
    // match. Collapsing them would hide the only signal that participation is happening.
    expect(describeWindow(row({ orderCount: 0 })).note).toBe("no orders");
    expect(describeWindow(row({ orderCount: 2, fillCount: 0 })).note).toBe("no counterparty");
  });
});

describe("windows that did not settle", () => {
  test("a voided window says no note was spent", () => {
    const o = describeWindow(row({ status: "VOID", orderCount: 3 }));
    expect(o.label).toBe("voided");
    expect(o.note).toContain("no note was spent");
  });

  test("a failed window says the same", () => {
    const o = describeWindow(row({ status: "FAILED", orderCount: 3 }));
    expect(o.label).toBe("failed");
    expect(o.note).toContain("no note was spent");
  });

  test("neither can ever render without that reassurance", () => {
    // The tripwire. A refactor that dropped the note would leave a bare red label implying loss.
    for (const status of ["VOID", "FAILED"] as const)
      for (const orderCount of [0, 1, 8]) {
        expect(describeWindow(row({ status, orderCount })).note).toContain("no note was spent");
      }
  });
});

describe("windows still running", () => {
  test("report their stage and claim nothing", () => {
    const o = describeWindow(row({ status: "PROVING", settledAt: null }));
    expect(o.label).toBe("proving");
    expect(o.tone).toBe("pending");
    expect(o.note).toBeNull();
  });
});
