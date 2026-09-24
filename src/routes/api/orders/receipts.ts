import { createFileRoute } from "@tanstack/react-router";
import { db, hasDb } from "@/server/db";
import { resolveChainId } from "@/lib/chain/chains";

/**
 * What became of the orders a browser submitted.
 *
 * Asked by commitment, because nothing else can ask at all. `account_hash` is salted with the
 * window's own public key, so it links a trader's orders *within* a window and deliberately
 * cannot link them across windows — which is the privacy property working, and also means there
 * is no server-side query for "this person's orders". Only the browser that built them knows
 * which commitments were its own.
 *
 * That makes this endpoint a lookup, not a search. It answers about commitments the caller
 * already names, and the venue already saw every one of them at submission, so asking reveals
 * nothing it did not already hold. What stays on the client is the interesting half: which
 * commitment was which asset, which side, and how much.
 *
 * No session, and `credentials: "omit"` on the caller. A cookie here would put the
 * address-to-order link in our own logs, which is exactly what the submit path avoids.
 */

const MAX = 50;

interface Receipt {
  commitment: string;
  windowSeq: number | null;
  /** The id the *pool* knows. Settlement derives output notes from it, so a client rebuilding
   *  what a crossing gave it needs this one, not `windowSeq`. */
  chainWindowId: string | null;
  windowStatus: string | null;
  orderStatus: string | null;
  sealedAt: string | null;
  settledAt: string | null;
  settledTx: string | null;
  /** Null until the window settles. */
  fill: {
    reason: string;
    filledRaw: string;
    residualRaw: string;
    quoteRaw: string;
    assetId: number;
    side: string;
    quantityRaw: string;
  } | null;
}

export const Route = createFileRoute("/api/orders/receipts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!hasDb()) {
          return Response.json({ error: "no database configured" }, { status: 503 });
        }

        let commitments: string[];
        try {
          const body = (await request.json()) as { commitments?: unknown };
          if (!Array.isArray(body.commitments)) throw new Error("commitments must be an array");
          commitments = body.commitments
            .filter((c): c is string => typeof c === "string")
            // 0x-prefixed 32 bytes. Anything else cannot be a commitment, and refusing it here
            // keeps malformed input out of a query rather than out of a stack trace.
            .filter((c) => /^0x[0-9a-fA-F]{64}$/.test(c))
            .slice(0, MAX);
        } catch {
          return Response.json({ error: "expected { commitments: string[] }" }, { status: 400 });
        }

        if (commitments.length === 0) {
          return Response.json({ receipts: [] }, { headers: { "cache-control": "no-store" } });
        }

        const chainId = resolveChainId();
        const sql = db();
        const rows = await sql<
          {
            commitment: string;
            seq: number | null;
            chain_window_id: string | null;
            window_status: string | null;
            order_status: string | null;
            sealed_at: Date | null;
            settled_at: Date | null;
            settled_tx: string | null;
            reason: string | null;
            filled_raw: string | null;
            residual_raw: string | null;
            quote_raw: string | null;
            asset_id: number | null;
            side: string | null;
            quantity_raw: string | null;
          }[]
        >`
          -- One row per commitment, the newest.
          --
          -- A commitment is not unique across orders: a note released from a failed window can
          -- be offered again, and the same note produces the same commitment every time. Without
          -- this, a trader who retried after a failure would be shown the failure — the settled
          -- order and the rejected one share a handle, and whichever the join happened to return
          -- last would win.
          select distinct on (o.commitment)
                 '0x' || encode(o.commitment, 'hex') as commitment,
                 w.seq, w.chain_window_id::text as chain_window_id,
                 w.status::text as window_status, o.status::text as order_status,
                 w.sealed_at, w.settled_at, w.settled_tx,
                 f.reason::text, f.filled_raw::text, f.residual_raw::text, f.quote_raw::text,
                 f.asset_id, f.side::text, f.quantity_raw::text
            from arclite.orders o
            join arclite.windows w on w.id = o.window_id
            -- A fill exists only once the matcher has run. Left join, because "sealed, nothing
            -- yet" is a real and common answer rather than a missing row.
            left join arclite.fills f on f.order_id = o.id
           where w.chain_id = ${chainId}
             -- IN rather than = ANY(...): postgres.js expands a JS array into a value list of
             -- its own, and an explicit bytea[] cast layered on top of that is what it refuses.
             and o.commitment in ${sql(commitments.map((c) => Buffer.from(c.slice(2), "hex")))}
           order by o.commitment, w.seq desc
        `;

        const found = new Map(rows.map((r) => [r.commitment.toLowerCase(), r]));
        const receipts: Receipt[] = commitments.map((c) => {
          const r = found.get(c.toLowerCase());
          if (!r) {
            // The caller believes it submitted this and the venue has no record. Said plainly
            // rather than omitted, so a browser holding a phantom order can show it as one.
            return {
              commitment: c,
              windowSeq: null,
              chainWindowId: null,
              windowStatus: null,
              orderStatus: null,
              sealedAt: null,
              settledAt: null,
              settledTx: null,
              fill: null,
            };
          }
          return {
            commitment: c,
            windowSeq: r.seq,
            chainWindowId: r.chain_window_id,
            windowStatus: r.window_status,
            orderStatus: r.order_status,
            sealedAt: r.sealed_at?.toISOString() ?? null,
            settledAt: r.settled_at?.toISOString() ?? null,
            settledTx: r.settled_tx,
            fill:
              r.reason === null
                ? null
                : {
                    reason: r.reason,
                    filledRaw: r.filled_raw ?? "0",
                    residualRaw: r.residual_raw ?? "0",
                    quoteRaw: r.quote_raw ?? "0",
                    assetId: r.asset_id ?? 0,
                    side: r.side ?? "",
                    quantityRaw: r.quantity_raw ?? "0",
                  },
          };
        });

        return Response.json({ chainId, receipts }, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
