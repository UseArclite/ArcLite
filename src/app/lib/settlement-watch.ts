/**
 * Deciding what is worth interrupting somebody for.
 *
 * A window runs five minutes and settles about a minute after it seals, so nobody watches one
 * end to end. Outcomes were therefore discovered by accident — which makes a venue that is
 * working feel like one that is not.
 *
 * The decision is kept here, away from the component, because every interesting case is a
 * *sequence* rather than a state: what matters is which outcomes appeared while this browser was
 * watching, not which outcomes exist. That distinction is the whole feature and it is impossible
 * to test through a toast.
 *
 * ## The rule that stops it being spam
 *
 * The first observation announces nothing. A trader opening the dashboard after a week has
 * dozens of settled orders and none of them are news; firing a notification per resolved order
 * on unlock would be the last time they left notifications on. So the first pass **seeds** the
 * set of outcomes already known, and only transitions observed afterwards are announced.
 *
 * The seed is persisted, so a reload is not a second first-time.
 */

export type Resolution = "filled" | "partial" | "unmatched" | "deferred" | "void";

export interface WatchedReceipt {
  commitment: string;
  windowSeq: number | null;
  windowStatus: string | null;
  settledTx: string | null;
  fill: {
    reason: string;
    filledRaw: string;
    quoteRaw: string;
    assetId: number;
    side: string;
    quantityRaw: string;
  } | null;
}

export interface Outcome {
  commitment: string;
  windowSeq: number | null;
  resolution: Resolution;
  settledTx: string | null;
  fill: WatchedReceipt["fill"];
}

/**
 * Whether this order's story has ended, and how.
 *
 * A window that failed or voided is an outcome worth announcing in its own right: nothing
 * crossed and the note was never spent, which is good news that otherwise looks like silence.
 */
export function resolutionOf(r: WatchedReceipt): Resolution | null {
  if (r.windowStatus === "FAILED" || r.windowStatus === "VOID") return "void";
  if (!r.fill) return null;
  switch (r.fill.reason) {
    case "matched":
      return "filled";
    case "partial":
      return "partial";
    case "stale":
    case "event":
      return "deferred";
    default:
      return "unmatched";
  }
}

/**
 * What changed since the last look.
 *
 * `seen` is mutated by the caller from `announce` — returned rather than applied here so the
 * caller decides whether an outcome it failed to deliver should be retried on the next pass.
 */
export function newOutcomes(
  receipts: readonly WatchedReceipt[],
  seen: ReadonlySet<string>,
): { announce: Outcome[]; resolved: string[] } {
  const announce: Outcome[] = [];
  const resolved: string[] = [];

  for (const r of receipts) {
    const resolution = resolutionOf(r);
    if (!resolution) continue;
    resolved.push(r.commitment);
    if (seen.has(r.commitment)) continue;
    announce.push({
      commitment: r.commitment,
      windowSeq: r.windowSeq,
      resolution,
      settledTx: r.settledTx,
      fill: r.fill,
    });
  }

  return { announce, resolved };
}

/**
 * One line, said the way the receipts panel says it, because a notification that disagrees with
 * the page it links to is worse than no notification.
 */
export function describeOutcome(
  o: Outcome,
  names: { symbol: (assetId: number) => string; amount: (raw: string, assetId: number) => string },
): { title: string; body: string } {
  const window = o.windowSeq ? `Window ${o.windowSeq}` : "Your order";
  if (o.resolution === "void") {
    return {
      title: `${window} did not settle`,
      body: "Nothing crossed and your note was never spent. It is still yours to spend or withdraw.",
    };
  }
  if (!o.fill) return { title: `${window} settled`, body: "Your order has an outcome." };

  const symbol = names.symbol(o.fill.assetId);
  const side = o.fill.side === "buy" ? "Buy" : "Sell";
  const wanted = names.amount(o.fill.quantityRaw, o.fill.assetId);

  switch (o.resolution) {
    case "filled":
      return {
        title: `${side} filled — ${wanted} ${symbol}`,
        body: `${window} settled. Your note has been replaced by what the crossing gave you.`,
      };
    case "partial":
      return {
        title: `${side} partly filled — ${names.amount(o.fill.filledRaw, o.fill.assetId)} of ${wanted} ${symbol}`,
        body: `${window} settled. The rest came back to you as a note.`,
      };
    case "deferred":
      return {
        title: `${side} deferred — ${symbol}`,
        body: `${window} settled, but ${symbol} was guarded and did not cross. Your note is unchanged.`,
      };
    default:
      return {
        title: `No counterparty — ${wanted} ${symbol}`,
        body: `${window} settled with nobody on the other side. Nothing crossed and your note is unchanged.`,
      };
  }
}
