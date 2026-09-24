import { since } from "./venue-pulse";

/**
 * What this asset's crossing record actually says.
 *
 * Every sentence here is a count of something that already happened. There is no probability and
 * no estimate, and that is a design constraint rather than a simplification: with a handful of
 * windows of history, any number presented as a likelihood would be a claim the data cannot
 * support, and it would be read as a promise by the one person it mattered to.
 *
 * ## The denominator
 *
 * "Crossed in 3 of the last 40 windows" is the obvious phrasing and the wrong one here. Windows
 * open every five minutes whether or not anybody is trading, so on a quiet venue that denominator
 * counts the clock rather than the asset — "0 of the last 288" says nothing about NVDA.
 *
 * The denominator used is windows in which this asset had a book at all. *When there was
 * something to cross, how often did it cross?* Nine of eleven is a liquid asset; zero of two is a
 * young one; no book ever is a third thing again, and the three must not collapse into each
 * other — which is the same failure the bare order count had.
 */

export interface CrossingInput {
  symbol: string;
  /** Windows in which this asset had a book. */
  booked: number;
  /** How many of those crossed size. */
  crossed: number;
  lastCrossAt: string | null;
  now?: number;
}

export interface CrossingLine {
  /** The record, as a sentence. Null when there is nothing truthful to say. */
  text: string;
  /** True once the asset has crossed at least once — the only positive state. */
  hasCrossed: boolean;
  /** No book has ever formed in this asset. Different from having books that did not cross. */
  neverBooked: boolean;
}

export function describeCrossing({
  symbol,
  booked,
  crossed,
  lastCrossAt,
  now = Date.now(),
}: CrossingInput): CrossingLine {
  if (booked <= 0) {
    return {
      // Not "never crossed": nothing has been *offered*, which is a statement about participation
      // rather than about this asset's liquidity, and the difference is the whole point.
      text: `No orders in ${symbol} have reached a crossing yet.`,
      hasCrossed: false,
      neverBooked: true,
    };
  }

  const windows = `${booked} window${booked === 1 ? "" : "s"}`;

  if (crossed <= 0) {
    return {
      text:
        booked === 1
          ? `${symbol} has had a book in one window, and it did not cross.`
          : `${symbol} has had a book in ${windows} and crossed in none of them.`,
      hasCrossed: false,
      neverBooked: false,
    };
  }

  const gap = lastCrossAt ? since(Math.max(0, now - new Date(lastCrossAt).getTime())) : null;
  const record =
    crossed === booked
      ? `${symbol} has crossed in every one of its ${windows} with a book`
      : `${symbol} has crossed in ${crossed} of ${windows} with a book`;

  return {
    text: gap ? `${record} · last cross ${gap}.` : `${record}.`,
    hasCrossed: true,
    neverBooked: false,
  };
}
