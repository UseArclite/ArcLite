import { createFileRoute } from "@tanstack/react-router";
import { db, hasDb } from "@/server/db";
import { cronConfigured } from "@/server/cron-auth";

/**
 * Liveness and dependency check.
 *
 * Deliberately the first server route in the project: it proves the Nitro Vercel preset really
 * produces a working Node function, which every server-side assumption in plan.md rests on.
 * Later it becomes the uptime monitor's target — the only alarm for a silently skipped cron.
 */

const RPC_URLS: Record<number, string> = {
  4663: "https://rpc.mainnet.chain.robinhood.com",
  46630: "https://rpc.testnet.chain.robinhood.com",
};

async function checkRpc(chainId: number) {
  const url = RPC_URLS[chainId];
  if (!url) return { ok: false, error: `unknown chainId ${chainId}` };
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { result?: string; error?: { message: string } };
    if (json.error)
      return { ok: false, error: json.error.message, latencyMs: Date.now() - started };
    return {
      ok: true,
      blockNumber: Number.parseInt(json.result ?? "0x0", 16),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message, latencyMs: Date.now() - started };
  }
}

/**
 * Whether the relayer can send, and how much gas it has left to send with.
 *
 * Every transaction the venue sends — sealing, pricing, settling, the testnet feed keeper —
 * comes from one account, and when it runs dry all of them stop. Nothing else in this endpoint
 * would show it: the crons keep firing, the database keeps advancing windows, and the only
 * symptom is transactions that quietly fail to send. A venue that has stopped settling because
 * it cannot pay for gas looks exactly like one that has nothing to settle.
 *
 * A balance alone does not answer the question anybody actually has, which is *how long have I
 * got*. So this reports runway in days, and `low` is that number falling under three.
 *
 * The two rates below are measured on mainnet, not estimated, and the gap between them is the
 * whole reason a fixed balance threshold could not work. An **idle** venue burns 0.00247 ETH a
 * day — measured over nine transactions in 529 seconds — because an empty window never touches
 * the chain at all: the sealer skips `order_count = 0` (migration 0011, `sealWindow` on an empty
 * book pays gas to say nothing), so nothing seals, nothing prices, and the only cost is the
 * heartbeat once a minute. A **trading** venue adds about 6.5M gas per settled window — an 88k
 * seal, a ~960k price and a 5.44M settlement.
 *
 * Runway is reported against the trading rate deliberately. It is the pessimistic of the two by
 * a factor of four, and it is the one that matters: an idle venue running out of gas has stopped
 * doing nothing, whereas a trading one stops mid-book. An estimate built from the idle rate
 * would have read "seven days" on the evening it had two.
 */

/** ETH per day with no orders: the heartbeat, once a minute, and nothing else. */
const BURN_IDLE_ETH_DAY = 0.00247;

/** ETH per day at roughly twenty settled windows: seal, price and settle on top of the above. */
const BURN_TRADING_ETH_DAY = 0.0092;

/** Days, to two places. An estimate carrying twelve decimals reads as a measurement. */
const round2 = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

async function checkRelayerGas(): Promise<{
  address?: string;
  balanceWei?: string;
  runwayDays?: number;
  runwayDaysIdle?: number;
  low?: boolean;
  canSign?: boolean;
  keyPolicy?: string;
  note?: string;
}> {
  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) return { note: "no RELAYER_PRIVATE_KEY" };
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    const address = privateKeyToAccount(key as `0x${string}`).address;
    const chainId = Number(process.env.ARCLITE_CHAIN_ID ?? 46630);

    // A funded relayer that the key policy will not let sign looks, in every other field here,
    // exactly like a healthy one: the address resolves, the balance reads, nothing errors. The
    // venue would simply stop settling. So the policy is evaluated where the balance is, and
    // `canSign` is the field to alarm on — a balance is only reassuring if it can be spent.
    const { assertKeyPolicy, plaintextRelayerAccepted } = await import("@/server/relayer");
    let canSign = true;
    let keyPolicy: string | undefined;
    try {
      assertKeyPolicy(chainId, true);
      // Said out loud on mainnet rather than left to be inferred from the absence of an error.
      // This venue signs mainnet transactions with a key held in an environment variable, and
      // the endpoint an operator watches should be where that is visible.
      if (chainId === 4663 && plaintextRelayerAccepted()) {
        keyPolicy = "hot key on mainnet, accepted by configuration";
      }
    } catch (policyError) {
      canSign = false;
      keyPolicy = (policyError as Error).message;
    }

    const url = RPC_URLS[chainId];
    if (!url) return { note: `unknown chainId ${chainId}` };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBalance",
        params: [address, "latest"],
      }),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json()) as { result?: string };
    const balance = BigInt(json.result ?? "0x0");

    // Testnet gas is about a fifth of mainnet's, and its stand-in feed keeper sends far more
    // than mainnet's heartbeat does, so the rates do not transfer between networks. Scaling is
    // near enough for a warning and keeps one set of measured constants.
    const scale = chainId === 4663 ? 1 : 0.2;
    const eth = Number(balance) / 1e18;
    const idleRate = BURN_IDLE_ETH_DAY * scale;
    const runwayDays = eth / (BURN_TRADING_ETH_DAY * scale);
    return {
      address,
      balanceWei: balance.toString(),
      runwayDays: round2(runwayDays),
      runwayDaysIdle: round2(eth / idleRate),
      // Three days. Long enough to be acted on by somebody who is not watching this endpoint,
      // short enough not to cry wolf on a venue that is simply quiet.
      low: runwayDays < 3,
      canSign,
      ...(keyPolicy ? { keyPolicy } : {}),
    };
  } catch (error) {
    return { note: (error as Error).message.slice(0, 120) };
  }
}

