import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { hasDb, recordRun, releaseLock, tryLock } from "@/server/db";
import { advanceWindows } from "@/server/windows";
import { syncWindowsToChain } from "@/server/chain-windows";
import { matchPricedWindows, revealSealedWindows } from "@/server/pipeline";
import { settleMatchedWindows } from "@/server/settle";
import { keepTestnetFeedsAlive } from "@/server/feed-keeper";

/**
 * The window lifecycle tick.
 *
 * Advances whatever is due and opens a window if none is live. It never assumes it ran last
 * minute: a window seals because `seals_at <= now()`, not because a tick fired on time. Vercel
 * Cron is best-effort and silently skips minutes, so a missed tick delays a window rather than
 * corrupting one.
 *
 * The whole transition is a single PL/pgSQL call — one round trip, one transaction.
 */
export const Route = createFileRoute("/api/cron/tick")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const secret = process.env.CRON_SECRET;
        const auth = request.headers.get("authorization");
        if (secret && auth !== `Bearer ${secret}`) {
          return new Response("unauthorized", { status: 401 });
        }
        if (!hasDb()) return Response.json({ skipped: "no DATABASE_URL" }, { status: 200 });

        const started = Date.now();
        const { acquired, holder } = await tryLock("tick", 55);
        if (!acquired) return Response.json({ skipped: "locked" }, { status: 200 });

        try {
          const chainId = resolveChainId();
          const windowSeconds = Number(process.env.ARCLITE_WINDOW_SECONDS ?? 300);
          const epochSeconds = Number(process.env.ARCLITE_EPOCH_SECONDS ?? 3600);
          const result = await advanceWindows(chainId, windowSeconds, epochSeconds);

          // Reveal before the chain seal: sealing needs the orders root, and the orders root
          // only exists once the book has been decrypted. A window whose key is gone reveals
          // nothing, gets no root, and stays visibly unsealed rather than sealing against an
          // empty book that silently discarded real orders.
          let reveal;
          try {
            reveal = await revealSealedWindows(chainId);
          } catch (error) {
            reveal = { error: (error as Error).message };
          }

          // The database FSM moves first, then the chain follows it. Doing it in this order
          // means the chain is driven by what the venue's clock decided, not the other way
          // round — and a chain call that fails leaves a recorded divergence the next tick
          // retries, rather than rolling back a transition that already happened.
          //
          // Failures here never fail the tick. Vercel retries a 500, and a retry that re-runs
          // `advance_windows` is harmless but a retry that re-sends a transaction is not.
          // Before the chain work, and in the same lease.
          //
          // The testnet stand-in feeds need a keeper: left alone they pass their staleness
          // bound and every asset defers, which reads as a broken venue. It used to run in the
          // oracle cron — a *different* lease — so it allocated nonces for its own pass while
          // this tick's `sealWindow` was in flight, and the seal failed with "nonce too low".
          // Every transaction the venue sends comes from one account, so they all belong behind
          // one lease. A no-op on mainnet, where the feeds are real.
          let feeds;
          try {
            feeds = await keepTestnetFeedsAlive();
          } catch (error) {
            feeds = { error: (error as Error).message };
          }

          let chain;
          try {
            chain = await syncWindowsToChain();
          } catch (error) {
            chain = { error: (error as Error).message };
          }

          // Match last, because it crosses at the reference the contract committed after the
          // book was frozen. Matching before pricing would hand back the free option that the
          // seal-then-price ordering exists to remove.
          let match;
          try {
            match = await matchPricedWindows(chainId);
          } catch (error) {
            match = { error: (error as Error).message };
          }

          // Last, and the only stage that can be slow: proving is ~2s per sub-batch, which is
          // why it runs after everything cheap has already been recorded. A tick that dies here
          // leaves a matched window the next one picks up.
          let settle;
          try {
            settle = await settleMatchedWindows();
          } catch (error) {
            settle = { error: (error as Error).message };
          }

          const actions = {
            ...result,
            feeds,
            reveal,
            chain,
            match,
            settle,
            ms: Date.now() - started,
          };
          await recordRun("tick", holder, true, actions as never);
          return Response.json({ ok: true, ...actions }, { status: 200 });
        } catch (error) {
          const message = (error as Error).message;
          await recordRun("tick", holder, false, { ms: Date.now() - started }, message).catch(
            () => {},
          );
          // advance_windows is idempotent, so a failed tick is safe to retry immediately.
          await releaseLock("tick").catch(() => {});
          return Response.json({ ok: false, error: message }, { status: 200 });
        }
      },
    },
  },
});
