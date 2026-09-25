import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { hasDb, recordRun, releaseLock, tryLock } from "@/server/db";
import { syncPrices, syncRegistry } from "@/server/sync";
import { watchSupply } from "@/server/supply-watch";
import { authorizeCron } from "@/server/cron-auth";

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
        // Fail closed. This used to be `if (secret && ...)`, which is only a check when the
        // secret is set — so a deployment that lost `CRON_SECRET` accepted every anonymous
        // caller, silently, while continuing to look healthy.
        const auth = authorizeCron(request);
        if (!auth.ok) return auth.response;

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

          // What the issuers did to their own tokens. A read-only pass over the registry —
          // roughly 70 RPC calls for 35 assets, well inside this route's budget — and it never
          // sends a transaction, so it cannot collide with the tick's nonce.
          //
          // Its failures are collected rather than thrown: a supply check that cannot reach an
          // RPC must not take price and guard syncing down with it, and the watcher records its
          // own failed reads so that not being able to check still fails closed per asset.
          const supply = await watchSupply(chainId).catch((e: Error) => ({
            checked: 0,
            recorded: 0,
            tripped: [],
            cleared: [],
            errors: [e.message],
          }));

          const actions = {
            chainId,
            registryRefreshed: refreshRegistry,
            assets: registry.assets,
            feeds: registry.feeds,
            observations: prices.observations,
            guards: prices.guards,
            supplyChecked: supply.checked,
            // Scalars only: `recordRun` stores a flat record. The ids are the useful part in a
            // run log, and the wording lives in `asset_supply_state` and on the API.
            supplyTripped: supply.tripped.map((t) => t.assetId).join(",") || null,
            supplyCleared: supply.cleared.join(",") || null,
            supplyErrors: supply.errors.length,
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
