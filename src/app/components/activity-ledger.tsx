"use client";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { Download, ExternalLink, ScrollText } from "lucide-react";
import { CHAINS, clientChainId } from "@/lib/chain/chains";
import { useVault } from "./vault-provider";
import { buildLedger, ledgerCsv, type ActivityEntry } from "../lib/activity-ledger";
import { displayAmount } from "../lib/units";
import { Detail } from "./panel-detail";
import { useT } from "../lib/i18n";

/**
 * Everything this vault has done, in one place.
 *
 * The pieces existed in three places that never met — deposits in the chain logs recovery reads,
 * orders in the receipts endpoint, and this browser's own record of what it sent. A holder could
 * see a balance, could see what became of one order, and could not see their own history.
 *
 * It is **reconstructed, not retrieved**, and the panel says so. `account_hash` is salted per
 * window precisely so a trader's orders cannot be linked across windows, which means no
 * server-side query for "this person's activity" exists — by design. What this merges are the
 * sources a browser can reach *because it holds the keys*, which is also why a browser that lost
 * its vault records sees less here until the recovery drill is run.
 */
export function ActivityLedger() {
  const t = useT();
  const vault = useVault();
  const { address } = useAccount();
  const chainId = clientChainId();
  const explorer = CHAINS[chainId].blockExplorers.default.url;

  const commitments = [...vault.notes, ...vault.legacyNotes]
    .map((n) => n.commitment)
    .filter((c, i, all) => all.indexOf(c) === i);

  const { data: deposits } = useQuery({
    queryKey: ["deposit-times", address],
    enabled: Boolean(address),
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/api/notes/deposits?address=${address}`, { credentials: "omit" });
      const body = (await res.json()) as {
        deposits?: { assetId: number; units: string; commitment: string; at: number | null }[];
      };
      return body.deposits ?? [];
    },
  });

  const { data: receipts } = useQuery({
    // The receipts panel's key, so the two share one response rather than asking twice.
    queryKey: ["order-receipts", commitments.slice().reverse().join(",")],
    enabled: commitments.length > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch("/api/orders/receipts", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commitments: commitments.slice().reverse() }),
      });
      const body = (await res.json()) as { receipts?: LedgerReceipt[] };
      return body.receipts ?? [];
    },
  });

  if (vault.status !== "unlocked") return null;

  const entries = buildLedger({
    deposits: deposits ?? [],
    receipts: receipts ?? [],
    transactions: vault.transactions,
  });

  if (entries.length === 0) return null;

  const symbolOf = (assetId: string | null) =>
    assetId === null
      ? "—"
      : (vault.poolAssets.find((a) => String(a.assetId) === assetId)?.symbol ?? `asset ${assetId}`);
  const decimalsOf = (assetId: string | null) =>
    vault.poolAssets.find((a) => String(a.assetId) === assetId)?.decimals ?? 18;

  function download() {
    const blob = new Blob([ledgerCsv(entries)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `arclite-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    // Revoked on the next tick rather than immediately: Safari has not finished reading the
    // blob when `click()` returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="activity-ledger">
      <div className="panel-top">
        <h2>{t("Your activity")}</h2>
        <ScrollText size={17} />
      </div>

      <div className="activity-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("When")}</th>
              <th>{t("Action")}</th>
              <th>{t("Asset")}</th>
              <th>{t("Amount")}</th>
              <th>{t("Status")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 50).map((e) => (
              <tr key={e.id} className={`is-${e.kind}`}>
                <td>{e.at === null ? "—" : when(e.at)}</td>
                <td>
                  <b>{t(e.kind)}</b>
                  {e.windowSeq !== null && <small>window {e.windowSeq}</small>}
                </td>
                <td>{symbolOf(e.assetId)}</td>
                <td>
                  {e.units === null ? "—" : displayAmount(BigInt(e.units), decimalsOf(e.assetId))}
                </td>
                <td>
                  {e.hash ? (
                    <a href={`${explorer}/tx/${e.hash}`} target="_blank" rel="noreferrer">
                      {e.status} <ExternalLink size={10} />
                    </a>
                  ) : (
                    e.status
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="vault-deposit-actions">
        <button className="reset-demo" onClick={download}>
          <Download size={13} /> {t("Download CSV")}
        </button>
      </div>

      <Detail label={t("Where this comes from")}>
        <p>
          {t(
            "Rebuilt in this browser from your own keys — your deposits on chain, the outcome of each order, and the transactions this browser sent. It is not an account statement: orders are salted per window so they cannot be linked across windows, which means no server can answer 'what has this person done'. That is the design working, and it is why a browser that lost its vault records shows less here until you run the recovery drill.",
          )}
        </p>
        <p>
          {t(
            "The CSV carries raw integer units and UTC timestamps rather than rounded display amounts, because it is the file you would hand an accountant.",
          )}
        </p>
      </Detail>
    </section>
  );
}

interface LedgerReceipt {
  commitment: string;
  windowSeq: number | null;
  orderStatus: string | null;
  settledAt: string | null;
  settledTx: string | null;
  fill: { reason: string; filledRaw: string; assetId: number; side: string } | null;
}

/** Dates in the venue's timezone, like every other time on this dashboard. */
function when(at: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
}

export type { ActivityEntry };
