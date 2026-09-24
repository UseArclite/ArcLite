"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert, ExternalLink } from "lucide-react";
import { CHAINS, clientChainId } from "@/lib/chain/chains";
import { useT } from "../lib/i18n";

/**
 * The pool's solvency record, read live from Robinhood Chain.
 *
 * This replaces six hardcoded strings. The wording is deliberate throughout: it says **checked**,
 * not **proven**, because that is what it is. Crossing moves no tokens, so `totalUnits` changes
 * only on shield and unshield, and solvency reduces to `balanceOf(pool) >= totalUnits(asset)` —
 * something any reader can evaluate against the chain without trusting us, a prover, or a
 * verifier.
 *
 * Calling that a "proof" would be the kind of overstatement this panel exists to avoid. The
 * addresses are shown so the check can be repeated rather than believed.
 */

interface AssetSolvency {
  assetId: number;
  symbol: string;
  token: string;
  decimals: number;
  owed: string;
  held: string;
  solvent: boolean;
  surplus: string;
}

interface SolvencyResponse {
  deployed: boolean;
  reason?: string;
  error?: string;
  pool?: string;
  method?: string;
  why?: string;
  solvent?: boolean;
  assets?: AssetSolvency[];
  tree?: { root: string; leafCount: number };
  openWindowId?: string;
  paused?: boolean;
  tapeRegistry?: string | null;
  checkedAt?: string;
}

// The explorer follows the configured chain. Hardcoding the testnet one meant a mainnet pool
// would link to an address that does not exist on the explorer being linked to — a dead link on
// the one panel whose whole purpose is "go and check this yourself".
const EXPLORER = `${CHAINS[clientChainId()].blockExplorers.default.url}/address/`;
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/**
 * Raw units as a person reads them.
 *
 * The check itself is made against the raw integer — these are uint256 values and a rounded one
 * would be a different claim — so this only decides where the point goes. Six significant
 * decimals is enough for a six-decimal quote asset and for a fraction of an eighteen-decimal
 * share, and trailing zeros are dropped so a whole number looks like one.
 */
