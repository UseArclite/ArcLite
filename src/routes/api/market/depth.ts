import { createFileRoute } from "@tanstack/react-router";
import { type Address } from "viem";
import { resolveChainId } from "@/lib/chain/chains";
import { getMarketSnapshot } from "@/lib/chain/market";
import { LIT_FACTORY, litDepth } from "@/server/lit-depth";

/**
 * Lit liquidity per asset, from the public DEX on this chain.
 *
 * No database: this reads chain state only, like `/api/market/assets` does, so it survives a
 * Postgres outage and needs nothing provisioned. Two multicalls behind a five-minute CDN cache —
 * pool balances move on trades, and a trader deciding whether a market exists is not served any
 * better by a fresher number than that.
 *
 * Fails to an empty list rather than a 500. An absent depth line is a missing line; a depth
 * endpoint that 500s would take a panel down over a number that is nice to have.
 */
export const Route = createFileRoute("/api/market/depth")({
  server: {
    handlers: {
      GET: async () => {
        const chainId = resolveChainId();
        try {
          const snapshot = await getMarketSnapshot(chainId);
          const quote = snapshot.quote?.address as Address | undefined;
          if (!quote) return Response.json({ chainId, depth: [] }, { status: 200 });

          // Everything tradable except the quote itself: a USDG/USDG pool is not a thing.
          const assets = snapshot.assets
            .filter((a) => a.address.toLowerCase() !== quote.toLowerCase())
            .map((a) => ({ symbol: a.symbol, token: a.address as Address }));

          const depth = await litDepth(chainId, quote, assets);
          return new Response(
            JSON.stringify({
              chainId,
              quote: { symbol: snapshot.quote?.symbol, decimals: snapshot.quote?.decimals },
              // Named so the claim is checkable rather than asserted: anyone can read the
              // same pools from the same factory and get the same numbers.
              factory: LIT_FACTORY[chainId] ?? null,
              depth,
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "cache-control": "public, s-maxage=300, stale-while-revalidate=600",
              },
            },
          );
        } catch (error) {
          return Response.json(
            { chainId, depth: [], error: (error as Error).message },
            { status: 200, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
