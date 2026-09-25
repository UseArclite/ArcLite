/**
 * Whether a lit market exists for an asset, said in a way that is worth reading.
 *
 * The dashboard can already tell somebody that an asset has crossed in none of its windows. True,
 * discouraging, and half the picture: NVDA has never crossed here and has **$3.5 million** of
 * two-sided liquidity on the public DEX a block away. One of those facts alone says "don't
 * bother"; the pair says "there is a market, it just isn't in here yet", which is the accurate
 * thing and also the only version that gives somebody a reason to be first.
 *
 * ## The dust problem
 *
 * A pool is a real contract whether or not anybody funded it. Reading them across four fee tiers
 * finds pairs holding one dollar, and a few holding a fraction of a token and no quote at all.
 * Reporting those as "lit liquidity" would be worse than saying nothing — it would be an
 * encouraging number attached to a market that cannot absorb a single order.
 *
 * So a floor, stated rather than implied, and a separate answer for "a pool exists but is empty"
 * versus "no pool at all". The first is a venue somebody may yet fund; the second is an asset
 * nobody has listed.
 */

/** Below this much quote in the pool, there is no market worth naming. */
export const DUST_FLOOR_USD = 1_000;

export interface LitMarketInput {
  symbol: string;
  /** Raw quote units sitting in the deepest pool, or null when no pool exists. */
  quoteRaw: string | null;
  quoteDecimals: number;
  /** Fee tier as the factory stores it: 3000 is 0.30%. */
  feeTier: number | null;
}

export interface LitMarketLine {
  /** What to render, or null when there is nothing honest and useful to say. */
  text: string | null;
  /** A market big enough to matter. */
  hasMarket: boolean;
  /** Quote units in whole tokens, for callers that want the number rather than the sentence. */
  quote: number;
}

/** Compact money, because "$3,566,303" in a one-line status is noise. */
export function briefUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
}

/** A fee tier as a person writes it. The factory stores hundredths of a basis point. */
export function feeLabel(tier: number): string {
  const pct = tier / 10_000;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(2).replace(/0$/, "")}%`;
}

export function describeLitMarket({
  symbol,
  quoteRaw,
  quoteDecimals,
  feeTier,
}: LitMarketInput): LitMarketLine {
  if (quoteRaw === null || feeTier === null) {
    // No pool at all. Said plainly rather than left blank, because "nothing here and nothing
    // anywhere" is a different decision from "nothing here, plenty next door".
    return {
      text: `No lit market for ${symbol} on this chain either.`,
      hasMarket: false,
      quote: 0,
    };
  }

  const quote = Number(BigInt(quoteRaw)) / 10 ** quoteDecimals;

  if (quote < DUST_FLOOR_USD) {
    return {
      text: `A ${symbol} pool exists on the public DEX but is effectively unfunded.`,
      hasMarket: false,
      quote,
    };
  }

  return {
    text: `${briefUsd(quote)} of lit ${symbol} liquidity on the public DEX, at ${feeLabel(feeTier)}.`,
    hasMarket: true,
    quote,
  };
}
