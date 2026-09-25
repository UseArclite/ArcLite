import { createPublicClient, http, type Address } from "viem";
import { ARCLITE, CHAINS, type SupportedChainId } from "@/lib/chain/chains";
import { db, hasDb } from "./db";
import { assessFailure, assessSupply, type SupplyState } from "./supply-drift";

/**
 * Watch what the issuers do to their own tokens.
 *
 * Every tokenized equity on this chain is mintable and burnable by whoever issued it, and until
 * now that was invisible here: supply could double and the venue would keep crossing at the
 * Chainlink price as though each token still stood for what it stood for yesterday.
 *
 * Reads `totalSupply()` and `uiMultiplier()` for every registered asset once per cycle, records
 * the pair, and compares against a baseline. A move that arrives with a multiplier change is an
 * announced corporate action and is absorbed; a move without one is not, and the asset is marked.
 *
 * **This is supply monitoring, not proof of reserve.** See `supply-drift.ts` for why the stronger
 * property cannot be built on this chain today, and what would have to exist for it to be.
 *
 * ## Why it reads the registry rather than the market snapshot
 *
 * `getMarketSnapshot` is keyed by symbol. Everything downstream of a drift — `EventCalendar`
 * blackouts, `window_assets_matched`, the `deferMask` the circuit constrains — is keyed by the
 * registry's `uint16 assetId`. Reading the registry keeps one key end to end rather than a
 * symbol-to-id join that can go stale between them.
 */

const registryAbi = [
  {
    type: "function",
    name: "registeredCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "assetIdAt",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "asset",
    stateMutability: "view",
    inputs: [{ type: "uint16" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "feed", type: "address" },
          { name: "navOracle", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "decimals", type: "uint8" },
          { name: "distributing", type: "bool" },
          { name: "maxStalenessSec", type: "uint32" },
          { name: "maxNavAgeSec", type: "uint32" },
          { name: "assetId", type: "uint16" },
        ],
      },
    ],
  },
] as const;

const tokenAbi = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "uiMultiplier",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface SupplyWatchResult {
  checked: number;
  recorded: number;
  /** Assets whose verdict changed to drifted on this pass. */
  tripped: { assetId: number; driftBps: number; reason: string }[];
  /** Assets that cleared, because a corporate action explained the move. */
  cleared: number[];
  errors: string[];
}

