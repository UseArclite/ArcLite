/**
 * The batch matcher.
 *
 * This is the one piece of off-chain logic the circuit has to agree with exactly. `batch_cross`
 * does not re-derive the crossing — it *constrains* it, with inequalities that pin the matcher
 * to a unique answer. So this file and the circuit are two statements of the same rule, and a
 * disagreement between them is a proof that will not generate. Everything here is therefore
 * integer-only, deterministic, and free of any input the circuit cannot also see.
 *
 * ## The rule
 *
 * Within one window and one asset, buyers and sellers cross at the committed reference price.
 * Nobody chooses a fill rate: the matched size is
 *
 *     M = min(total buy quantity, total sell quantity)
 *
 * and each order on the long side receives its **exact pro-rata share of M**, allocated by the
 * largest-remainder method so the parts sum to M with no rounding drift. The short side fills
 * completely. Residual quantity rests and is returned to the trader as a draft.
 *
 * Largest-remainder is not an implementation detail. It is what makes
 * `|filled_i × T − q_i × M| < T` true for every order — the circuit's anti-favouritism
 * constraint — while keeping `Σ filled = M` exact. Rounding each share independently would
 * satisfy the first and break the second.
 *
 * ## Determinism
 *
 * Replaying a window must produce byte-identical output, or the proof cannot be regenerated after
 * a crash. Two things could break that and are handled explicitly: the tie-break when two orders
 * have equal remainders (resolved by `seq`, assigned at seal, never by map iteration order), and
 * the asset iteration order (sorted by `assetId`).
 *
 * ## Rounding direction
 *
 * Buyers pay `ceil`, sellers receive `floor`. The difference cannot go to either party without
 * making one of them worse off than the reference, so it accrues as dust to the fee vault — which
 * keeps `Σ paid = Σ received + fee + dust` exact in raw units. A venue that let rounding fall
 * where it may would leak value one wei at a time, in a direction nobody chose.
 */

export type Side = "buy" | "sell";

export interface MatchOrder {
  /** Position in the sealed book. The tie-break, and the reason replay is deterministic. */
  seq: number;
  assetId: number;
  side: Side;
  /** Raw token units, never a decimal string. */
  quantity: bigint;
}

export interface AssetReference {
  assetId: number;
  /** USD per whole token, 1e18-scaled, as committed on-chain by `PriceCommitter`. */
  price1e18: bigint;
  /** Token decimals. Stocks are 18 on Robinhood Chain; the quote asset is 6. */
  decimals: number;
  /** Set by the on-chain defer mask. A deferred asset does not cross at all. */
  deferred: boolean;
  /** Why, for the receipt. `stale` and `event` map to the two the dashboard renders. */
  deferReason?: "stale" | "event";
}

export interface QuoteReference {
  price1e18: bigint;
  decimals: number;
}

export type FillReason = "matched" | "partial" | "unmatched" | "stale" | "event";

export interface Fill {
  seq: number;
  assetId: number;
  side: Side;
  quantity: bigint;
  filled: bigint;
  /** Quote units moved: paid by a buyer, received by a seller. */
  quote: bigint;
  residual: bigint;
  reason: FillReason;
}

export interface AssetResult {
  assetId: number;
  /** Matched size, in base units. Zero for a deferred or one-sided asset. */
  matched: bigint;
  buyTotal: bigint;
  sellTotal: bigint;
  deferred: boolean;
}

export interface MatchResult {
  fills: Fill[];
  assets: AssetResult[];
  /** Rounding residue owed to the fee vault, in quote units. Never negative. */
  dust: bigint;
  /** Total quote paid by buyers. */
  paid: bigint;
  /** Total quote received by sellers. */
  received: bigint;
}

/** Integer division rounding toward +infinity. Never used on a negative numerator here. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Quote units for `units` of the base asset at the committed references.
 *
 *     quote = units × P_base × 10^dec_quote / (P_quote × 10^dec_base)
 *
 * `P_quote` is a variable from the first line rather than an assumed 1e18, because retrofitting
 * a second reference after the fact is a week of work across the circuit, the contract and this
 * file. Today it is the USDG peg; when the treasury lane opens it is a NAV.
 *
 * The multiplications happen before any division, so no intermediate is truncated. Raw units are
 * uint256 and prices are 1e18, so this can reach ~2^200 — fine for bigint, and the circuit
 * range-asserts `units < 2^96` and `price < 2^80` for exactly the reason it is not fine there.
 */
