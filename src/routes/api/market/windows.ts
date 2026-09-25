import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { db, hasDb } from "@/server/db";

/**
 * Recent windows and what became of each.
 *
 * "Did the last window settle?" is the first thing anyone asks after submitting an order, and the
 * venue could not answer it: `useWindow()` returns the previous window and discards it every five
 * seconds, and everything before that needed a database client.
 *
 * ## Columns are named, never selected wholesale
 *
 * `arclite.windows` carries `last_error` and `chain_error` — operator text, sometimes containing
 * RPC endpoints and revert data — alongside the public lifecycle. A `select *` here would publish
 * them, which is exactly how `/api/health` came to be serving the relayer's runway to the open
 * internet. So the column list is written out, and a field nobody added to it cannot appear.
 *
 * `reference_snapshot` and `guard_snapshot` are deliberately left out too. They are frozen per
 * window and would make good expandable detail, but they are large and nothing renders them yet.
 */
export const Route = createFileRoute("/api/market/windows")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const chainId = resolveChainId();
        if (!hasDb()) return Response.json({ chainId, windows: [] }, { status: 200 });

        const url = new URL(request.url);
        // Bounded, so a crafted `?limit=100000` cannot turn a status table into a database dump.
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25) || 25));
        const before = Number(url.searchParams.get("before") ?? 0) || null;

        try {
          const sql = db();
          const rows = await sql<
            {
              seq: string;
              status: string;
              order_count: number;
              fill_count: number;
              opens_at: Date;
              settled_at: Date | null;
              settled_tx: string | null;
              deferred_symbols: string[] | null;
            }[]
          >`
            select seq, status, order_count, fill_count, opens_at, settled_at, settled_tx,
                   deferred_symbols
              from arclite.windows
             where chain_id = ${chainId}
               ${before ? sql`and seq < ${before}` : sql``}
             order by seq desc
             limit ${limit}
          `;

          return new Response(
            JSON.stringify({
              chainId,
              windows: rows.map((r) => ({
                seq: Number(r.seq),
                status: r.status,
                orderCount: r.order_count,
                fillCount: r.fill_count,
                opensAt: r.opens_at.toISOString(),
                settledAt: r.settled_at?.toISOString() ?? null,
                settledTx: r.settled_tx,
                deferredCount: r.deferred_symbols?.length ?? 0,
              })),
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                // A window is five minutes; half a minute of staleness on a history table is free.
                "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
              },
            },
          );
        } catch (error) {
          return Response.json(
            { chainId, windows: [], error: (error as Error).message },
            { status: 200, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
