import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { driftedAssets } from "@/server/supply-watch";
import { checkDb, checkRpc, checkWindowChain } from "./health";

/**
 * The venue's operational state, for anyone.
 *
 * `/api/health` is the operator's view and stays that way: it carries the relayer's address, its
 * balance, its runway in days and whether its key is hot, which together tell a reader exactly
 * when this venue stalls and what to watch. Publishing *whether the venue works* is a trust
 * signal on an unaudited market. Publishing *how to time its failure* is a different thing
 * wearing the same clothes.
 *
 * So this is a separate route with a deliberately narrow shape rather than a filter over the
 * other one. A filter is a list of things to remember to remove, and the failure mode is silent:
 * somebody adds a field upstream and it appears here. A route that names what it returns cannot
 * leak a field nobody wrote down.
 *
 * Never cached. A status page that answers from a CDN is reporting how things were, which is the
 * one thing a status page must not do.
 */
export const Route = createFileRoute("/api/status")({
  server: {
    handlers: {
      GET: async () => {
        const chainId = resolveChainId();
        const [chain, db, windows, drifted] = await Promise.all([
          checkRpc(chainId),
          checkDb(),
          checkWindowChain(),
          driftedAssets(chainId).catch(() => []),
        ]);

        return new Response(
          JSON.stringify({
            chainId,
            chainOk: chain.ok === true,
            chainLatencyMs: typeof chain.latencyMs === "number" ? chain.latencyMs : null,
            oracleLagSeconds: typeof db.oracleLagSeconds === "number" ? db.oracleLagSeconds : null,
            windowsOk: windows.ok === true,
            depositsQueueing: windows.depositsBlockedByStuckWindow === true,
            eligibleAssets: typeof db.eligibleAssets === "number" ? db.eligibleAssets : null,
            driftedAssets: drifted.length,
            at: new Date().toISOString(),
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          },
        );
      },
    },
  },
});
