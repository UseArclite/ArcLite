"use client";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { ArrowRight, Check, Loader2, Rocket } from "lucide-react";
import { useVault } from "./vault-provider";
import { useMarket, useWindow } from "./market-provider";
import { clientDeployment } from "@/lib/chain/chains";
import { preflight } from "../lib/order-preflight";
import {
  quickstartPlan,
  quickstartProgress,
  quickstartStep,
  type QuickstartStep,
} from "../lib/quickstart";
import { displayAmount } from "../lib/units";
import { cash } from "../lib/format";
import { Detail } from "./panel-detail";
import { useT } from "../lib/i18n";

/**
 * A first private trade on mainnet, with nothing to decide.
 *
 * The checklist in `first-run.tsx` tells somebody the four steps. This one performs them: each step
 * is a single button that acts, against amounts `quickstart.ts` derived from the live reference
 * price, and the step in hand is computed from what is actually true of the vault rather than from
 * what the flow last told anybody to do. Someone who deposited last week starts at the order step;
 * someone whose vault idle-locks mid-flow is sent back to unlock rather than shown a button that
 * cannot sign.
 *
 * ## Why this exists on mainnet rather than as a funded testnet demo
 *
 * The version everybody asks for is no-wallet and no-money: we fund a throwaway account and the
 * visitor trades for free. That cannot exist here, for two reasons worth stating rather than
 * quietly working around. Real USDG has no faucet — it is Paxos's token, with no `mint` we control.
 * And funding unscreened anonymous visitors to hold tokenized equities is the regulatory exposure
 * this venue's own plan calls existential, which is not a decision an interface should make.
 *
 * So the visitor brings about a dollar and the flow removes every other second of friction. The
 * claim at the end is stronger for it: a real tokenized equity, on mainnet, and nobody saw the
 * order.
 */

const STEPS: { key: QuickstartStep; label: string }[] = [
  { key: "connect", label: "Connect" },
  { key: "unlock", label: "Open vault" },
  { key: "deposit", label: "Deposit" },
  { key: "order", label: "Order" },
  { key: "settling", label: "Settle" },
];