export function quoteValue(
  units: bigint,
  base: Pick<AssetReference, "price1e18" | "decimals">,
  quote: QuoteReference,
  rounding: "floor" | "ceil",
): bigint {
  const numerator = units * base.price1e18 * pow10(quote.decimals);
  const denominator = quote.price1e18 * pow10(base.decimals);
  if (denominator === 0n) throw new Error("quote reference price is zero");
  return rounding === "ceil" ? ceilDiv(numerator, denominator) : numerator / denominator;
}

/**
 * Allocate `total` across `weights` in exact proportion, with the parts summing to `total`.
 *
 * Largest-remainder: floor every share, then hand the shortfall to the orders with the largest
 * fractional parts, one unit each. Ties go to the lower `seq`, so the result never depends on
 * sort stability or map ordering.
 *
 * Returns shares aligned with `weights` by index.
 */
export function proRata(
  weights: readonly { seq: number; weight: bigint }[],
  total: bigint,
): bigint[] {
  const sum = weights.reduce((acc, w) => acc + w.weight, 0n);
  if (sum === 0n || total === 0n) return weights.map(() => 0n);
  if (total > sum) throw new Error("cannot allocate more than the total weight");

  const shares = weights.map((w) => (w.weight * total) / sum);
  let allocated = shares.reduce((a, b) => a + b, 0n);
  let shortfall = total - allocated;

  if (shortfall > 0n) {
    // Remainder of w_i × total / sum, compared without ever forming a fraction.
    const ranked = weights
      .map((w, index) => ({ index, seq: w.seq, remainder: (w.weight * total) % sum }))
      .sort((a, b) =>
        a.remainder === b.remainder ? a.seq - b.seq : a.remainder > b.remainder ? -1 : 1,
      );

    for (const entry of ranked) {
      if (shortfall === 0n) break;
      shares[entry.index] += 1n;
      shortfall -= 1n;
    }
  }

  allocated = shares.reduce((a, b) => a + b, 0n);
  // A loop that silently under-allocated would leak units into nothing, so this is an assertion,
  // not a comment.
  if (allocated !== total) throw new Error(`pro-rata allocated ${allocated}, expected ${total}`);
  return shares;
}

function reasonFor(filled: bigint, quantity: bigint, deferReason?: "stale" | "event"): FillReason {
  if (deferReason) return deferReason;
  if (filled === 0n) return "unmatched";
  if (filled === quantity) return "matched";
  return "partial";
}

/**
 * Cross one sealed window.
 *
 * Pure: same inputs, same output, every time. It reads no clock, no database and no randomness,
 * which is what lets a crashed window be replayed and re-proved rather than voided.
 */
export function matchWindow(
  orders: readonly MatchOrder[],
  references: readonly AssetReference[],
  quote: QuoteReference,
): MatchResult {
  const byId = new Map(references.map((r) => [r.assetId, r]));

  // Sorted, not grouped by encounter order: iteration order over a Map is insertion order, which
  // would make the output depend on how the book happened to be read out of Postgres.
  const assetIds = [...new Set(orders.map((o) => o.assetId))].sort((a, b) => a - b);

  const fills: Fill[] = [];
  const assets: AssetResult[] = [];
  let paid = 0n;
  let received = 0n;

  for (const assetId of assetIds) {
    const reference = byId.get(assetId);
    if (!reference) throw new Error(`no committed reference for asset ${assetId}`);

    const book = orders.filter((o) => o.assetId === assetId).sort((a, b) => a.seq - b.seq);
    const buys = book.filter((o) => o.side === "buy");
    const sells = book.filter((o) => o.side === "sell");
    const buyTotal = buys.reduce((a, o) => a + o.quantity, 0n);
    const sellTotal = sells.reduce((a, o) => a + o.quantity, 0n);

    // A deferred asset crosses nothing, and does not hold up any other asset. This is acceptance
    // criterion 3: the guard defers its own asset alone.
    if (reference.deferred) {
      for (const order of book) {
        fills.push({
          seq: order.seq,
          assetId,
          side: order.side,
          quantity: order.quantity,
          filled: 0n,
          quote: 0n,
          residual: order.quantity,
          reason: reference.deferReason ?? "stale",
        });
      }
      assets.push({ assetId, matched: 0n, buyTotal, sellTotal, deferred: true });
      continue;
    }

    const matched = buyTotal < sellTotal ? buyTotal : sellTotal;
    const buyShares = proRata(
      buys.map((o) => ({ seq: o.seq, weight: o.quantity })),
      matched,
    );
    const sellShares = proRata(
      sells.map((o) => ({ seq: o.seq, weight: o.quantity })),
      matched,
    );

    buys.forEach((order, i) => {
      const filled = buyShares[i]!;
      // Buyers pay the ceiling: never less than the reference value of what they received.
      const cost = quoteValue(filled, reference, quote, "ceil");
      paid += cost;
      fills.push({
        seq: order.seq,
        assetId,
        side: "buy",
        quantity: order.quantity,
        filled,
        quote: cost,
        residual: order.quantity - filled,
        reason: reasonFor(filled, order.quantity),
      });
    });

    sells.forEach((order, i) => {
      const filled = sellShares[i]!;
      // Sellers receive the floor, for the same reason in the other direction.
      const proceeds = quoteValue(filled, reference, quote, "floor");
      received += proceeds;
      fills.push({
        seq: order.seq,
        assetId,
        side: "sell",
        quantity: order.quantity,
        filled,
        quote: proceeds,
        residual: order.quantity - filled,
        reason: reasonFor(filled, order.quantity),
      });
    });

    assets.push({ assetId, matched, buyTotal, sellTotal, deferred: false });
  }

  fills.sort((a, b) => a.seq - b.seq);

  const dust = paid - received;
  if (dust < 0n) throw new Error(`buyers paid less than sellers received by ${-dust}`);

  return { fills, assets, dust, paid, received };
}