function amount(raw: string, decimals: number): string {
  const n = Number(BigInt(raw)) / 10 ** decimals;
  if (n === 0) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function SolvencyRecord() {
  const t = useT();
  const [showAll, setShowAll] = useState(false);
  const { data, isPending } = useQuery({
    queryKey: ["proofs", "solvency"],
    queryFn: async (): Promise<SolvencyResponse> => {
      const res = await fetch("/api/proofs/solvency", { credentials: "omit" });
      return (await res.json()) as SolvencyResponse;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: false,
  });

  if (isPending) {
    return (
      <dl>
        <div>
          <dt>{t("Solvency")}</dt>
          <dd>{t("Reading the chain…")}</dd>
        </div>
      </dl>
    );
  }

  if (!data?.deployed) {
    return (
      <dl>
        <div>
          <dt>{t("Solvency")}</dt>
          <dd>{data?.reason ?? "The pool is not deployed on this network yet."}</dd>
        </div>
        <div>
          <dt>{t("Method")}</dt>
          <dd>{t("On-chain invariant, once deployed")}</dd>
        </div>
      </dl>
    );
  }

  if (data.error) {
    return (
      <dl>
        <div>
          <dt>{t("Solvency")}</dt>
          <dd>Could not read the chain: {data.error}</dd>
        </div>
      </dl>
    );
  }

  // Split on whether the pool has any of it. `held` is what a reader came for; `empty` is the
  // rest of the eligible universe, true and uninteresting.
  const all = data.assets ?? [];
  const held = all.filter((a) => a.held !== "0" || a.owed !== "0");
  const empty = all.filter((a) => a.held === "0" && a.owed === "0");

  return (
    <>
      <dl>
        <div>
          <dt>{t("Solvency")}</dt>
          {/* `.proof-record dd` is right-aligned text, which put the icon on its own line and
              let the label wrap underneath it. A flex row keeps them on one baseline. */}
          <dd className={`solvency-verdict ${data.solvent ? "cyan-text" : "rose-text"}`}>
            {data.solvent ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}
            <span>{data.solvent ? "Every asset fully backed" : "Shortfall detected"}</span>
          </dd>
        </div>
        <div>
          <dt>{t("Method")}</dt>
          {/* Checked, not proven. Saying otherwise would claim a proof system is running here. */}
          <dd>{t("Verified on chain — not a ZK proof")}</dd>
        </div>
        <div>
          {/* Leaves, not notes. The tree is append-only and a settlement splices a span-aligned
              block of 32, so the count includes spent notes and the zero leaves that alignment
              skips over. Calling it "notes in the pool" read as a population and was not one. */}
          <dt>{t("Commitment tree")}</dt>
          <dd>{data.tree ? `${data.tree.leafCount.toLocaleString("en-US")} leaves` : "—"}</dd>
        </div>
        <div>
          <dt>{t("Order disclosure")}</dt>
          <dd>{t("Individual orders sealed")}</dd>
        </div>
        <div>
          <dt>{t("Trade reporting")}</dt>
          <dd>{data.tapeRegistry ? "Delayed aggregate tape, on chain" : "Not deployed"}</dd>
        </div>
        <div>
          <dt>{t("Window")}</dt>
          <dd>{data.openWindowId === "0" ? "None open" : `#${data.openWindowId}`}</dd>
        </div>
      </dl>

      <div className="solvency-table">
        <p className="ticket-note">{data.why}</p>

        {/*
          Assets the pool actually holds something of, then everything else in one line.

          The eligible universe is 36 and all but one of them hold nothing, so listing every row
          made a wall of identical zeros that buried the single number a reader came for. The
          summary is not a shortcut: "35 assets hold nothing and owe nothing" is exactly as
          checkable a statement, and it is the one worth reading. The full list is a click away
          for anyone who wants to see it.
        */}
        {held.length > 0 ? (
          held.map((a) => (
            <div key={a.assetId} className="solvency-row">
              <span className="solvency-asset">
                <b>{a.symbol}</b>
                <small>asset {a.assetId}</small>
              </span>
              <span className="solvency-figure">
                <small>owed</small>
                <b>{amount(a.owed, a.decimals)}</b>
              </span>
              <span className="solvency-figure">
                <small>held</small>
                <b>{amount(a.held, a.decimals)}</b>
              </span>
              <b className={a.solvent ? "cyan-text" : "rose-text"}>
                {a.solvent ? "BACKED" : "SHORT"}
              </b>
            </div>
          ))
        ) : (
          <p className="solvency-empty">
            {t("The pool holds nothing yet. Every eligible asset owes nothing and holds nothing.")}
          </p>
        )}

        {empty.length > 0 && (
          <button className="solvency-toggle" onClick={() => setShowAll(!showAll)}>
            {showAll
              ? "Hide the assets holding nothing"
              : `${empty.length} more eligible assets hold nothing, and owe nothing`}
          </button>
        )}

        {showAll && (
          <div className="solvency-more">
            {empty.map((a) => (
              <div key={a.assetId} className="solvency-row is-empty">
                <span className="solvency-asset">
                  <b>{a.symbol}</b>
                  <small>asset {a.assetId}</small>
                </span>
                <span className="solvency-figure">
                  <small>owed</small>
                  <b>0</b>
                </span>
                <span className="solvency-figure">
                  <small>held</small>
                  <b>0</b>
                </span>
                <b className={a.solvent ? "cyan-text" : "rose-text"}>
                  {a.solvent ? "BACKED" : "SHORT"}
                </b>
              </div>
            ))}
          </div>
        )}

        {data.pool && (
          <a
            className="solvency-link"
            href={`${EXPLORER}${data.pool}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Repeat this check yourself — pool {short(data.pool)} <ExternalLink size={13} />
          </a>
        )}
      </div>
    </>
  );
}
