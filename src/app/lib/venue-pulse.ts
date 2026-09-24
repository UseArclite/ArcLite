/**
 * Whether anyone else is here.
 *
 * On a batch auction this is the one piece of market data that changes a decision. An order with
 * nobody on the other side does not lose money — it rests, unfilled, and the trader finds out a
 * window later. Knowing beforehand that the book is empty is the difference between submitting
 * and waiting, and a count is not a book, so saying it leaks nothing.
 *
 * ## Why the current window's count is not enough
 *
 * The window clock already showed `0 orders in this window`, and on this venue that is very
 * nearly always true. A permanent zero is indistinguishable from a venue that is broken, a venue
 * that is empty, and a venue that was never live — three situations a trader would act on
 * differently, rendered identically.
 *
 * So the zero gets a denominator. *Nothing in this window, and nothing in the last 24 hours
 * either — the last order was three days ago* is a venue that works and is quiet. *Nothing has
 * been submitted here yet* is a venue nobody has used. Both are worse news than a busy book and
 * both are better than a number that could mean anything.
 *
 * Nothing here is a prediction. Every sentence is a count of something that already happened.
 */

export interface PulseInput {
  /** Orders sealed into the window currently open. */
  orderCount: number;
  /** Orders across every window opened in the last 24 hours, this one included. */
  orders24h: number;
  /** How many windows that covers, so the figure has a denominator. */
  windows24h: number;
  /** When the most recent window carrying any order opened. Null if there has never been one. */
  lastOrderAt: string | null;
  now?: number;
}

export interface PulseLine {
  /**
   * The phrase that follows the count, which the UI renders as its own bold element so the
   * existing pulse animation still has something to target. Excluding the number from the string
   * avoids the alternative — building a sentence here and then stripping the first word back off
   * in the component, which breaks the moment the wording changes.
   */
  label: string;
  /** Whether anyone has been around otherwise, or null when the window speaks for itself. */
  context: string | null;
  /** Nothing has ever been submitted here. Worth rendering differently from a quiet day. */
  neverAnyOrders: boolean;
}

/** A gap, said the way a person would say it. */
export function since(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "just now";
  if (mins < 90) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function venuePulse({
  orderCount,
  orders24h,
  windows24h,
  lastOrderAt,
  now = Date.now(),
}: PulseInput): PulseLine {
  // Reads as "0 orders in this window yet" / "7 orders in this window" once the count is in
  // front of it.
  const label =
    orderCount === 0
      ? "orders in this window yet"
      : `order${orderCount === 1 ? "" : "s"} in this window`;

  // A busy window is its own evidence. The day's figure is still worth adding when it says
  // something the window does not — that this is a pattern rather than a coincidence.
  if (orderCount > 0) {
    const others = orders24h - orderCount;
    return {
      label,
      context: others > 0 ? `${orders24h} in the last 24 hours` : null,
      neverAnyOrders: false,
    };
  }

  if (orders24h > 0) {
    return {
      label,
      context:
        windows24h > 0
          ? `${orders24h} in the last 24 hours, across ${windows24h} window${windows24h === 1 ? "" : "s"}`
          : `${orders24h} in the last 24 hours`,
      neverAnyOrders: false,
    };
  }

  if (lastOrderAt) {
    const at = new Date(lastOrderAt).getTime();
    // A clock that disagrees with the server by a few seconds should not produce "in the future".
    const gap = Math.max(0, now - at);
    return {
      label,
      context: `nothing in the last 24 hours either — the last one was ${since(gap)}`,
      neverAnyOrders: false,
    };
  }

  return {
    label,
    // The most honest state this venue has, and the one it was rendering as a bare "0".
    context: "nothing has been submitted here yet",
    neverAnyOrders: true,
  };
}