/**
 * Re-derive the invariants the circuit constrains, from the result alone.
 *
 * Used by the tests and by the settler before it spends gas. Returning the list of violations
 * rather than throwing means a failure names every broken property at once, which is what you
 * want at three in the morning.
 */
export function checkInvariants(result: MatchResult): string[] {
  const problems: string[] = [];

  for (const asset of result.assets) {
    const fills = result.fills.filter((f) => f.assetId === asset.assetId);
    const buyFilled = fills.filter((f) => f.side === "buy").reduce((a, f) => a + f.filled, 0n);
    const sellFilled = fills.filter((f) => f.side === "sell").reduce((a, f) => a + f.filled, 0n);

    if (buyFilled !== sellFilled) {
      problems.push(`asset ${asset.assetId}: buys filled ${buyFilled}, sells filled ${sellFilled}`);
    }
    if (buyFilled !== asset.matched) {
      problems.push(
        `asset ${asset.assetId}: filled ${buyFilled} but matched size is ${asset.matched}`,
      );
    }
    // M must be the largest crossable size. Any smaller and the matcher withheld liquidity.
    const cap = asset.buyTotal < asset.sellTotal ? asset.buyTotal : asset.sellTotal;
    if (!asset.deferred && asset.matched !== cap) {
      problems.push(`asset ${asset.assetId}: matched ${asset.matched}, could have matched ${cap}`);
    }
    if (asset.deferred && asset.matched !== 0n) {
      problems.push(`asset ${asset.assetId}: deferred but matched ${asset.matched}`);
    }

    // Anti-favouritism: every fill within one raw unit of exact pro-rata.
    for (const side of ["buy", "sell"] as const) {
      const sideFills = fills.filter((f) => f.side === side);
      const total = sideFills.reduce((a, f) => a + f.quantity, 0n);
      if (total === 0n) continue;
      for (const fill of sideFills) {
        const deviation = fill.filled * total - fill.quantity * asset.matched;
        const magnitude = deviation < 0n ? -deviation : deviation;
        if (magnitude >= total) {
          problems.push(
            `order ${fill.seq}: fill deviates from pro-rata by ${magnitude} ≥ ${total}`,
          );
        }
      }
    }
  }

  for (const fill of result.fills) {
    if (fill.filled > fill.quantity) problems.push(`order ${fill.seq}: filled more than ordered`);
    if (fill.filled + fill.residual !== fill.quantity) {
      problems.push(`order ${fill.seq}: filled + residual ≠ quantity`);
    }
    if (fill.filled < 0n || fill.residual < 0n) problems.push(`order ${fill.seq}: negative amount`);

    const expected = reasonFor(
      fill.filled,
      fill.quantity,
      fill.reason === "stale" || fill.reason === "event" ? fill.reason : undefined,
    );
    if (fill.reason !== expected) {
      problems.push(`order ${fill.seq}: reason ${fill.reason} but fill says ${expected}`);
    }
  }

  if (result.paid !== result.received + result.dust) {
    problems.push(
      `value leak: paid ${result.paid} ≠ received ${result.received} + dust ${result.dust}`,
    );
  }
  if (result.dust < 0n) problems.push(`negative dust ${result.dust}`);

  return problems;
}