/**
 * Database reachability plus how far behind the oracle poller is. `lagSeconds` is the only alarm
 * for a silently skipped cron — Vercel Cron is best-effort and reports nothing when it misses.
 */
async function checkDb() {
  if (!hasDb()) return { ok: null as boolean | null, note: "DATABASE_URL not set" };
  const started = Date.now();
  try {
    const sql = db();
    const rows = await sql<
      { assets: number; last_ok: Date | null; lag: number | null; schema: string | null }[]
    >`
      select (select count(*)::int from arclite.assets
               where eligible and chain_id = ${Number(process.env.ARCLITE_CHAIN_ID ?? 46630)}) as assets,
             (select max(started_at) from arclite.cron_runs where name = 'oracle' and ok) as last_ok,
             (select extract(epoch from now() - max(started_at))::int
                from arclite.cron_runs where name = 'oracle' and ok) as lag,
             -- The schema the venue is actually running. A migration applied by hand and then
             -- forgotten surfaced as orders rejected at reveal with "function does not exist" —
             -- a message that names a function, not a missing deployment step, and only after
             -- the order had already been accepted and sealed.
             (select max(name) from arclite.schema_migrations) as schema
    `;
    const r = rows[0];
    return {
      ok: true as boolean | null,
      latencyMs: Date.now() - started,
      eligibleAssets: r?.assets ?? 0,
      schemaVersion: r?.schema ?? null,
      lastOracleRunAt: r?.last_ok?.toISOString() ?? null,
      oracleLagSeconds: r?.lag ?? null,
    };
  } catch (error) {
    return {
      ok: false as boolean | null,
      error: (error as Error).message,
      latencyMs: Date.now() - started,
    };
  }
}

/**
 * Whether the venue's clock is still connected to the chain.
 *
 * `unsealedOnChain` above zero is the failure worth alarming on: the database believes a window's
 * book is frozen while the pool has never heard of it, so anything matched into that window can
 * never settle. It is invisible from either side alone — both look healthy — which is exactly why
 * it belongs in the health check rather than a dashboard.
 */
async function checkWindowChain() {
  if (!hasDb()) return { ok: null as boolean | null, note: "DATABASE_URL not set" };
  try {
    const sql = db();
    const rows = await sql<
      {
        live_windows: number;
        unsealed_on_chain: number;
        unpriced_on_chain: number;
        settled_off_chain_only: number;
        queued_deposits_blocked: boolean | null;
        last_sealed_tx: string | null;
        last_chain_error: string | null;
      }[]
    >`select * from arclite.window_chain_state(${Number(process.env.ARCLITE_CHAIN_ID ?? 46630)})`;
    const r = rows[0];
    return {
      // A wedged window is an alarm, not a note: while one is open every deposit queues instead
      // of entering the tree, and nothing else about the venue looks wrong.
      ok: (r?.unsealed_on_chain ?? 0) === 0 && r?.queued_deposits_blocked !== true,
      depositsBlockedByStuckWindow: r?.queued_deposits_blocked === true,
      liveWindows: r?.live_windows ?? 0,
      unsealedOnChain: r?.unsealed_on_chain ?? 0,
      unpricedOnChain: r?.unpriced_on_chain ?? 0,
      // Expected to be non-zero until proving runs in the tick. Reported, not alarmed on, so
      // the gap is visible rather than reading as health.
      settledOffChainOnly: r?.settled_off_chain_only ?? 0,
      note: "the tick seals and prices on chain; proving and settlement are still driven manually",
      lastSealedTx: r?.last_sealed_tx ?? null,
      lastChainError: r?.last_chain_error ?? null,
    };
  } catch (error) {
    return { ok: false as boolean | null, error: (error as Error).message };
  }
}

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        const chainId = Number(process.env.ARCLITE_CHAIN_ID ?? 46630);
        const [chain, dbStatus, relayer] = await Promise.all([
          checkRpc(chainId),
          checkDb(),
          checkRelayerGas(),
        ]);

        const body = {
          service: "arclite-rh",
          status: chain.ok && dbStatus.ok !== false && cronConfigured() ? "ok" : "degraded",
          stage: process.env.ARCLITE_STAGE ?? "preview",
          chainId,
          chain,
          db: dbStatus,
          relayer,
          window: await checkWindowChain(),
          // A deployment that lost CRON_SECRET now refuses to run scheduled work rather than
          // running it for anyone, which is the safe direction and a silent one: the venue simply
          // stops advancing. This is where that becomes visible.
          cron: {
            configured: cronConfigured(),
            note: cronConfigured()
              ? undefined
              : "CRON_SECRET missing or too short; the venue will not advance",
          },
          commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
          region: process.env.VERCEL_REGION ?? null,
          at: new Date().toISOString(),
        };

        // Unconfigured crons are a degraded venue, not a healthy one. Without this the endpoint
        // an uptime monitor watches would stay green while nothing sealed, priced or settled.
        const healthy = chain.ok && dbStatus.ok !== false && cronConfigured();
        return new Response(JSON.stringify(body, null, 2), {
          status: healthy ? 200 : 503,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      },
    },
  },
});
