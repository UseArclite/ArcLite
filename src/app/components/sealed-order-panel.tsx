"use client";
import { useEffect, useState } from "react";
import { LockKeyhole, Send } from "lucide-react";
import { useVault } from "./vault-provider";
import { useMarket } from "./market-provider";
import { preflight } from "../lib/order-preflight";
import { clientDeployment } from "@/lib/chain/chains";
import { cash } from "../lib/format";
import { feature } from "../lib/features";
import { AmountField } from "./amount-field";
import { displayAmount, formatAmount } from "../lib/units";
import { Detail } from "./panel-detail";
import { useT } from "../lib/i18n";

/**
 * Submitting a real sealed order.
 *
 * Deliberately separate from the demo ticket beside it. The demo is a simulation that needs no
 * wallet and moves nothing; this sends an encrypted order to the live venue. Collapsing them into
 * one control would make it ambiguous which one a click did, and that ambiguity is exactly the
 * wrong thing to have in a trading interface.
 *
 * The order is built and sealed inside the vault worker, so its plaintext never exists in this
 * document's scope. What leaves the browser is a commitment, two hashes and a ciphertext.
 */
export function SealedOrderPanel() {
  const t = useT();
  const vault = useVault();
  const market = useMarket();
  const tradable = vault.poolAssets.filter((a) => !a.isQuote);
  const [assetId, setAssetId] = useState("");

  // Settles as soon as the registry answers, so the form is never submittable against nothing.
  useEffect(() => {
    if (assetId === "" && tradable.length > 0) setAssetId(String(tradable[0]!.assetId));
  }, [tradable, assetId]);
  // One whole share. `30` was fine while the fixtures traded single digits, but at eighteen
  // decimals it is 3e-17 of a share — and the quote conversion floors it to nothing, so the
  // order crosses for zero and looks like a venue that does not work.
  const [units, setUnits] = useState("1000000000000000000");
  // What the person typed, alongside the integer it parsed to. Held separately so a half-typed
  // "1." survives a re-render — deriving the text back from the raw value would erase the point
  // the moment it was pressed.
  const [typed, setTyped] = useState("1");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [state, setState] = useState<{ sending: boolean; message: string | null; ok: boolean }>({
    sending: false,
    message: null,
    ok: false,
  });

  const locked = vault.status !== "unlocked";

  /**
   * What this order will do, before it is sent.
   *
   * The same function `submitOrder` runs, so the preview and the check cannot disagree — which
   * matters, because the check exists after a buy funded by a note two orders of magnitude too
   * small failed the entire window and every order in it.
   *
   * Only computed once the vault is open: locked, there are no notes to fund anything with, and
   * "no note holds enough" is a true statement that reads as a fault rather than as "sign in".
   */
  const check =
    feature("preflight") && !locked
      ? preflight({
          side,
          assetId,
          units,
          notes: vault.notes,
          poolAssets: vault.poolAssets,
          quoteAssetId: clientDeployment().quoteAssetId ?? null,
          priceE18: vault.priceE18,
        })
      : null;

  const quoteAsset = vault.poolAssets.find((a) => a.isQuote);
  const baseAsset = vault.poolAssets.find((a) => String(a.assetId) === assetId);
  // A buy is funded from quote, a sell from the asset itself — so the note the preflight picked
  // is denominated in whichever of the two this order spends.
  const funding = side === "buy" ? quoteAsset : baseAsset;
  const fundingDecimals = funding?.decimals ?? 18;
  const fundingSymbol = funding?.symbol ?? "";
  /** Raw quote units as money. Quote is six decimals, so this never approaches the float limit. */
  const money = (raw: bigint) => cash(Number(raw) / 10 ** (quoteAsset?.decimals ?? 6));
  const shares = (raw: bigint) =>
    (Number(raw) / 10 ** (baseAsset?.decimals ?? 18)).toLocaleString("en-US", {
      maximumFractionDigits: 6,
    });

  async function submit() {
    setState({ sending: true, message: null, ok: false });
    const result = await vault.submitOrder({ assetId, units, side });
    setState({
      sending: false,
      ok: result.ok,
      message: result.ok
        ? "Sealed and submitted. It stays encrypted until the window's book closes."
        : (result.reason ?? "The venue refused the order."),
    });
  }

  return (
    <section className="sealed-order-panel">
      <div className="panel-top">
        <div>
          <span className="eyebrow">{t("LIVE VENUE")}</span>
          <h2>{t("Submit a sealed order")}</h2>
        </div>
        <LockKeyhole size={19} />
      </div>

      <div className="sealed-order-fields">
        <label>
          <span>{t("Asset")}</span>
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)} disabled={locked}>
            {/* Registry ids, not symbols: the venue matches on the id the contract registered.
                The quote asset is excluded — a window may not price the asset it also pays out
                in, so an order to trade it is one the circuit would refuse. */}
            {tradable.map((a) => (
              <option key={a.assetId} value={String(a.assetId)}>
                {a.assetId} — {a.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("Side")}</span>
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as "buy" | "sell")}
            disabled={locked}
          >
            <option value="buy">Buy</option>
            <option value="sell">{t("Sell")}</option>
          </select>
        </label>
        {/* A decimal quantity, with the integer it becomes shown underneath. The raw string is
            still what `submitOrder` receives, so nothing downstream changed — the conversion is
            a way of typing a uint256, not a new representation of one. */}
        {feature("human-units") ? (
          <AmountField
            label={t("Quantity")}
            symbol={baseAsset?.symbol}
            decimals={baseAsset?.decimals ?? 18}
            value={typed}
            onChange={(text, raw) => {
              setTyped(text);
              setUnits(raw !== undefined ? raw.toString() : "");
            }}
          />
        ) : (
          <label>
            <span>{t("Raw units")}</span>
            <input
              value={units}
              inputMode="numeric"
              onChange={(e) => setUnits(e.target.value.replace(/\D/g, ""))}
              disabled={locked}
            />
          </label>
        )}
      </div>

      {check && (
        <div className={"preflight " + (check.ok ? "is-ok" : "is-blocked")} role="status">
          {check.ok && check.note ? (
            <>
              <p>
                <b>
                  {side === "buy" ? "Pays" : "Sells"} {shares(BigInt(units || "0"))}{" "}
                  {baseAsset?.symbol ?? `asset ${assetId}`}
                  {check.costRaw != null ? ` for about ${money(check.costRaw)}` : ""}
                </b>
              </p>
              <p>
                Funded by your{" "}
                {feature("human-units")
                  ? `${displayAmount(BigInt(check.note.units), fundingDecimals)} ${fundingSymbol}`
                  : `${check.note.units} raw-unit`}{" "}
                note at leaf {check.note.leafIndex}.
                {check.residualRaw != null && check.residualRaw > 0n
                  ? ` A note is spent whole, so about ${
                      side === "buy" ? money(check.residualRaw) : shares(check.residualRaw)
                    } returns to you as a fresh note.`
                  : ""}
              </p>
              <p className="preflight-caveat">
                {check.estimated
                  ? "Estimated at the reference showing now. The order crosses at the reference the contract commits after the book closes, and only if someone takes the other side this window."
                  : "Crosses only if someone takes the other side this window."}
              </p>
            </>
          ) : (
            <>
              <p>{check.reason}</p>
              {/* The arithmetic was already in the sentence; this makes it takeable. A pre-flight
                  that tells somebody the number and then leaves them to retype it is asking them
                  to do the one step it just proved they should not have to. */}
              {feature("sizing-actions") && check.affordableRaw != null && (
                <div className="preflight-actions">
                  {check.affordableRaw > 0n && (
                    <button
                      className="reset-demo"
                      onClick={() => {
                        setUnits(check.affordableRaw!.toString());
                        setTyped(formatAmount(check.affordableRaw!, baseAsset?.decimals ?? 18));
                      }}
                    >
                      {t("Order")} {shares(check.affordableRaw)} {baseAsset?.symbol ?? ""}{" "}
                      {t("instead")}
                    </button>
                  )}
                  {check.shortfallRaw != null && check.shortfallRaw > 0n && (
                    <span className="preflight-shortfall">
                      {t("or deposit")} <b>{money(check.shortfallRaw)}</b> {t("more")}{" "}
                      {quoteAsset?.symbol ?? ""}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <button
        className="seal-order-button"
        onClick={() => void submit()}
        disabled={locked || state.sending || !units}
      >
        <Send size={16} />
        {state.sending ? "Sealing…" : locked ? "Open your vault to trade" : "Seal and submit"}
      </button>

      {state.message && (
        <p role="status" className={state.ok ? "ticket-note" : "ticket-error"}>
          {state.message}
        </p>
      )}

      <p className="ticket-note">
        {market.live
          ? "Orders cross at the reference the contract commits after the book closes, not at the price shown now."
          : "Reference prices are still loading."}
      </p>

      <Detail label={t("How sealing works")}>
        <p>
          {t(
            "Built and encrypted inside your vault, so the order never exists in plaintext outside it. No cookie is sent with it — nothing links this order to your wallet address in our logs.",
          )}
        </p>
      </Detail>
    </section>
  );
}
