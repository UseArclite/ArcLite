import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { driftedAssets } from "@/server/supply-watch";

/**
 * Assets whose token supply moved in a way nobody explained.
 *
 * Empty is the normal answer and the good one. A non-empty answer means an issuer minted or
 * burned outside an announced corporate action, and that what a token represents may have
 * changed since the venue last priced it.
 *
 * **Not proof of reserve.** This says the supply moved, not that the result is unbacked — the
 * attested figure has no source on this chain. `src/server/supply-drift.ts` says why at length,
 * and the distinction is kept in every string this route can return.
 *
 * Separate from `/api/market/assets` for the same reason the crossing history is: that route
 * reads the chain and touches no database, which is what makes live prices survive a Postgres
 * outage. This one needs the database and fails to an empty list rather than a 500.
 */
export const Route = createFileRoute("/api/market/supply")({
  server: {
    handlers: {
      GET: async () => {
        const chainId = resolveChainId();
        try {
          const drifted = await driftedAssets(chainId);
          return new Response(JSON.stringify({ chainId, drifted }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              // Short: this is a safety signal, and a minute of staleness on a circuit breaker
              // is the most a CDN should be allowed to add.
              "cache-control": "public, s-maxage=30, stale-while-revalidate=60",
            },
          });
        } catch (error) {
          return Response.json(
            { chainId, drifted: [], error: (error as Error).message },
            { status: 200, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
