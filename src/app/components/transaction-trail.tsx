"use client";
import { Check, ExternalLink, Loader2, X } from "lucide-react";
import { CHAINS, clientChainId } from "@/lib/chain/chains";
import { useVault, type VaultTransaction } from "./vault-provider";
import { useT } from "../lib/i18n";

/**
 * What this vault has sent, with the hashes.
 *
 * Success used to be a sentence that vanished on the next render, and the transaction hash was
 * never shown at all. On a venue holding real money that is the wrong default twice over: a
 * deposit is two transactions and a wait, so there was nothing to look at during the part that
 * takes time, and afterwards there was no way to retrieve the one identifier that lets somebody
 * check for themselves what happened.
 *
 * Deliberately a trail rather than a toast. A toast assumes the interesting moment is the one you
 * are looking at; here the interesting moment is often several minutes ago, and the question is
 * usually "did the approval go through, or the deposit?"
 */

const LABEL: Record<VaultTransaction["kind"], string> = {
  approve: "Approve",
  deposit: "Deposit",
  withdraw: "Withdraw",
};

const short = (hash: string) => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

export function TransactionTrail() {
  const t = useT();
  const vault = useVault();
  const explorer = CHAINS[clientChainId()].blockExplorers.default.url;

  if (vault.transactions.length === 0) return null;

  return (
    <div className="tx-trail">
      <span className="eyebrow">{t("THIS SESSION")}</span>
      {vault.transactions.map((tx) => {
        const asset = vault.poolAssets.find((a) => String(a.assetId) === tx.assetId);
        return (
          <div key={tx.id} className={`tx-row is-${tx.status}`}>
            <span className="tx-icon" aria-hidden="true">
              {tx.status === "pending" ? (
                <Loader2 size={14} className="spin" />
              ) : tx.status === "confirmed" ? (
                <Check size={14} />
              ) : (
                <X size={14} />
              )}
            </span>
            <span className="tx-what">
              <b>
                {LABEL[tx.kind]}
                {asset ? ` ${asset.symbol}` : ""}
              </b>
              <small>
                {tx.status === "pending"
                  ? "waiting for confirmation…"
                  : tx.status === "confirmed"
                    ? "confirmed"
                    : (tx.error ?? "failed")}
                {/* Where the seconds went on a withdrawal. The proof is generated in this
                    browser and that is the claim worth making concrete. */}
                {tx.provingMs ? ` · proved in ${(tx.provingMs / 1000).toFixed(1)}s here` : ""}
              </small>
            </span>
            {tx.hash && (
              <a
                className="tx-link"
                href={`${explorer}/tx/${tx.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                title={tx.hash}
              >
                {short(tx.hash)} <ExternalLink size={12} />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
