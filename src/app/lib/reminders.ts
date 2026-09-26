/**
 * Being pulled back at the right moment, without telling anyone what you are waiting for.
 *
 * A batch venue with five-minute windows and market-hours guards is not something to stare at. An
 * asset can be deferred for hours because its feed is stale outside the session, and the thing a
 * trader actually wants is to be told when that stops — not to keep checking.
 *
 * ## Why this never leaves the browser
 *
 * The obvious build is a server that holds your watch list and pushes when a condition clears.
 * That server would know which assets you intend to trade and roughly when — which is a statement
 * about your intentions, and withholding exactly that is what the rest of this architecture is
 * for. Orders are salted per window so they cannot be linked across windows; a watch list sitting
 * in our database would hand back what the sealing was protecting.
 *
 * So watches live in `localStorage`, the conditions are evaluated against data the page already
 * polls, and nothing about them is ever sent anywhere. The cost is honest and worth stating: this
 * only fires while the tab is open.
 */

export type WatchKind = "undeferred" | "sealing";

export interface Watch {
  kind: WatchKind;
  /** Asset symbol for `undeferred`; unused for `sealing`. */
  symbol?: string;
  /** When it was set, so a stale watch can be aged out. */
  at: number;
}

/** What the page knows right now, and knew last time. */
export interface MarketView {
  /** Deferred state per symbol. */
  deferred: Record<string, boolean>;
  /** Seconds until the current window seals, or null when no window is open. */
  secondsToSeal: number | null;
  /** The window's sequence, so one window's countdown cannot fire for the next. */
  windowSeq: number | null;
}

export interface Fired {
  watch: Watch;
  title: string;
  body: string;
}

/** How close to sealing counts as "about to". One minute is long enough to act on. */
export const SEALING_SECONDS = 60;

/** Watches older than this are dropped: an intention from last week is not one now. */
export const WATCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export const watchId = (w: Watch): string => `${w.kind}:${w.symbol ?? ""}`;

/**
 * Which watches fire on this observation.
 *
 * Takes the previous view as well as the current one, because every condition here is a
 * **transition**. Without the previous state, "NVDA is not deferred" is true on first load for
 * every asset that was never deferred, and opening the page would fire every watch at once.
 *
 * Returns the watches that fired; the caller removes them. These are one-shot reminders — a watch
 * that survived its own firing would notify on every poll for as long as the condition held.
 */
export function fireWatches(
  watches: Watch[],
  previous: MarketView | null,
  current: MarketView,
): Fired[] {
  // Nothing to compare against. The first observation establishes a baseline and fires nothing,
  // which is why opening the dashboard is quiet.
  if (previous === null) return [];

  const fired: Fired[] = [];

  for (const watch of watches) {
    if (watch.kind === "undeferred") {
      const symbol = watch.symbol;
      if (!symbol) continue;
      const was = previous.deferred[symbol];
      const now = current.deferred[symbol];
      // Only a real transition from deferred to not. An asset absent from either view is one the
      // market has not reported, which is unknown rather than cleared.
      if (was === true && now === false) {
        fired.push({
          watch,
          title: `${symbol} is trading again`,
          body: `${symbol} is no longer deferred. It will cross in the next window that finds a counterparty.`,
        });
      }
      continue;
    }

    if (watch.kind === "sealing") {
      const s = current.secondsToSeal;
      const p = previous.secondsToSeal;
      // Crossing the threshold downward, in the same window. Comparing against the previous
      // reading is what stops this firing on every poll for the last minute of every window; the
      // window check stops a watch set at 0:59 firing again when the next window reaches 0:59.
      const sameWindow = previous.windowSeq !== null && previous.windowSeq === current.windowSeq;
      if (s !== null && p !== null && sameWindow && p > SEALING_SECONDS && s <= SEALING_SECONDS) {
        fired.push({
          watch,
          title: "The window is about to seal",
          body: `Window ${current.windowSeq} seals in under a minute. Orders submitted after that wait for the next one.`,
        });
      }
    }
  }

  return fired;
}

/** Drop watches that have aged out, so a forgotten intention does not fire next month. */
export function pruneWatches(watches: Watch[], now: number): Watch[] {
  return watches.filter((w) => now - w.at < WATCH_MAX_AGE_MS);
}

/** Add a watch, or return the list unchanged when it is already there. */
export function addWatch(watches: Watch[], watch: Watch): Watch[] {
  return watches.some((w) => watchId(w) === watchId(watch)) ? watches : [...watches, watch];
}

export function removeWatch(watches: Watch[], id: string): Watch[] {
  return watches.filter((w) => watchId(w) !== id);
}