export async function watchSupply(chainId: SupportedChainId): Promise<SupplyWatchResult> {
  const out: SupplyWatchResult = {
    checked: 0,
    recorded: 0,
    tripped: [],
    cleared: [],
    errors: [],
  };
  if (!hasDb()) return out;

  const deployed = ARCLITE[chainId];
  const registry = deployed.eligibleRegistry as Address | undefined;
  if (!registry) return out;

  const sql = db();
  const client = createPublicClient({ chain: CHAINS[chainId], transport: http() });

  let tokens: { assetId: number; token: Address; kind: number }[];
  try {
    const count = await client.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "registeredCount",
    });
    const ids = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) =>
        client.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "assetIdAt",
          args: [BigInt(i)],
        }),
      ),
    );
    const entries = await Promise.all(
      ids.map((id) =>
        client.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "asset",
          args: [id],
        }),
      ),
    );
    // `AssetKind { NONE, STOCK, TREASURY, STABLE }`. Only the first two are claims on something
    // an issuer holds, and only those have a `uiMultiplier` to explain a supply change with.
    //
    // The quote stablecoin is excluded deliberately, not incidentally. Its supply moves all day
    // by design — that is what a stablecoin does — so it would trip constantly, and the asset it
    // would defer is the one every other asset trades against. Watching it would halt the venue
    // for the thing working correctly.
    tokens = entries
      .map((e, i) => ({ assetId: Number(ids[i]), token: e.token as Address, kind: Number(e.kind) }))
      .filter((t) => t.kind === 1 || t.kind === 2);
  } catch (error) {
    // The registry is the list itself. Without it there is nothing to check, and inventing a
    // list from a stale table would be worse than reporting that the pass did not happen.
    out.errors.push(`registry: ${(error as Error).message}`);
    return out;
  }

  const states = await sql<
    {
      asset_id: number;
      baseline_supply: string | null;
      last_supply: string | null;
      baseline_at: Date | null;
      baseline_multiplier: string | null;
      failed_reads: number;
      drifted: boolean;
    }[]
  >`
    select asset_id, baseline_supply, last_supply, baseline_at,
           failed_reads, drifted,
           (select multiplier::text from arclite.asset_supply s
             where s.chain_id = st.chain_id and s.asset_id = st.asset_id
               and s.observed_at <= st.baseline_at
             order by s.observed_at desc limit 1) as baseline_multiplier
      from arclite.asset_supply_state st
     where chain_id = ${chainId}
  `;
  const byId = new Map(states.map((s) => [Number(s.asset_id), s]));

  // One multicall for every token's supply and multiplier rather than a round trip per asset.
  // Sequential reads took 21s for 35 assets, which is a third of this cron's minute and grows
  // with the registry — far too much to spend on a check that is almost always "no change".
  const results = await client
    .multicall({
      contracts: tokens.flatMap((t) => [
        { address: t.token, abi: tokenAbi, functionName: "totalSupply" } as const,
        { address: t.token, abi: tokenAbi, functionName: "uiMultiplier" } as const,
      ]),
      allowFailure: true,
    })
    .catch((error: Error) => {
      out.errors.push(`multicall: ${error.message}`);
      return null;
    });

  const at = new Date().toISOString();
  const observations: Record<string, unknown>[] = [];
  const stateRows: Record<string, unknown>[] = [];

  tokens.forEach(({ assetId }, i) => {
    out.checked += 1;
    const prior = byId.get(assetId);
    const state: SupplyState = {
      lastSupply: prior?.last_supply != null ? BigInt(prior.last_supply) : null,
      baselineSupply: prior?.baseline_supply != null ? BigInt(prior.baseline_supply) : null,
      baselineAt: prior?.baseline_at ? prior.baseline_at.getTime() : null,
      baselineMultiplier:
        prior?.baseline_multiplier != null ? BigInt(prior.baseline_multiplier) : null,
      failedReads: prior?.failed_reads ?? 0,
    };

    // `allowFailure` means one dead token does not lose the other thirty-four, and a per-asset
    // failure still lands in that asset's `failed_reads` so it fails closed on its own.
    const supplyCall = results?.[i * 2];
    const multiplierCall = results?.[i * 2 + 1];
    const reading =
      supplyCall?.status === "success" && multiplierCall?.status === "success"
        ? { supply: supplyCall.result as bigint, multiplier: multiplierCall.result as bigint }
        : null;
    if (results && !reading) out.errors.push(`asset ${assetId}: supply or multiplier unreadable`);

    const verdict = reading ? assessSupply(reading, state) : assessFailure(state);

    if (reading) {
      observations.push({
        asset_id: assetId,
        total_supply: reading.supply.toString(),
        multiplier: reading.multiplier.toString(),
      });
      out.recorded += 1;
    }

    stateRows.push({
      asset_id: assetId,
      last_supply: reading ? reading.supply.toString() : null,
      last_read_at: reading ? at : null,
      rebase: verdict.rebase && reading !== null,
      baseline_supply:
        verdict.rebase && reading
          ? reading.supply.toString()
          : (state.baselineSupply?.toString() ?? null),
      baseline_at: verdict.rebase && reading ? at : null,
      drift_bps: verdict.driftBps,
      drifted: verdict.drifted,
      reason: verdict.reason,
      failed_reads: reading ? 0 : state.failedReads + 1,
    });

    const wasDrifted = prior?.drifted ?? false;
    if (verdict.drifted && !wasDrifted) {
      out.tripped.push({ assetId, driftBps: verdict.driftBps, reason: verdict.reason ?? "" });
    }
    if (!verdict.drifted && wasDrifted) out.cleared.push(assetId);
  });

  // Two statements for the whole registry rather than two per asset.
  if (observations.length > 0) {
    await sql`
      insert into arclite.asset_supply (chain_id, asset_id, total_supply, multiplier)
      select ${chainId}, r.asset_id, r.total_supply::numeric, r.multiplier::numeric
        from jsonb_to_recordset(${sql.json(observations as never)})
          as r(asset_id int, total_supply text, multiplier text)
      on conflict do nothing
    `;
  }

  if (stateRows.length > 0) {
    await sql`
      insert into arclite.asset_supply_state
        (chain_id, asset_id, last_supply, last_read_at, baseline_supply, baseline_at,
         drift_bps, drifted, reason, failed_reads, updated_at)
      select ${chainId}, r.asset_id, r.last_supply::numeric, r.last_read_at::timestamptz,
             r.baseline_supply::numeric, r.baseline_at::timestamptz,
             r.drift_bps, r.drifted, r.reason, r.failed_reads, now()
        from jsonb_to_recordset(${sql.json(stateRows as never)})
          as r(asset_id int, last_supply text, last_read_at text, rebase boolean,
               baseline_supply text, baseline_at text, drift_bps int, drifted boolean,
               reason text, failed_reads int)
      on conflict (chain_id, asset_id) do update set
        last_supply  = coalesce(excluded.last_supply, arclite.asset_supply_state.last_supply),
        last_read_at = coalesce(excluded.last_read_at, arclite.asset_supply_state.last_read_at),
        -- The baseline moves only when this pass said to. Everything else leaves it where it
        -- was, so drift is measured from a fixed point rather than from whatever happened last.
        baseline_supply = case when excluded.baseline_at is not null then excluded.baseline_supply
                               else arclite.asset_supply_state.baseline_supply end,
        baseline_at     = case when excluded.baseline_at is not null then excluded.baseline_at
                               else arclite.asset_supply_state.baseline_at end,
        drift_bps    = excluded.drift_bps,
        drifted      = excluded.drifted,
        reason       = excluded.reason,
        failed_reads = excluded.failed_reads,
        updated_at   = now()
    `;
  }

  return out;
}

