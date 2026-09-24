import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { getMarketSnapshot } from "@/lib/chain/market";

/**
 * Live market snapshot — the replacement for the dashboard's hardcoded `STOCKS` map and
 * `TREASURY_NAV` constant.
 *
 * Reads Robinhood Chain directly with no database dependency, so real prices reach the dashboard
 * before Supabase is provisioned. History and the chart series need Postgres and arrive with the
 * price-observation cron; current state does not.
 *
 * Cached at the CDN for 10s with a 60s stale-while-revalidate window: equity feeds only move on
 * a 0.5% deviation or the 24h heartbeat, so polling harder buys nothing and costs RPC budget.
 */
export const Route = createFileRoute("/api/market/assets")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const chainId = resolveChainId();
          const snapshot = await getMarketSnapshot(chainId);

          return new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, s-maxage=10, stale-while-revalidate=60",
            },
          });
        } catch (error) {
          // Serving a stale or invented price is worse than serving nothing — the dashboard
          // renders a degraded state rather than a number no one can stand behind.
          return new Response(
            JSON.stringify({
              error: "market_unavailable",
              message: (error as Error).message,
              at: new Date().toISOString(),
            }),
            {
              status: 503,
              headers: { "content-type": "application/json", "cache-control": "no-store" },
            },
          );
        }
      },
    },
  },
});
