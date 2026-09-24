"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell, BellOff, ExternalLink, X } from "lucide-react";
import { CHAINS, clientChainId } from "@/lib/chain/chains";
import { useVault } from "./vault-provider";
import {
  describeOutcome,
  newOutcomes,
  type Outcome,
  type WatchedReceipt,
} from "../lib/settlement-watch";
import { displayAmount } from "../lib/units";
import { useT } from "../lib/i18n";

/**
 * Telling somebody what became of their order.
 *
 * A window runs five minutes and settles about a minute after it seals. Nobody watches that, so
 * an outcome was discovered by accident — which makes a venue that is working feel like one that
 * is not, and makes the one genuinely bad outcome (a window that failed) indistinguishable from
 * silence.
 *
 * ## Why this is not in the receipts panel
 *
 * The receipts panel only exists while the Proofs tab is open, so a watcher living there would
 * notice nothing while somebody was looking at the market — which is where they would be. This
 * mounts once for the dashboard and shares the panel's query key, so the two dedupe rather than
 * polling the venue twice.
 *
 * ## Permission is asked for, never taken
 *
 * `Notification.requestPermission()` is called from a click and nowhere else. Prompting on load
 * is how a site teaches people to click Block, and browsers increasingly refuse it outside a
 * gesture anyway. Until somebody opts in, the toast is the whole feature — and the toast is
 * enough, because it survives the tab being backgrounded and read later.
 */

/** What this browser has already reported, per vault, so a reload is not a second first time. */
const seenKey = (fingerprint: string) => `arclite-announced-v1:${fingerprint}`;

function loadSeen(fingerprint: string): Set<string> {
  try {
    const raw = localStorage.getItem(seenKey(fingerprint));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // Private windows and blocked storage. The consequence is one duplicate announcement per
    // session, which is a better failure than staying silent about a real settlement.
    return new Set();
  }
}

function saveSeen(fingerprint: string, seen: Set<string>) {
  try {
    // Bounded: an order's outcome is announced once and then never again, so the tail is only
    // useful for suppressing repeats. A thousand is far past any real trader's history.
    localStorage.setItem(seenKey(fingerprint), JSON.stringify([...seen].slice(-1000)));
  } catch {
    /* see loadSeen */
  }
}

type Permission = "default" | "granted" | "denied" | "unsupported";

export function SettlementWatch() {
  const t = useT();
  const vault = useVault();
  const explorer = CHAINS[clientChainId()].blockExplorers.default.url;

  const [toasts, setToasts] = useState<(Outcome & { id: string })[]>([]);
  const [permission, setPermission] = useState<Permission>("default");
  const seen = useRef<Set<string> | null>(null);
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    setPermission(
      typeof Notification === "undefined" ? "unsupported" : (Notification.permission as Permission),
    );
  }, []);

  // The same commitments and the same key the receipts panel uses, so mounting both costs one
  // request rather than two.
  const commitments = [...vault.notes, ...vault.legacyNotes]
    .map((n) => n.commitment)
    .filter((c, i, all) => all.indexOf(c) === i)
    .reverse();

  const { data } = useQuery({
    queryKey: ["order-receipts", commitments.join(",")],
    enabled: vault.status === "unlocked" && commitments.length > 0,
    queryFn: async (): Promise<WatchedReceipt[]> => {
      const res = await fetch("/api/orders/receipts", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commitments }),
      });
      const body = (await res.json()) as { receipts?: WatchedReceipt[] };
      return body.receipts ?? [];
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  const naming = {
    symbol: (assetId: number) =>
      vault.poolAssets.find((a) => a.assetId === assetId)?.symbol ?? `asset ${assetId}`,
    amount: (raw: string, assetId: number) =>
      displayAmount(
        BigInt(raw),
        vault.poolAssets.find((a) => a.assetId === assetId)?.decimals ?? 18,
      ),
  };

  const announce = useCallback(
    (outcome: Outcome) => {
      const id = `${outcome.commitment}-${outcome.resolution}`;
      setToasts((prior) => [{ ...outcome, id }, ...prior].slice(0, 3));
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const { title, body } = describeOutcome(outcome, naming);
        try {
          // `tag` collapses a repeat rather than stacking it, which matters if two windows
          // resolve while the tab is in the background.
          new Notification(title, { body, tag: id, icon: "/assets/sun.svg" });
        } catch {
          // Some browsers refuse construction outside a service worker. The toast already ran.
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault.poolAssets],
  );

  useEffect(() => {
    if (!data || !vault.fingerprint) return;

    // Seed on the first look at this vault, announcing nothing. Somebody opening the dashboard
    // after a week has a history, not news.
    if (seededFor.current !== vault.fingerprint) {
      const stored = loadSeen(vault.fingerprint);
      const { resolved } = newOutcomes(data, new Set());
      for (const c of resolved) stored.add(c);
      saveSeen(vault.fingerprint, stored);
      seen.current = stored;
      seededFor.current = vault.fingerprint;
      return;
    }

    const current = seen.current ?? new Set<string>();
    const { announce: fresh, resolved } = newOutcomes(data, current);
    if (fresh.length === 0) return;

    for (const outcome of fresh) announce(outcome);
    for (const c of resolved) current.add(c);
    seen.current = current;
    saveSeen(vault.fingerprint, current);
  }, [data, vault.fingerprint, announce]);

  const ask = async () => {
    if (typeof Notification === "undefined") return;
    // From a click, and only from a click.
    const result = await Notification.requestPermission();
    setPermission(result as Permission);
  };

  if (vault.status !== "unlocked") return null;

  return (
    <>
      {/* The opt-in lives beside the outcomes it concerns rather than in a settings page, and
          disappears once answered either way. */}
      {permission === "default" && commitments.length > 0 && (
        <button className="notify-optin" onClick={() => void ask()}>
          <Bell size={13} />
          {t("Tell me when a window settles")}
        </button>
      )}
      {permission === "denied" && (
        <p className="notify-denied">
          <BellOff size={12} />{" "}
          {t("Notifications are blocked for this site. Outcomes still appear here.")}
        </p>
      )}

      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => {
          const { title, body } = describeOutcome(toast, naming);
          return (
            <article key={toast.id} className={`toast is-${toast.resolution}`}>
              <div>
                <b>{title}</b>
                <p>{body}</p>
                {toast.settledTx && (
                  <a href={`${explorer}/tx/${toast.settledTx}`} target="_blank" rel="noreferrer">
                    {t("Settled on chain")} <ExternalLink size={11} />
                  </a>
                )}
              </div>
              <button
                aria-label={t("Dismiss")}
                onClick={() => setToasts((prior) => prior.filter((x) => x.id !== toast.id))}
              >
                <X size={14} />
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
