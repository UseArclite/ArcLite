/**
 * What became of a window, in a sentence.
 *
 * "Did the last window settle?" is the first thing anyone asks after submitting an order, and
 * until now the dashboard could not answer it. `useWindow()` returns the previous window and
 * throws it away every five seconds; everything before that was unreachable without a database
 * client.
 *
 * ## The two outcomes worth being careful about
 *
 * `VOID` and `FAILED` look alarming and are not. A window voids when nothing could cross, and
 * fails when proving or settlement did not complete in time. **Nullifiers are published only at
 * settlement**, so in both cases no note was spent: the orders rested, the notes stayed valid,
 * and the trader's position is exactly what it was. That is true, reassuring, and was completely
 * invisible — a trader seeing `FAILED` had no way to learn their money was untouched.
 *
 * So both say it outright. A status label alone would be the scary half of the truth.
 */

export type WindowStatus =
  | "OPEN"
  | "SEALED"
  | "MATCHING"
  | "MATCHED"
  | "PROVING"
  | "SETTLING"
  | "SETTLED"
  | "VOID"
  | "FAILED";

export interface WindowRow {
  seq: number;
  status: WindowStatus;
  orderCount: number;
  fillCount: number;
  opensAt: string;
  settledAt: string | null;
  settledTx: string | null;
}

export type OutcomeTone = "settled" | "empty" | "none" | "pending";

export interface WindowOutcome {
  /** The short word in the status column. */
  label: string;
  tone: OutcomeTone;
  /** What it means, including whether anything was spent. Null when the plain label suffices. */
  note: string | null;
}

export function describeWindow(w: WindowRow): WindowOutcome {
  if (w.status === "SETTLED") {
    if (w.fillCount > 0) {
      return {
        label: "settled",
        tone: "settled",
        note: `${w.fillCount} fill${w.fillCount === 1 ? "" : "s"}`,
      };
    }
    // The ordinary outcome on a young venue: the window ran correctly and found nobody to cross
    // with. Distinct from a window that broke.
    return {
      label: "settled",
      tone: w.orderCount === 0 ? "empty" : "none",
      note: w.orderCount === 0 ? "no orders" : "no counterparty",
    };
  }

  if (w.status === "VOID" || w.status === "FAILED") {
    return {
      label: w.status === "VOID" ? "voided" : "failed",
      tone: "none",
      // The load-bearing half. Nullifiers publish at settlement, so a window that never settled
      // spent nothing.
      note: "nothing crossed and no note was spent",
    };
  }

  return { label: w.status.toLowerCase(), tone: "pending", note: null };
}

/** A clock time, in the venue's own timezone, because windows are a market-hours thing. */
export function windowTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}
