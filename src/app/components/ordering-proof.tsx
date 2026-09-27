"use client";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, Lock, ShieldCheck } from "lucide-react";
import { CHAINS, clientChainId, readClient } from "@/lib/chain/chains";
import {
  assessOrdering,
  summariseOrdering,
  type ChainStep,
  type WindowOrdering,
} from "../lib/ordering";
import { Detail } from "./panel-detail";
import { useT } from "../lib/i18n";

/**
 * The one claim this venue can prove rather than assert.
 *
 * Orders are sealed before the price they cross at exists. That is the free-option defence, and it
 * is not a policy — it is two transactions to two different contracts, `sealWindow` on the pool and
 * `commitWindow` on the price committer, in that order, on a public chain.
 *
 * ## Our server is not a source for anything on this panel
 *
 * `/api/market/ordering` returns transaction hashes and nothing else. Every block number and every
 * timestamp shown here is fetched by this component from the chain, through the same public RPC
 * anyone else can use. That is the whole point: a front-running guarantee published by the operator
 * is worth nothing, and one a visitor's own RPC confirms is worth something. A hash is safe for us
 * to serve because forging one gains nothing — the chain simply returns nothing for it.
 *
 * The verdict is decided on block *numbers*, never on timestamps. See `lib/ordering.ts` for why,
 * and for the three things this deliberately does not prove.
 */

interface OrderingRow {
  seq: number;
  sealTx: string | null;
  priceTx: string | null;
  settleTx: string | null;
}

/** Read one transaction's block and that block's timestamp, from the visitor's own RPC. */
async function stepOf(hash: string | null): Promise<ChainStep | null> {
  if (!hash) return null;
  const client = readClient();
  const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  return {
    hash,
    blockNumber: Number(receipt.blockNumber),
    timestamp: Number(block.timestamp),
  };
}

export function OrderingProof() {
  const t = useT();
  const explorer = CHAINS[clientChainId()].blockExplorers.default.url;

  const { data: rows } = useQuery({
    queryKey: ["market", "ordering"],
    staleTime: 60_000,
    queryFn: async (): Promise<OrderingRow[]> => {
      const res = await fetch("/api/market/ordering");
      const body = (await res.json()) as { windows?: OrderingRow[] };
      return body.windows ?? [];
    },
  });

  // Chain reads are their own query, keyed by the hashes, so the verdict recomputes when a new
  // window settles and not on every poll of the list.
  const { data: observed, isLoading } = useQuery({
    queryKey: ["market", "ordering", "chain", (rows ?? []).map((r) => r.seq).join(",")],
    enabled: (rows?.length ?? 0) > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<WindowOrdering[]> =>
      Promise.all(
        (rows ?? []).map(async (r) => ({
          seq: r.seq,
          seal: await stepOf(r.sealTx),
          price: await stepOf(r.priceTx),
          settle: await stepOf(r.settleTx),
        })),
      ),
  });

  if (!rows || rows.length === 0) return null;

  const results = (observed ?? []).map(assessOrdering);
  const summary = summariseOrdering(results);
  const bad = summary.verdict === "inverted";

  return (
    <section className={"ordering-proof is-" + summary.verdict}>
      <div className="panel-top">
        <div>
          <span className="eyebrow">{t("SEALED BEFORE PRICED")}</span>
          <h2>{t("We could not have priced against you")}</h2>
        </div>
        {bad ? <AlertTriangle size={19} /> : <ShieldCheck size={19} />}
      </div>

      {isLoading ? (
        <p className="ticket-note">{t("Reading the chain…")}</p>
      ) : (
        <>
          <p className="ordering-headline">{summary.headline}</p>

          <ol className="ordering-windows">
            {results.map((r) => {
              const w = (observed ?? []).find((o) => o.seq === r.seq);
              return (
                <li key={r.seq} className={"is-" + r.verdict}>
                  <div className="ordering-seq">
                    {t("Window")} {r.seq}
                    {r.blockGap !== null && (
                      <small>
                        {r.blockGap} {t("blocks")}
                        {r.seconds !== null ? ` · ${r.seconds}s` : ""}
                      </small>
                    )}
                  </div>
                  <div className="ordering-steps">
                    {(
                      [
                        ["Book frozen", w?.seal],
                        ["Price committed", w?.price],
                        ["Settled", w?.settle],
                      ] as const
                    ).map(([label, s]) => (
                      <span key={label} className="ordering-step">
                        <b>{t(label)}</b>
                        {s ? (
                          <a href={`${explorer}/tx/${s.hash}`} target="_blank" rel="noreferrer">
                            {t("block")} {s.blockNumber} <ExternalLink size={10} />
                          </a>
                        ) : (
                          <em>{t("not yet")}</em>
                        )}
                      </span>
                    ))}
                  </div>
                  <p className="ordering-statement">{r.statement}</p>
                </li>
              );
            })}
          </ol>
        </>
      )}

      <Detail label={t("Where these numbers come from")}>
        <p>
          {t(
            "Our API returns transaction hashes and nothing else. Every block number above was read by your browser from the public Robinhood Chain RPC, so none of it is a number we could have chosen. Open any of them in the explorer and check.",
          )}
        </p>
        <p>
          {t(
            "The verdict is decided on block order, not on the clock. A block timestamp is written by a sequencer; the order of blocks is what the chain is. If the seal landed in an earlier block than the price, the price cannot have informed the seal, and no clock has to be trusted for that.",
          )}
        </p>
      </Detail>

      <Detail label={t("What this does not prove")}>
        <p>
          <Lock size={12} />{" "}
          {t(
            "Not that the matcher found the best crossing — the proof shows consistency, not optimality.",
          )}
        </p>
        <p>
          {t(
            "Not that we never see order contents. We do, at reveal, which happens after the seal — sealing bounds when the operator learns, not whether.",
          )}
        </p>
        <p>
          {t(
            "Not that nothing was dropped before sealing. The orders root fixes the book at the moment it is frozen, and says nothing about an order refused before that.",
          )}
        </p>
      </Detail>
    </section>
  );
}
