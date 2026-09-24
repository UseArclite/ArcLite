/**
 * What an order will do, worked out before it is sent.
 *
 * This logic already existed, inside `submitOrder`, and it only ever spoke as a rejection after
 * the button was pressed. It was written after a buy funded by a $1 note failed to prove and took
 * the whole window down with it — every other order in that batch was collateral damage — so it
 * is load-bearing rather than cosmetic.
 *
 * Extracting it changes nothing about when it runs at submit. It adds a second caller: the order
 * panel, on every keystroke, so the same arithmetic that would reject the order explains it first.
 * One implementation and two callers is the whole point — a preview computed separately from the
 * check is a preview that can disagree with it, and disagreeing about affordability is exactly how
 * the original bug reached the chain.
 *
 * Pure: no fetch, no wallet, no worker. Everything it needs is passed in, which is what makes it
 * safe to call inside render.
 */

export interface PreflightNote {
  assetId: string;
  units: string;
  leafIndex: number;
  spent: boolean;
  epoch: number;
  counter: number;
  commitment: string;
  nullifier: string;
}

export interface PreflightAsset {
  assetId: number;
  symbol: string;
  decimals: number;
  isQuote: boolean;
}

/**
 * Generic over the caller's own note type.
 *
 * The caller spends whichever note this picks, so what comes back has to be the note it passed
 * in — every field, not the subset this file reads. A `VaultNote` narrowed to `PreflightNote` on
 * the way through would lose `origin`, and a note spent without `origin` is rebuilt as a deposit:
 * for anything a crossing returned, that rebuilds its already-spent parent.
 */
export interface PreflightInput<N extends PreflightNote = PreflightNote> {
  side: "buy" | "sell";
  /** Registry id of the asset being traded, as a string — the form's own value. */
  assetId: string;
  /** Raw units of the traded asset. */
  units: string;
  notes: N[];
  poolAssets: PreflightAsset[];
  quoteAssetId: number | null;
  /** 1e18-scaled reference for a registry id, or 0n when the market has not answered. */
  priceE18: (assetId: string) => bigint;
}

export interface PreflightResult<N extends PreflightNote = PreflightNote> {
  ok: boolean;
  /** The note that would fund this order, exactly as the caller passed it. */
  note?: N;
  /** Estimated quote units a buy would pay, at the reference showing now. */
  costRaw?: bigint;
  /** What comes back as a fresh note if the order fills completely. */
  residualRaw?: bigint;
  reason?: string;
  /** True when the numbers are an estimate rather than the committed reference. */
  estimated?: boolean;
}

/**
 * The buyer's cost, in quote units, at a 1e18-scaled reference.
 *
 * `QUOTE_SCALE` is 10^(dec_base + 18 − dec_quote) — 10^30 for an 18-decimal equity against
 * 6-decimal USDG — and the buyer pays the **ceiling**, so rounding always goes against them by at
 * most one raw unit. That direction is the circuit's, not a choice made here: matching it means
 * the estimate can never be optimistic about affordability.
 */
export function quoteCost(
  units: bigint,
  refE18: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  const scale = 10n ** BigInt(baseDecimals + 18 - quoteDecimals);
  const product = units * refE18;
  return product / scale + (product % scale === 0n ? 0n : 1n);
}

/**
 * The headroom a buy must clear, in percent of the estimated cost.
 *
 * The reference committed at seal is not the one showing now, and these feeds only move on a 0.5%
 * deviation or the daily heartbeat — so 2% is several deviations wide. Comfortably past anything
 * one five-minute window does, and far too tight to let through the kind of shortfall this exists
 * to catch, which was two orders of magnitude.
 */
const HEADROOM_PERCENT = 102n;

export function preflight<N extends PreflightNote>(input: PreflightInput<N>): PreflightResult<N> {
  const { side, assetId, units, notes, poolAssets, quoteAssetId, priceE18 } = input;

  let quantity: bigint;
  try {
    quantity = BigInt(units || "0");
  } catch {
    return { ok: false, reason: "Enter a quantity in raw units." };
  }
  if (quantity <= 0n) return { ok: false, reason: "Enter a quantity greater than zero." };

  if (side === "buy" && quoteAssetId == null) {
    return { ok: false, reason: "Buys are closed on this network: there is no quote asset." };
  }

  // A seller hands over the asset, so the note holds the asset. A buyer pays in quote, so the
  // note holds USDG. Getting this wrong is not a rejected order — it is an order that proves and
  // settles while moving nothing.
  const fundingAsset = side === "sell" ? assetId : String(quoteAssetId);
  const quote = poolAssets.find((a) => a.assetId === quoteAssetId);
  const base = poolAssets.find((a) => String(a.assetId) === assetId);

  // Largest first: a note is spent whole, so the one most likely to cover the order is the one to
  // try. The remainder returns as a fresh note, so nothing is lost by spending more than needed.
  const candidates = notes
    .filter((n) => n.assetId === fundingAsset && !n.spent)
    .sort((a, b) => (BigInt(b.units) > BigInt(a.units) ? 1 : -1));

  const note =
    side === "sell" ? candidates.find((n) => BigInt(n.units) >= quantity) : candidates[0];

  if (!note) {
    return {
      ok: false,
      reason:
        side === "sell"
          ? "No single note in your vault holds enough of that asset."
          : `A buy is paid for in ${quote?.symbol ?? "the quote asset"}, and your vault holds no ${quote?.symbol ?? "quote"} note.`,
    };
  }

  const held = BigInt(note.units);

  if (side === "sell") {
    return { ok: true, note, residualRaw: held - quantity };
  }

  const refE18 = priceE18(assetId);
  if (!base || !quote || refE18 <= 0n) {
    // No reference to price against. Allowed through rather than blocked: the market endpoint
    // being briefly unavailable is not evidence the order is unaffordable, and the circuit still
    // has the last word. Said out loud so the panel does not present a guess as a figure.
    return { ok: true, note, estimated: true };
  }

  const costRaw = quoteCost(quantity, refE18, base.decimals, quote.decimals);

  if (held * 100n < costRaw * HEADROOM_PERCENT) {
    const fmt = (v: bigint) =>
      (Number(v) / 10 ** quote.decimals).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      });
    // What would fix it, not only what is wrong. "A note is spent whole" is a genuinely
    // surprising rule — people expect balances, not notes — so leaving the arithmetic to the
    // reader is leaving them stuck.
    const short = (costRaw * HEADROOM_PERCENT) / 100n - held;
    const affordable =
      (held * 100n * 10n ** BigInt(base.decimals + 18 - quote.decimals)) /
      (HEADROOM_PERCENT * refE18);
    return {
      ok: false,
      note,
      costRaw,
      reason:
        `That buy costs about ${fmt(costRaw)} at the reference showing now, and your largest ` +
        `${quote.symbol} note holds ${fmt(held)}. A note is spent whole, so one note has to cover ` +
        `the whole order — deposit about ${fmt(short)} more ${quote.symbol}, or order at most ` +
        `${(Number(affordable) / 10 ** base.decimals).toLocaleString("en-US", { maximumFractionDigits: 6 })} ` +
        `${base.symbol}.`,
    };
  }

  return { ok: true, note, costRaw, residualRaw: held - costRaw, estimated: true };
}
