import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { hasDb, recordRun, releaseLock, tryLock } from "@/server/db";
import { syncPrices, syncRegistry } from "@/server/sync";

/**
 * Price and registry poller.
 *
 * Reads only. Every transaction this venue sends goes through the tick, because they all come
 * from one account and two crons sending concurrently collide on the nonce — which is exactly
 * what happened when the testnet feed keeper lived here: it allocated nonces for its own pass
 * while the tick's `sealWindow` was in flight, and the seal failed with "nonce too low". One
 * sender behind one lease is the cheap version of the Postgres nonce authority the plan
 * describes, and it holds until something sends outside the tick.
 *
 * Writes the current round and guard state for every eligible asset, and refreshes the asset
 * universe once an hour rather than every tick (the registry changes on the order of days).
 *
 * Returns 200 on a skipped or failed run, never 500: Vercel retries failures, and a cron that
 * 500s on a transient RPC error turns one blip into a retry storm. Failures are recorded in
 * `cron_runs` and surfaced through /api/health instead.
 */
export const Route = createFileRoute("/api/cron/oracle")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        const auth = request.headers.get("authorization");
        if (secret && auth !== `Bearer ${secret}`) {
          return new Response("unauthorized", { status: 401 });
        }

        if (!hasDb()) {
          return Response.json({ skipped: "no DATABASE_URL" }, { status: 200 });
        }

        const started = Date.now();
        const { acquired, holder } = await tryLock("oracle", 55);
        if (!acquired) {
          // Another invocation holds the lease. Not an error — overlapping ticks are expected.
          return Response.json({ skipped: "locked" }, { status: 200 });
        }

        try {
          const chainId = resolveChainId();
          // The registry moves on the order of days; refresh it hourly, not every minute.
          // `?full=1` forces it, for first runs and for after a schema change.
          const forced = new URL(request.url).searchParams.get("full") === "1";
          const refreshRegistry = forced || new Date().getUTCMinutes() < 2;
          const registry = refreshRegistry ? await syncRegistry(chainId) : { assets: 0, feeds: 0 };
          const prices = await syncPrices(chainId);

          const actions = {
            chainId,
            registryRefreshed: refreshRegistry,
            assets: registry.assets,
            feeds: registry.feeds,
            observations: prices.observations,
            guards: prices.guards,
            ms: Date.now() - started,
          };
          await recordRun("oracle", holder, true, actions);
          return Response.json({ ok: true, ...actions }, { status: 200 });
        } catch (error) {
          const message = (error as Error).message;
          await recordRun("oracle", holder, false, { ms: Date.now() - started }, message).catch(
            () => {},
          );
          // Every write here is an idempotent upsert, so a failed run is safe to retry
          // immediately. Holding the lease for its full TTL would only delay recovery.
          await releaseLock("oracle").catch(() => {});
          return Response.json({ ok: false, error: message }, { status: 200 });
        }
      },
    },
  },
});