/** Everything currently considered unsafe to cross, for the API and the dashboard. */
export async function driftedAssets(
  chainId: SupportedChainId,
): Promise<{ assetId: number; driftBps: number; reason: string | null; since: string }[]> {
  if (!hasDb()) return [];
  const sql = db();
  const rows = await sql<
    { asset_id: number; drift_bps: number; reason: string | null; updated_at: Date }[]
  >`
    select asset_id, drift_bps, reason, updated_at
      from arclite.asset_supply_state
     where chain_id = ${chainId} and drifted
     order by asset_id
  `;
  return rows.map((r) => ({
    assetId: Number(r.asset_id),
    driftBps: r.drift_bps,
    reason: r.reason,
    since: r.updated_at.toISOString(),
  }));
}

/**
 * Turn a drift verdict into something the contract enforces.
 *
 * Detection alone changes nothing. Deferral on this venue is decided **on chain** by
 * `PriceCommitter`, which computes `deferMask` itself from oracle state and the `EventCalendar`;
 * the matcher never asserts a deferral and the circuit constrains the mask. A row in our database
 * saying "drifted" would be a warning label on a door that still opens.
 *
 * `EventCalendar.scheduleBlackout` is the door. The relayer holds `CALENDAR_ROLE`, granted
 * deliberately rather than pointing a cron at the deployer key, and it is the smallest privilege
 * that does this job: a blackout stops an asset crossing and does nothing else. It cannot move
 * funds, change the registry or touch the pool — and `unshield` has no pause, no role and no
 * window check, so even a compromised keeper can halt trading without trapping anybody's money.
 *
 * ## Why the blackout is short, and re-scheduled
 *
 * A blackout carries an end time. Scheduling one far ahead would mean a drift that resolves — an
 * issuer completing a corporate action, say — leaves the asset frozen until somebody remembers to
 * clear it. Each pass instead extends the window a little past the next pass: a drift that
 * persists stays enforced, and one that clears expires on its own within minutes. The database is
 * the memory; the chain only has to hold the next few minutes.
 *
 * Called from the tick, never the oracle cron. Every transaction this venue sends comes from one
 * account behind one lease, and two crons sending concurrently collide on the nonce.
 */
const calendarAbi = [
  {
    type: "function",
    name: "scheduleBlackout",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint16" }, { type: "uint64" }, { type: "uint64" }, { type: "uint8" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isBlackout",
    stateMutability: "view",
    inputs: [{ type: "uint16" }, { type: "uint64" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * `EventCalendar.REASON_MANUAL`.
 *
 * The contract's reason codes predate this guard and there is no supply-drift member. Reusing
 * `MANUAL` rather than redeploying an immutable contract for an enum entry is the right trade —
 * the reason a trader reads comes from `asset_supply_state`, and the chain only needs to know
 * that the asset is blacked out, not why.
 */
const REASON_MANUAL = 4;

/** How far ahead a blackout reaches: comfortably past the next tick, not so far it outlives its cause. */
const BLACKOUT_SECONDS = 15 * 60;

export interface EnforceResult {
  scheduled: number[];
  errors: string[];
}

export async function enforceDrift(chainId: SupportedChainId): Promise<EnforceResult> {
  const out: EnforceResult = { scheduled: [], errors: [] };
  const calendar = ARCLITE[chainId].eventCalendar as Address | undefined;
  if (!calendar) return out;

  const drifted = await driftedAssets(chainId);
  if (drifted.length === 0) return out;

  let r;
  try {
    const { relayer } = await import("./relayer");
    r = relayer();
  } catch (error) {
    // The mainnet key policy lands here. Detection and the API keep working; enforcement does
    // not, and reporting that is better than a silent no-op on a safety control.
    out.errors.push(`relayer unavailable: ${(error as Error).message}`);
    return out;
  }

  const now = Math.floor(Date.now() / 1000);
  for (const { assetId } of drifted) {
    try {
      // Already covered for the moment the next tick will ask about. Re-scheduling every minute
      // would spend gas to say the same thing.
      const covered = await r.read.readContract({
        address: calendar,
        abi: calendarAbi,
        functionName: "isBlackout",
        args: [assetId, BigInt(now + 120)],
      });
      if (covered) continue;

      await r.send({
        address: calendar,
        abi: calendarAbi,
        functionName: "scheduleBlackout",
        args: [assetId, BigInt(now), BigInt(now + BLACKOUT_SECONDS), REASON_MANUAL],
      });
      out.scheduled.push(assetId);
    } catch (error) {
      out.errors.push(`asset ${assetId}: ${(error as Error).message}`);
    }
  }
  return out;
}
