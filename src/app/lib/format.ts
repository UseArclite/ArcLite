/**
 * Money and unit formatting, and the shape of a priced asset.
 *
 * What is left of `lib/demo-market.ts` after the simulation was removed. That module also held
 * a three-symbol fixture — NVDA at $125.40, AAPL at $210.80, a quote asset called USDY, a
 * treasury NAV of 1.0842 — plus a local order book, a reducer and a matcher that produced
 * invented fills. All of it was correct for a product preview and none of it has any business
 * near a live venue.
 *
 * These two functions survive because they were never part of the simulation: they format
 * whatever number they are given, and every number on the site now comes from the chain.
 */

/**
 * A priced asset, as the dashboard indexes it.
 *
 * The three required fields are what every consumer has always used. The rest arrive in the
 * market snapshot and used to be dropped on the way through the provider — the registry has
 * carried a logo and an ISIN for every asset since the beginning, and the chain read reports how
 * old its answer is, none of which reached a pixel. They are optional because a snapshot from a
 * network without them is still a usable snapshot.
 *
 * `logoUrl` is deliberately *not* carried here even though the API serves one per asset: every
 * one of them resolves to the same Robinhood feather, so holding it would be exactly the unused
 * field this change set out to remove. `asset-mark.tsx` records how that was checked.
 */
export type StockMeta = {
  name: string;
  price: number;
  multiplier: number;
  isin?: string;
  /** Seconds since the feed last answered. Judge it against the session, never a flat bound. */
  priceAgeSeconds?: number;
  priceUpdatedAt?: string;
};

/** A symbol. Not a closed union: the eligible universe is whatever the registry lists. */
export type Asset = string;

export const cash = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

export const units = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
