"use client";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useVault } from "./vault-provider";
import { useMarket } from "./market-provider";
import { cash } from "../lib/format";
import { quantity, valueUsd } from "../lib/holdings-math";
import { AssetMark } from "./asset-mark";
import { feature } from "../lib/features";
import { useT } from "../lib/i18n";

/**
 * What the vault holds, in money.
 *
 * The Portfolio tab could not answer "what am I worth?" — the one question a portfolio view
 * exists to answer. It listed `Asset 3 / 1000000000000000000 raw units`, which is precise, true,
 * and unreadable.
 *
 * Nothing new is fetched. The join is `vault.balances` (assetId → units) × `vault.poolAssets`
 * (assetId → symbol, decimals) × the market snapshot (symbol → price). The provider already does
 * exactly this join internally, for the order affordability check; it was simply never exposed.
 *
 * ## The rule this panel follows
 *
 * Quantities are computed in BigInt and converted to a float only at the last step, for the
 * currency format. Raw units are uint256 and a value above 2^53 rounds silently as a JS number —
 * a balance that quietly rounds is worse than one that is hard to read, because it looks correct.
 *
 * The raw figure stays available beneath each row. This is a venue whose pitch is that you can
 * check its claims; hiding the number the chain actually holds would be the wrong instinct.
 */

export function Holdings() {
  const t = useT();
  const vault = useVault();
  const market = useMarket();
  const [hidden, setHidden] = useState(false);

  if (vault.balances.length === 0) return null;

  const rows = vault.balances.map((b) => {
    const asset = vault.poolAssets.find((a) => String(a.assetId) === b.assetId);
    const symbol = asset?.symbol ?? `asset ${b.assetId}`;
    const decimals = asset?.decimals ?? 18;
    const raw = BigInt(b.units);
    // The quote asset has no equity feed; it is the unit everything else is priced in, so its
    // own reference is the peg the market snapshot reports rather than a per-asset price.
    const price1e18 = asset?.isQuote
      ? BigInt(Math.round((market.nav || 1) * 1e18))
      : vault.priceE18(b.assetId);
    return {
      assetId: b.assetId,
      symbol,
      decimals,
      raw,
      quantity: quantity(raw, decimals),
      value: valueUsd(raw, decimals, price1e18),
      priced: price1e18 > 0n,
    };
  });

  const total = rows.reduce((sum, r) => sum + r.value, 0);
  const anyUnpriced = rows.some((r) => !r.priced);
  const blur = (text: string) => (hidden ? "••••" : text);

  return (
    <div className="holdings">
      <div className="holdings-top">
        <div>
          <span className="eyebrow">{t("YOUR POSITION")}</span>
          <strong className="holdings-total">{market.live ? blur(cash(total)) : "—"}</strong>
        </div>
        {/* Apt on a privacy venue rather than decorative: the balance is the thing somebody
            standing behind you would read. */}
        <button
          className="holdings-hide"
          onClick={() => setHidden(!hidden)}
          aria-pressed={hidden}
          aria-label={hidden ? "Show balances" : "Hide balances"}
        >
          {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>

      <div className="holdings-rows">
        {rows.map((r) => (
          <div key={r.assetId} className="holding-row">
            <span className="holding-asset">
              {feature("logos") && <AssetMark symbol={r.symbol} />}
              <span>
                <b>{r.symbol}</b>
                <small>asset {r.assetId}</small>
              </span>
            </span>
            <span className="holding-qty">
              <b>{blur(r.quantity)}</b>
              {/* The number the chain holds, kept in reach. */}
              <small title={r.raw.toString()}>{blur(r.raw.toString())} raw</small>
            </span>
            <span className="holding-value">
              <b>{market.live && r.priced ? blur(cash(r.value)) : "—"}</b>
              <small>
                {market.live && total > 0 && r.priced
                  ? `${((r.value / total) * 100).toFixed(1)}%`
                  : "unpriced"}
              </small>
            </span>
          </div>
        ))}
      </div>

      <p className="ticket-note">
        {market.live
          ? `Priced at the reference showing now, not at the reference any order will cross at.${
              anyUnpriced ? " Assets with no live reference are shown without a value." : ""
            }`
          : "Waiting for live references before pricing this position."}
      </p>
    </div>
  );
}