export function Quickstart() {
  const t = useT();
  const vault = useVault();
  const { isConnected } = useAccount();
  const market = useMarket();
  const { window: live, secondsToSeal } = useWindow();

  const [busy, setBusy] = useState<QuickstartStep | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  /** Submitted in this session. The vault has no memory of "an order I just placed". */
  const [ordered, setOrdered] = useState(false);
  const noteCountAtOrder = useRef<number | null>(null);

  /**
   * Whether this vault has ever had an order resolve.
   *
   * A first-trade guide must disappear once there has been a first trade, and "ordered in this
   * session" does not survive a reload — after one, a funded vault would look like somebody who
   * still needs prompting to buy. Receipts are the durable answer, and this shares the receipts
   * panel's query key so mounting the flow costs no extra request.
   */
  const commitments = [...vault.notes, ...vault.legacyNotes]
    .map((n) => n.commitment)
    .filter((c, i, all) => all.indexOf(c) === i)
    .reverse();

  const { data: receipts } = useQuery({
    queryKey: ["order-receipts", commitments.join(",")],
    enabled: vault.status === "unlocked" && commitments.length > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<unknown[]> => {
      const res = await fetch("/api/orders/receipts", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commitments }),
      });
      const body = (await res.json()) as { receipts?: unknown[] };
      return body.receipts ?? [];
    },
  });

  const hasTraded = (receipts?.length ?? 0) > 0;

  const { quoteAssetId } = clientDeployment();
  const quote = vault.poolAssets.find((a) => a.isQuote);
  // The first asset the registry offers, so the flow never picks something the pool will refuse.
  const base = vault.poolAssets.find((a) => !a.isQuote);

  const plan = quickstartPlan({
    priceE18: base ? vault.priceE18(String(base.assetId)) : 0n,
    baseDecimals: base?.decimals ?? 18,
    quoteDecimals: quote?.decimals ?? 6,
  });

  // Whether a note can fund the first order — asked of the same function the order panel uses, so
  // the flow cannot advance past a step the real check would refuse.
  const funded =
    vault.status === "unlocked" && base && plan.ok
      ? preflight({
          side: "buy",
          assetId: String(base.assetId),
          units: plan.orderRaw.toString(),
          notes: vault.notes,
          poolAssets: vault.poolAssets,
          quoteAssetId: quoteAssetId ?? null,
          priceE18: vault.priceE18,
        }).ok
      : false;

  const step = quickstartStep({
    // wagmi's own answer, not a vault-derived one. `fingerprint` exists only once the vault is
    // unlocked, so deriving "connected" from it left somebody with a connected wallet staring at
    // step one while the toolbar showed their address.
    connected: isConnected,
    unlocked: vault.status === "unlocked",
    funded,
    ordered,
    // The order resolved once the vault's note set changed: the crossing spent the note and
    // returned a new one. Cheaper and more truthful than polling receipts here, because the
    // settlement watcher already announces the outcome in words.
    resolved:
      ordered && noteCountAtOrder.current !== null && vault.noteCount !== noteCountAtOrder.current,
  });

  // A vault that locks mid-flow invalidates the submitted-order state: whatever happens next needs
  // a fresh signature, and carrying "ordered" across a lock would show a settling step for an
  // order this session can no longer follow.
  useEffect(() => {
    if (vault.status !== "unlocked") {
      setOrdered(false);
      noteCountAtOrder.current = null;
    }
  }, [vault.status]);

  async function act() {
    setMessage(null);
    setBusy(step);
    try {
      if (step === "unlock") {
        // `unlock()` resolves void and reports failure through `vault.error`, which this panel
        // already renders — so there is nothing to check here, and inventing a return value would
        // mean two places deciding whether the vault opened.
        await vault.unlock();
        return;
      }
      if (step === "deposit") {
        if (!quote) return setMessage({ text: "The quote asset has not loaded.", ok: false });
        const r = await vault.shield(String(quote.assetId), plan.depositRaw.toString());
        setMessage(
          r.ok
            ? { text: "Deposited. That note exists only in your browser's key material.", ok: true }
            : { text: r.reason ?? "The deposit did not go through.", ok: false },
        );
        return;
      }
      if (step === "order") {
        if (!base || !plan.ok) return;
        const r = await vault.submitOrder({
          assetId: String(base.assetId),
          units: plan.orderRaw.toString(),
          side: "buy",
        });
        if (r.ok) {
          noteCountAtOrder.current = vault.noteCount;
          setOrdered(true);
          setMessage({
            text: "Sealed and submitted. Nobody can read it until the book closes.",
            ok: true,
          });
        } else {
          setMessage({ text: r.reason ?? "The venue refused the order.", ok: false });
        }
        return;
      }
    } catch (e) {
      setMessage({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(null);
    }
  }

  const money = (raw: bigint) => cash(Number(raw) / 10 ** (quote?.decimals ?? 6));
  const shares = (raw: bigint) => displayAmount(raw, base?.decimals ?? 18);
  const progress = quickstartProgress(step);

  const ACTION: Record<QuickstartStep, { title: string; body: string; cta: string | null }> = {
    connect: {
      title: t("Connect MetaMask"),
      body: t("Nothing is signed and no transaction is approved by connecting."),
      cta: null, // the toolbar's connect button is the only place that should open a wallet
    },
    unlock: {
      title: t("Open your private vault"),
      body: t(
        "One signature derives the keys that find and spend your notes. They live in a worker this tab owns and are never sent anywhere.",
      ),
      cta: t("Sign to open"),
    },
    deposit: {
      title: `${t("Deposit")} ${money(plan.depositRaw)} ${quote?.symbol ?? ""}`,
      body: t(
        "An approval and a deposit. This part is public — a transfer from your address, like every shielded pool. What it buys is that nothing after it is.",
      ),
      cta: `${t("Deposit")} ${money(plan.depositRaw)}`,
    },
    order: {
      title: plan.ok
        ? `${t("Buy")} ${shares(plan.orderRaw)} ${base?.symbol ?? ""}`
        : t("Waiting for a reference price"),
      body: plan.ok
        ? t(
            "Sealed in your browser and submitted encrypted. It crosses at the reference the contract commits after the book closes — which is why nobody, including us, can price against it.",
          )
        : (plan.reason ?? ""),
      cta: plan.ok ? `${t("Seal and submit")}` : null,
    },
    settling: {
      title: t("Your order is in the book"),
      body: live
        ? `${t("Window")} ${live.seq} ${t("seals in")} ${Math.max(0, secondsToSeal)}s. ${t("It crosses only if someone takes the other side.")}`
        : t("Waiting for the window to close."),
      cta: null,
    },
    done: {
      title: t("That was a private trade on mainnet"),
      body: t(
        "Your note was spent and a new one returned. The chain records a nullifier and a commitment — not the asset, not the size, not the side.",
      ),
      cta: null,
    },
  };

  const current = ACTION[step];
  const working = busy !== null;

  // Somebody who has traded before does not need a first-trade guide. `ordered` keeps the panel up
  // through the session that produced the trade, so the last step is actually seen rather than
  // vanishing at the moment it succeeds.
  if (hasTraded && !ordered) return null;

  return (
    <section className={"quickstart is-" + step}>
      <div className="panel-top">
        <div>
          <span className="eyebrow">{t("START HERE")}</span>
          <h2>{t("Your first private trade")}</h2>
        </div>
        <Rocket size={19} />
      </div>

      <ol className="quickstart-rail">
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className={
              progress > i ? "is-done" : quickstartProgress(step) === i ? "is-current" : "is-todo"
            }
          >
            <span className="quickstart-dot">{progress > i ? <Check size={11} /> : i + 1}</span>
            <span>{t(s.label)}</span>
          </li>
        ))}
      </ol>

      <div className="quickstart-action">
        <h3>{current.title}</h3>
        <p>{current.body}</p>
        {current.cta && (
          <button className="seal-order-button" onClick={() => void act()} disabled={working}>
            {working ? <Loader2 size={15} className="spin" /> : <ArrowRight size={15} />}
            {working ? t("Working…") : current.cta}
          </button>
        )}
        {step === "connect" && (
          <p className="ticket-note">{t("Use the Connect button in the toolbar above.")}</p>
        )}
      </div>

      {(message || vault.error) && (
        <p role="status" className={message?.ok ? "ticket-note" : "ticket-error"}>
          {message?.text ?? vault.error}
        </p>
      )}

      <Detail label={t("Why a dollar, and why your own")}>
        <p>
          {t(
            "The amounts are computed from the live reference price so that the first order is one your funding note can actually cover — a first attempt that fails its own pre-flight check is worse than no guidance at all.",
          )}
        </p>
        <p>
          {t(
            "We do not fund this for you. Real USDG has no faucet, and handing an unscreened visitor a funded position in tokenized equities is a regulatory decision, not an interface one. Bringing your own dollar is what makes this a real trade rather than a simulation.",
          )}
        </p>
      </Detail>

      {!market.snapshot && (
        <p className="ticket-note">{t("Reference prices are still loading.")}</p>
      )}
    </section>
  );
}
