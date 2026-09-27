/**
 * Proving the operator could not have priced against your order.
 *
 * The venue's central claim is that orders are sealed *before* the reference they cross at is
 * known — `plan.md` calls it the free-option defence, and `RwaDarkPool.sealWindow` freezes
 * `ordersRoot` before `PriceCommitter.commitWindow` derives the price table. Every venue says it
 * does not front-run. What makes this one different is that the ordering is two transactions to two
 * contracts, so it is a matter of public record rather than a matter of trust.
 *
 * So this turns that record into a verdict, from data the visitor's own RPC returns.
 *
 * ## Why block numbers and not timestamps
 *
 * The verdict is decided by **block number**, and the elapsed seconds are shown only as colour.
 * A block timestamp is a value a sequencer writes; a block ordering is what the chain is. If the
 * seal landed in an earlier block than the price, the price cannot have informed the seal, and no
 * clock has to be trusted for that to hold. Deciding on timestamps would make the whole argument
 * rest on the least trustworthy number in the block header.
 *
 * Two transactions can land in the *same* block, and then block order alone does not settle it —
 * the transaction index within the block does, but the two are ours to submit, so we would be
 * citing our own ordering. That case is reported as `same-block` and explicitly *not* as proof.
 *
 * ## What this does not prove
 *
 * Stated here because a panel that quietly implies more than it shows is worse than no panel:
 *
 * - **Not that the matcher found the best crossing.** `BatchCrossProof` proves consistency, not
 *   optimality, and `/proofs` says so too.
 * - **Not that we never see order contents.** We do, at reveal — which happens after the seal.
 *   Sealing bounds *when* the operator learns, not *whether*.
 * - **Not that nothing was dropped before sealing.** `ordersRoot` fixes the book at the moment it
 *   is frozen; it says nothing about an order refused before that. Pre-seal censorship is a
 *   separate, unsolved problem, and `forceIncludeOrder` is the A2 answer to it.
 */

export type OrderingVerdict = "proven" | "same-block" | "inverted" | "incomplete";

export interface ChainStep {
  /** Transaction hash, for the explorer link. */
  hash: string;
  blockNumber: number;
  /** Block timestamp, seconds. */
  timestamp: number;
}

export interface WindowOrdering {
  seq: number;
  /** `sealWindow` on the pool: the book is frozen. */
  seal: ChainStep | null;
  /** `commitWindow` on the price committer: the reference is derived on chain. */
  price: ChainStep | null;
  /** `settleBatch`: the crossing lands. */
  settle: ChainStep | null;
}

export interface OrderingResult {
  seq: number;
  verdict: OrderingVerdict;
  /** Blocks between the seal and the price. */
  blockGap: number | null;
  /** Seconds between them, as reported by the block headers. Colour, never the verdict. */
  seconds: number | null;
  /** The claim, in one sentence, matched to what was actually observed. */
  statement: string;
}

export function assessOrdering(w: WindowOrdering): OrderingResult {
  const base = { seq: w.seq, blockGap: null, seconds: null };

  if (!w.seal || !w.price) {
    return {
      ...base,
      verdict: "incomplete",
      statement:
        "This window has no seal or no on-chain price yet, so there is nothing here to check.",
    };
  }

  const blockGap = w.price.blockNumber - w.seal.blockNumber;
  const seconds = w.price.timestamp - w.seal.timestamp;

  if (blockGap > 0) {
    return {
      seq: w.seq,
      verdict: "proven",
      blockGap,
      seconds,
      statement:
        `The book was frozen in block ${w.seal.blockNumber} and the reference price was derived ` +
        `on chain ${blockGap} block${blockGap === 1 ? "" : "s"} later, in ${w.price.blockNumber}. ` +
        `The price cannot have informed the seal.`,
    };
  }

  if (blockGap === 0) {
    return {
      seq: w.seq,
      verdict: "same-block",
      blockGap,
      seconds,
      statement:
        `Both transactions landed in block ${w.seal.blockNumber}. Order within a block is decided ` +
        `by transaction index, and both of these are ours to submit — so this window is consistent ` +
        `with the ordering but does not by itself demonstrate it.`,
    };
  }

  // The unflattering case, said first and said plainly. A check that can only report good news is
  // not a check, and this venue already publishes the rows that do not flatter it.
  return {
    seq: w.seq,
    verdict: "inverted",
    blockGap,
    seconds,
    statement:
      `The reference price was committed in block ${w.price.blockNumber}, before the book was ` +
      `frozen in ${w.seal.blockNumber}. That is the wrong order and it should not happen.`,
  };
}

/** The headline across several windows: the guarantee is only as good as its worst case. */
export function summariseOrdering(results: OrderingResult[]): {
  checked: number;
  proven: number;
  verdict: OrderingVerdict;
  headline: string;
} {
  const usable = results.filter((r) => r.verdict !== "incomplete");
  const proven = usable.filter((r) => r.verdict === "proven").length;
  const inverted = usable.filter((r) => r.verdict === "inverted").length;

  if (usable.length === 0) {
    return {
      checked: 0,
      proven: 0,
      verdict: "incomplete",
      headline: "No window has both a seal and an on-chain price yet.",
    };
  }

  // One bad window outranks any number of good ones. Averaging here would let a failure hide
  // inside a percentage, which is exactly how this kind of panel becomes decoration.
  if (inverted > 0) {
    return {
      checked: usable.length,
      proven,
      verdict: "inverted",
      headline: `${inverted} of ${usable.length} windows committed a price before freezing the book.`,
    };
  }

  if (proven < usable.length) {
    return {
      checked: usable.length,
      proven,
      verdict: "same-block",
      headline: `${proven} of ${usable.length} windows are proven by block order; the rest landed in one block.`,
    };
  }

  // "Checked", not "settled": a window that sealed and priced counts here even when it never
  // settled, because the guarantee is about seal versus price. Calling them settled would put a
  // false claim directly above a row that says "not yet".
  return {
    checked: usable.length,
    proven,
    verdict: "proven",
    headline:
      usable.length === 1
        ? "The one window checked froze its book before its price existed."
        : `All ${usable.length} windows checked froze the book before the price existed.`,
  };
}
