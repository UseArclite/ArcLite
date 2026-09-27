import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { db, hasDb } from "@/server/db";

/**
 * The transactions behind the seal-before-price guarantee — and nothing else.
 *
 * The claim is that the book is frozen before the reference price is derived, so the operator holds
 * no free option on the window. That claim is worth very little coming from the operator's own API.
 *
 * So this route deliberately returns **only transaction hashes**. No block numbers, no timestamps,
 * no verdict. The browser reads those from its own RPC and decides for itself, which means the
 * numbers on screen cannot be ones we made up — the strongest version of this panel is the one
 * where our server is not a source for anything it asserts.
 *
 * Hashes are safe to serve because they are worthless to forge: a hash that does not exist returns
 * nothing from the chain, and one that does returns whatever it really contains.
 *
 * Only settled windows that had orders. A window nobody traded in still seals and prices, but
 * listing hundreds of empty ones would bury the two that actually carried somebody's order.
 */
export const Route = createFileRoute("/api/market/ordering")({
  server: {
    handlers: {
      GET: async () => {
        if (!hasDb()) {
          return Response.json(
            { chainId: null, windows: [] },
            { headers: { "cache-control": "no-store" } },
          );
        }

        try {
          const chainId = resolveChainId();
          const sql = db();
          const rows = await sql<
            {
              seq: string;
              sealed_tx: string | null;
              priced_tx: string | null;
              settled_tx: string | null;
            }[]
          >`
            select seq::text, sealed_tx, priced_tx, settled_tx
              from arclite.windows
             where chain_id = ${chainId}
               and order_count > 0
               and sealed_tx is not null
               and priced_tx is not null
             order by seq desc
             limit 12
          `;

          return Response.json(
            {
              chainId,
              windows: rows.map((r) => ({
                seq: Number(r.seq),
                sealTx: r.sealed_tx,
                priceTx: r.priced_tx,
                settleTx: r.settled_tx,
              })),
            },
            // Settled windows never change, but the newest one does — a minute is long enough to
            // absorb a burst and short enough that a fresh settlement is not stale on the page.
            { headers: { "cache-control": "public, max-age=60" } },
          );
        } catch (error) {
          return Response.json(
            { chainId: null, windows: [], error: (error as Error).message },
            { status: 200, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
