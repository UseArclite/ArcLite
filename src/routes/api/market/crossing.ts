import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { crossingHistory } from "@/server/crossing";

/**
 * Per-asset crossing history: how often a book in this asset actually found a counterparty.
 *
 * Deliberately not folded into `/api/market/assets`, which reads Robinhood Chain and touches no
 * database at all — that property is why live prices reach the dashboard before Supabase is
 * provisioned, and a join added here would quietly take it away. This route needs Postgres and
 * says so by being separate: if it fails, prices and guards are unaffected and the market panel
 * simply omits a line.
 *
 * Keyed by registry `assetId` rather than symbol because that is what the match tables store.
 * The client already holds the id-to-symbol map from `/api/pool/assets` under a shared query
 * key, so the join costs it nothing.
 *
 * Cached hard. This answer changes at most once per window, and a window is five minutes.
 */
export const Route = createFileRoute("/api/market/crossing")({
  server: {
    handlers: {
      GET: async () => {
        const chainId = resolveChainId();
        try {
          const assets = await crossingHistory(chainId);
          return new Response(JSON.stringify({ chainId, assets }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
            },
          });
        } catch (error) {
          // A missing history is not a broken market. Answer with nothing rather than a 500 the
          // panel would have to special-case.
          return Response.json(
            { chainId, assets: [], error: (error as Error).message },
            { status: 200, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
