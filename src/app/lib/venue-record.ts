/**
 * The venue's own numbers, including the ones that do not flatter it.
 *
 * A venue publishing its cumulative record reads as confident only if the record is complete. The
 * temptation is to show windows run and assets listed — both large, both true, both meaningless
 * on their own — and omit how many windows actually crossed. That omission is the one a reader is
 * specifically trying to detect, so making it would cost more than the number it hid.
 *
 * Today the honest figures are 797 windows, 4 orders and nothing crossed. This module is built so
 * that shape cannot be hidden: the crossing row is always present, and a test asserts it survives
 * every input including the one where it is zero.
 *
 * ## Why "no counterparty" is not "broken"
 *
 * A batch auction crosses when two sides meet in the same window. With four orders in the venue's
 * life, none of them meeting, nothing crossing is arithmetic rather than malfunction — and the
 * 99.6% of windows that settled cleanly is evidence the machinery works and is waiting. Both
 * statements are true and the panel makes both, because either alone misleads.
 */

export interface RecordInput {
  windows: number;
  settled: number;
  failed: number;
  withOrders: number;
  withFills: number;
  orders: number;
  fills: number;
  crossed: number;
  assetsBooked: number;
  assetsEligible: number;
  since: string | null;
}

export interface RecordRow {
  key: "windows" | "orders" | "crossed" | "assets" | "reliability";
  label: string;
  value: string;
  /** The denominator or qualifier that stops the figure being read alone. */
  note: string | null;
}

export interface VenueRecordView {
  rows: RecordRow[];
  /** One sentence for the state the venue is actually in. */
  summary: string;
  /** True while nothing has ever crossed — the caller may want to render that differently. */
  neverCrossed: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A percentage that never claims precision it does not have. */
function share(part: number, whole: number): string {
  if (whole === 0) return "—";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct >= 99.95 || pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

export function venueRecordView(r: RecordInput): VenueRecordView {
  const rows: RecordRow[] = [
    {
      key: "windows",
      label: "Windows run",
      value: r.windows.toLocaleString("en-US"),
      note: r.since ? `since ${new Date(r.since).toISOString().slice(0, 10)}` : null,
    },
    {
      key: "orders",
      label: "Orders submitted",
      value: r.orders.toLocaleString("en-US"),
      // The denominator that matters, and the one an incomplete version would drop.
      note:
        r.windows > 0
          ? `across ${plural(r.withOrders, "window")} — ${share(r.withOrders, r.windows)} of them`
          : null,
    },
    {
      // Always present, whatever its value. A record that omits this row when it is zero is a
      // record nobody should trust when it is not.
      key: "crossed",
      label: "Orders crossed",
      value: r.crossed.toLocaleString("en-US"),
      note:
        r.orders === 0
          ? "nothing submitted yet"
          : r.crossed === 0
            ? "no order has yet met a counterparty"
            : `in ${plural(r.withFills, "window")}`,
    },
    {
      key: "assets",
      label: "Assets",
      value: r.assetsEligible.toLocaleString("en-US"),
      note: r.assetsBooked > 0 ? `${r.assetsBooked} have had a book` : "none has had a book yet",
    },
    {
      key: "reliability",
      label: "Windows settled cleanly",
      value: share(r.settled, r.windows),
      note: r.failed > 0 ? `${plural(r.failed, "window")} voided or failed` : "none failed",
    },
  ];

  const summary =
    r.orders === 0
      ? "No orders have been submitted yet. The venue has been running windows and waiting."
      : r.crossed === 0
        ? "Orders have been submitted and none has yet met a counterparty in the same window. A batch auction crosses when two sides arrive together; with this few orders, nothing crossing is arithmetic rather than a fault."
        : `${plural(r.crossed, "order")} crossed out of ${r.orders} submitted.`;

  return { rows, summary, neverCrossed: r.crossed === 0 };
}
