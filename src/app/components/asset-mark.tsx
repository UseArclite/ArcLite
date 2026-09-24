"use client";

/**
 * An asset's mark: its ticker initials, set as a typographic monogram.
 *
 * ## Why this is not the issuer's logo
 *
 * The registry carries a `logoUrl` for every tokenized asset and it looked like the obvious win —
 * thirty-six identical text rows is a list, thirty-six rows with marks is a market. The URLs are
 * per-token and distinct, so the reasonable assumption is that each one is that company's logo.
 *
 * It is not. Every one of them serves the same 180×180 PNG of the Robinhood feather: verified by
 * fetching AAPL, AMD, AMZN, ASML, BABA, GME, SLV and TSLA and finding one identical SHA across
 * all eight, each a genuine 200 rather than a placeholder. That is reasonable of the issuer —
 * these are Robinhood's own tokens — and useless here, because a mark that is the same on every
 * row distinguishes nothing while costing a request per asset and a dependency on somebody else's
 * bucket staying up.
 *
 * So the mark is drawn rather than fetched. Two letters of the ticker carry real information, load
 * instantly, cannot break, and sit inside the site's own type rather than importing another
 * brand's. If the registry ever serves per-asset artwork, this is the one place to change.
 *
 * The `t` prefix is stripped so a testnet stand-in reads as its underlying asset — `tNVDA` marks
 * as NVD, not TNV, which would otherwise make every testnet asset identical again.
 *
 * Three letters, not two. Two collides all over this registry — MSFT and MSTR both mark as MS,
 * as do SPY and SPCX, TSLA and TSM, USAR and USO, INTC and IONQ. Three separates every pair in
 * the current universe of thirty-five, and the class sets a tighter size for the longer string
 * so the circle does not change shape between a two- and a three-letter ticker.
 */
export function AssetMark({ symbol }: { symbol: string }) {
  const letters = (symbol.replace(/^t(?=[A-Z])/, "") || symbol).slice(0, 3).toUpperCase();
  return (
    <span className="asset-mark" data-len={letters.length} aria-hidden="true">
      <b>{letters}</b>
    </span>
  );
}
