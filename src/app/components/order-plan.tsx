"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Layers, Pause, Play, X } from "lucide-react";
import { useVault } from "./vault-provider";
import { useWindow } from "./market-provider";
import { preflight } from "../lib/order-preflight";
import { clientDeployment } from "@/lib/chain/chains";
import {
  MAX_SLICES,
  pausePlan,
  planAction,
  planSummary,
  recordSlice,
  resumePlan,
  startPlan,
  type OrderPlan,
} from "../lib/order-plan";
import { Detail } from "./panel-detail";
import { displayAmount } from "../lib/units";
import { useT } from "../lib/i18n";

/**
 * Spreading one order over several windows, for as long as you are here.
 *
 * A single large order is identifiable by its size alone; the same size split across windows sits
 * inside whatever crowd each window has. So this is a privacy control, and it is written as one.
 *
 * **It is not unattended, and it says so.** `lib/order-plan.ts` records why that is impossible
 * here — the spend signature is bound to one window, future window ids are unpredictable, and
 * sealing needs the spending secret. What remains is a plan that runs while the vault is open and
 * pauses when the vault's idle lock closes it, with its remaining slices stated rather than
 * quietly dropped.
 *
 * The plan is held in React state and nowhere else. Not `localStorage`: a plan names the asset,
 * the side and the size of what somebody is about to trade, which is the whole thing this venue
 * withholds. It dies with the tab, like the keys.
 */

export function OrderPlanPanel({
  assetId,
  units,
  side,
  symbol,
  decimals,
}: {
  assetId: string;
  units: string;
  side: "buy" | "sell";
  symbol: string;
  decimals: number;
}) {
  const t = useT();
  const vault = useVault();
  const { window: live, secondsToSeal } = useWindow();

  const [plan, setPlan] = useState<OrderPlan | null>(null);
  const [slices, setSlices] = useState(3);
  const [status, setStatus] = useState<string | null>(null);
  // One submission at a time. The driver runs on every poll, and a slice takes seconds to seal —
  // without this, a second poll would start a second slice for the same window.
  const sending = useRef(false);

  const unlocked = vault.status === "unlocked";

  /**
   * Whether a note can fund one slice *now*.
   *
   * Against the plan's own slice size, not the form's current quantity: somebody who edits the
   * box after starting a plan has not changed the plan, and reading the box would make the
   * decision drift away from what is actually being submitted.
   */
  const fundable = (() => {
    if (!plan || !unlocked) return false;
    const check = preflight({
      side: plan.side,
      assetId: plan.assetId,
      units: plan.slice,
      notes: vault.notes,
      poolAssets: vault.poolAssets,
      quoteAssetId: clientDeployment().quoteAssetId ?? null,
      priceE18: vault.priceE18,
    });
    return check.ok && check.note != null;
  })();

  const submitSlice = useCallback(
    async (current: OrderPlan, windowSeq: number) => {
      sending.current = true;
      try {
        const result = await vault.submitOrder({
          assetId: current.assetId,
          units: current.slice,
          side: current.side,
        });
        // A refusal pauses the plan rather than retrying into the next window. The venue refuses
        // for a reason, and a plan that kept going would turn one refusal into a series of them.
        setPlan((p) =>
          p === null
            ? p
            : result.ok
              ? recordSlice(p, windowSeq)
              : pausePlan(p, result.reason ?? "The venue refused the slice."),
        );
      } finally {
        sending.current = false;
      }
    },
    [vault],
  );

  // The driver. Runs on every window poll rather than on a timer of its own: the window is the
  // clock, and a schedule counting its own minutes would drift away from the thing it paces.
  useEffect(() => {
    if (sending.current) return;
    const action = planAction({
      plan,
      vaultUnlocked: unlocked,
      windowSeq: live?.seq ?? null,
      secondsToSeal: live ? secondsToSeal : null,
      fundable,
    });
    switch (action.kind) {
      case "submit":
        if (plan && live) void submitSlice(plan, live.seq);
        return;
      case "pause":
        setPlan((p) => (p === null ? p : pausePlan(p, action.reason)));
        return;
      case "finish":
        setPlan((p) => (p === null ? p : { ...p, state: "finished" }));
        return;
      case "wait":
        setStatus(action.reason);
        return;
      default:
        return;
    }
  }, [plan, unlocked, live, secondsToSeal, fundable, submitSlice]);

  const slice = units && units !== "0" ? displayAmount(BigInt(units), decimals) : null;

  if (!plan) {
    return (
      <div className="order-plan">
        <div className="order-plan-start">
          <label>
            <span>{t("Split across")}</span>
            <input
              type="number"
              min={1}
              max={MAX_SLICES}
              value={slices}
              onChange={(e) => setSlices(Number(e.target.value))}
              disabled={!unlocked}
            />
            <span>{t("windows")}</span>
          </label>
          <button
            className="reset-demo"
            disabled={!unlocked || !units || units === "0"}
            onClick={() => {
              setStatus(null);
              setPlan(startPlan({ assetId, symbol, side, slice: units, slices }));
            }}
          >
            <Layers size={13} />
            {t("Run one per window")}
          </button>
        </div>
        {slice && (
          <p className="ticket-note">
            {t("Each window takes one order of")} {slice} {symbol}
            {". "}
            {t(
              "This runs while your vault is open and stops when its idle lock closes it — it is not a standing order.",
            )}
          </p>
        )}
        <Detail label={t("Why this is not a standing order")}>
          <p>
            {t(
              "Each order's spend authorisation is bound to the window it goes into, and a window's id is only decided when it opens — so nothing can be signed in advance for windows that do not exist yet.",
            )}
          </p>
          <p>
            {t(
              "The alternative would be for us to hold something able to seal on your behalf, which would give the operator exactly the view of your order that sealing exists to deny. So a plan runs while you are here and pauses when your vault locks, with whatever is left stated plainly.",
            )}
          </p>
        </Detail>
      </div>
    );
  }

  return (
    <div className={"order-plan is-" + plan.state}>
      <div className="order-plan-live">
        <div>
          <b>
            {plan.side === "buy" ? t("Buying") : t("Selling")}{" "}
            {displayAmount(BigInt(plan.slice), decimals)} {plan.symbol} {t("per window")}
          </b>
          <p className="ticket-note">{planSummary(plan)}</p>
        </div>
        <div className="order-plan-controls">
          {plan.state === "paused" && (
            <button
              className="reset-demo"
              disabled={!unlocked}
              onClick={() => setPlan((p) => (p ? resumePlan(p) : p))}
            >
              <Play size={13} />
              {t("Resume")}
            </button>
          )}
          {plan.state === "running" && (
            <button
              className="reset-demo"
              onClick={() => setPlan((p) => (p ? pausePlan(p, "Paused by you.") : p))}
            >
              <Pause size={13} />
              {t("Pause")}
            </button>
          )}
          <button className="reset-demo" onClick={() => setPlan(null)}>
            <X size={13} />
            {t("Clear")}
          </button>
        </div>
      </div>

      {/* The plan's own note outranks the driver's waiting message: "your vault locked" matters
          more than "this window already has a slice", and showing both would bury it. */}
      {(plan.note ?? (plan.state === "running" ? status : null)) && (
        <p role="status" className={plan.state === "paused" ? "ticket-error" : "ticket-note"}>
          {plan.note ?? status}
        </p>
      )}

      <div className="order-plan-dots" aria-hidden="true">
        {Array.from({ length: plan.total }, (_, i) => (
          <span key={i} className={i < plan.done ? "is-done" : ""} />
        ))}
      </div>
    </div>
  );
}
