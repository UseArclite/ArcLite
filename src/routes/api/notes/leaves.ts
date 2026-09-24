import { createFileRoute } from "@tanstack/react-router";
import { createPublicClient, http, type Address } from "viem";
import { ARCLITE, CHAINS, resolveChainId } from "@/lib/chain/chains";
import { readLeafSet } from "@/server/leaves";

/**
 * Every commitment in the pool's tree, in leaf order.
 *
 * Deliberately **public and unauthenticated**. The commitment set is world-readable in any
 * shielded pool — it *is* the anonymity set — and gating it behind a session would do the
 * opposite of what it looks like: it would tell us which leaves each account cares about. The
 * client takes the whole list and works out which are its own locally, in the vault worker, so
 * this endpoint never learns who is asking about what.
 *
 * The pool address comes from the committed `ARCLITE` map, the same source every other module
 * uses. It used to come from an environment variable instead — written when nothing was deployed
 * yet — and once the addresses moved into the map this route was the one place left reading the
 * old path. Unset in production, it answered `deployed: false` with an empty tree, so the vault
 * had nothing to scan and reported zero notes for deposits that were sitting in the tree. The
 * environment variable still overrides, for pointing a local client at a different pool.
 */

export const Route = createFileRoute("/api/notes/leaves")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const chainId = resolveChainId();
        const deployed = ARCLITE[chainId];
        const current = process.env.ARCLITE_POOL_ADDRESS ?? deployed.pool;

        // `?pool=` reads a *retired* pool's commitment set, so a holder whose notes predate a
        // redeploy can still find and withdraw them. Validated against the known addresses
        // rather than trusted: this endpoint reads chain logs, and an arbitrary address would
        // make it a log-scanning proxy for anything on the network.
        const asked = new URL(request.url).searchParams.get("pool")?.toLowerCase();
        const known = [current, ...deployed.retiredPools].filter(Boolean) as string[];
        if (asked && !known.some((p) => p.toLowerCase() === asked)) {
          return Response.json(
            {
              chainId,
              deployed: false,
              reason: "not a pool this venue knows",
              leaves: [],
              leafCount: 0,
            },
            { status: 400, headers: { "cache-control": "no-store" } },
          );
        }
        const pool = asked ?? current;
        const retired = Boolean(asked) && asked !== current?.toLowerCase();

        if (!pool) {
          return Response.json(
            {
              chainId,
              deployed: false,
              reason: "the pool is not deployed on this network yet",
              leaves: [],
              leafCount: 0,
            },
            { headers: { "cache-control": "no-store" } },
          );
        }

        try {
          const client = createPublicClient({ chain: CHAINS[chainId], transport: http() });
          const fromBlock = BigInt(
            process.env.ARCLITE_POOL_DEPLOY_BLOCK ?? ARCLITE[chainId].deployBlock ?? 0,
          );

          // A retired pool's own deploy block is not recorded, and scanning from the current
          // one would start after it. Zero is correct and the cost is a longer scan of a tree
          // that has stopped growing — which the cache below absorbs.
          const raw = await readLeafSet(client, pool as Address, retired ? 0n : fromBlock);
          const leaves = raw.map((l) => l.toString());

          return Response.json(
            { chainId, deployed: true, pool, retired, leaves, leafCount: leaves.length },
            // The tree only grows, so a short cache keeps a polling client from re-reading the
            // whole log range every few seconds.
            { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } },
          );
        } catch (error) {
          return Response.json(
            { chainId, deployed: true, error: (error as Error).message, leaves: [], leafCount: 0 },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
