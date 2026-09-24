import { toHex, type Address } from "viem";
import { ARCLITE, resolveChainId } from "@/lib/chain/chains";
import { db } from "@/server/db";
import { hasRelayer, relayer, RelayerUnavailable } from "@/server/relayer";

/**
 * Driving the chain from the window tick.
 *
 * The database FSM used to run alone: a window could seal, match and settle in Postgres while
 * the pool had never heard of it. Two clocks, no relationship, and no way to notice they had
 * diverged. This is the piece that makes the venue's clock actually move the contracts.
 *
 * The ordering below is the security property, not bookkeeping. `sealWindow` freezes the book
 * **before** `commitWindow` reads any feed, so nobody — operator included — holds a free option
 * on the window's reference. The pool enforces it independently (`wp.committedAt < w.sealedAt`
 * reverts), which is what makes this safe to drive from a best-effort cron: a tick that runs the
 * steps out of order fails loudly instead of quietly mispricing a window.
 *
 * Everything here is written to survive being interrupted. Each step checks the chain's own
 * state first, so a tick that dies between sealing and pricing leaves a window the next tick
 * picks up, rather than a half-built one nobody owns.
 */

const poolAbi = [
  {
    type: "function",
    name: "settlementDeadline",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "sealWindow",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint64" }, { type: "bytes32" }, { type: "uint16" }, { type: "uint8" }],
    outputs: [],
  },
  {
    type: "function",
    name: "windows",
    stateMutability: "view",
    inputs: [{ type: "uint64" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "ordersRoot", type: "bytes32" },
          { name: "tapeCommitment", type: "bytes32" },
          { name: "sealedAt", type: "uint64" },
          { name: "settledAt", type: "uint64" },
          { name: "orderCount", type: "uint16" },
          { name: "subBatchCount", type: "uint8" },
          { name: "subBatchesSettled", type: "uint8" },
          { name: "finalized", type: "bool" },
          { name: "voided", type: "bool" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "quoteAssetId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "openWindowId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "voidWindow",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint64" }],
    outputs: [],
  },
] as const;

const pricerAbi = [
  { type: "function", name: "heartbeat", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "sequencerOk",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "commitWindow",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint64" }, { type: "uint16[]" }],
    outputs: [{ type: "bytes32" }, { type: "uint256" }],
  },
  {
    type: "function",
    name: "window",
    stateMutability: "view",
    inputs: [{ type: "uint64" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "pricesRoot", type: "bytes32" },
          { name: "deferMask", type: "uint256" },
          { name: "committedAt", type: "uint64" },
          { name: "assetCount", type: "uint16" },
          { name: "sequencerOk", type: "bool" },
        ],
      },
    ],
  },
] as const;

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
] as const;

export interface ChainTickResult {
  skipped?: string;
  heartbeat?: boolean;
  sequencerOk?: boolean;
  sealed: number;
  priced: number;
  voided: number;
  /** Orders released from windows that died, so their notes can be offered again. */
  releasedOrders?: number;
  errors: string[];
}

const bytes32 = (v: Uint8Array | null): `0x${string}` | null =>
  v ? (toHex(v) as `0x${string}`) : null;

/**
 * Void the open on-chain window if it can no longer settle.
 *
 * Two triggers, and the distinction matters:
 *
 *   * **Past its settlement deadline.** Anyone may void then, and the deadline is exactly the
 *     margin that keeps a merely-slow window from being killed early.
 *   * **The database has given up on it** — its record is VOID or FAILED, or there is no record
 *     at all. The second case is the orphan: a window sealed on chain whose database row is
 *     gone, which nothing else will ever notice. A guardian may void immediately, and waiting a
 *     full deadline to recover from that is an hour of rejected deposits for no benefit.
 *
 * Voiding moves no tokens, marks no nullifiers and overwrites no root, so a wrong call here
 * costs a window that crossed nothing — not value.
 */
async function voidStuckWindow(
  r: ReturnType<typeof relayer>,
  pool: Address,
  sql: ReturnType<typeof db>,
  chainId: number,
): Promise<number> {
  const openId = await r.read.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "openWindowId",
  });
  if (openId === 0n) return 0;

  const onChain = await r.read.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "windows",
    args: [openId],
  });
  if (onChain.finalized) return 0;

  const deadline = await r.read.readContract({
    address: pool,
    abi: poolAbi,
    functionName: "settlementDeadline",
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const pastDeadline = now >= onChain.sealedAt + deadline;

  const rows = await sql<{ status: string }[]>`
    select status::text from arclite.windows
     where chain_id = ${chainId} and chain_window_id = ${openId.toString()}::bigint
  `;
  const abandoned = rows.length === 0 || rows[0]!.status === "VOID" || rows[0]!.status === "FAILED";

  if (!pastDeadline && !abandoned) return 0;

  await r.send({
    address: pool,
    abi: poolAbi,
    functionName: "voidWindow",
    args: [openId],
    gas: 3_000_000n,
  });
  return 1;
}

/**
 * Ping the liveness heartbeat.
 *
 * `PriceCommitter` has no Chainlink sequencer uptime feed to read — Chainlink does not serve one
 * for this chain — so this shim stands in. It must be pinged *continuously*: a gap counts as an
 * outage, and recovery starts a grace period during which every asset defers pool-wide. That is
 * correct after a real outage and merely inconvenient after a missed cron, which is why the tick
 * pings every run rather than only when it wants to price something.
 */
export async function pingHeartbeat(): Promise<boolean> {
  const chainId = resolveChainId();
  const pricer = ARCLITE[chainId].priceCommitter as Address | null;
  if (!pricer) return false;
  const r = relayer();
  await r.send({ address: pricer, abi: pricerAbi, functionName: "heartbeat" });
  return r.read.readContract({ address: pricer, abi: pricerAbi, functionName: "sequencerOk" });
}

/**
 * Seal on chain any window the database has already sealed, then price it.
 *
 * Both steps are driven from the database's view of what is due, and both check the chain first.
 * A window already sealed on chain is recorded rather than re-sent — `sealWindow` reverts on a
 * second attempt, and burning a tick on a guaranteed revert would stall every window behind it.
 */
export async function syncWindowsToChain(): Promise<ChainTickResult> {
  const result: ChainTickResult = { sealed: 0, priced: 0, voided: 0, errors: [] };

  if (!hasRelayer()) return { ...result, skipped: "no RELAYER_PRIVATE_KEY" };

  const chainId = resolveChainId();
  const deployed = ARCLITE[chainId];
  if (!deployed.pool || !deployed.priceCommitter || !deployed.eligibleRegistry) {
    return { ...result, skipped: "contracts are not deployed on this network" };
  }

  let r;
  try {
    r = relayer();
  } catch (error) {
    // The mainnet key policy lands here. Skipping is the correct outcome: the venue keeps
    // serving reads and the tick keeps running; it simply does not sign.
    if (error instanceof RelayerUnavailable) return { ...result, skipped: error.message };
    throw error;
  }

  const pool = deployed.pool as Address;
  const pricer = deployed.priceCommitter as Address;
  const registry = deployed.eligibleRegistry as Address;
  const sql = db();

  try {
    result.sequencerOk = await pingHeartbeat();
    result.heartbeat = true;
  } catch (error) {
    // Not fatal. Pricing will defer every asset, which is the safe direction, and the next tick
    // tries again.
    result.errors.push(`heartbeat: ${(error as Error).message}`);
  }

  // Clear a wedged window before anything else. While one is open, `shield` queues deposits
  // rather than inserting them — a settlement splices a span-aligned subtree and an interleaved
  // single insert would misalign it — so an open window that will never settle stops every
  // deposit from reaching the tree, indefinitely, with no outward sign.
  //
  // Not hypothetical: a window sealed by a test script outlived the database that would have
  // settled it, and the next real deposit sat in the queue behind it for fifteen hours. The
  // recovery path existed; nothing called it.
  try {
    result.voided = await voidStuckWindow(r, pool, sql, chainId);
  } catch (error) {
    result.errors.push(`void: ${(error as Error).message}`);
  }

  // Give back the notes of windows that died.
  //
  // A note is only spent when settlement publishes its nullifier, so an order in a VOID or
  // FAILED window never spent anything — but the unique index on `commitment` kept refusing to
  // see it again, which left the note withdrawable forever and tradable never. Rejecting the
  // order is what releases it, and doing it here rather than only in a migration means the next
  // failure repairs itself rather than waiting for someone to notice.
  try {
    const [released] = await sql<{ n: number }[]>`
      select arclite.release_orders_of_dead_windows(${chainId}) as n
    `;
    if (released?.n) result.releasedOrders = released.n;
  } catch (error) {
    result.errors.push(`release: ${(error as Error).message}`);
  }
  const due = await sql<
    {
      id: string;
      seq: string;
      chain_window_id: string;
      orders_root: Uint8Array | null;
      order_count: number;
    }[]
  >`
    select w.id::text, w.seq::text, w.chain_window_id::text, w.orders_root, w.order_count
      from arclite.windows_needing_chain_seal(${chainId}) s
      join arclite.windows w on w.id = s.id
  `;

  for (const window of due) {
    // Read, not recomputed. The pool takes an operator-chosen uint64 and remembers every id
    // forever, so `seq` is unusable — it restarts at 1 whenever the database is rebuilt or the
    // pool is redeployed, and the pool quite correctly refuses to reseal an id it already knows.
    // The id is derived from the open timestamp, which is monotonic and never repeats.
    //
    // Deriving it *here* was the problem: a trader's spend signature is bound to this number and
    // they sign while the window is open, long before the sealer runs. The window now carries it
    // from the moment it opens, so the trader and the settler are reading the same value rather
    // than two computations that happen to agree.
    const chainWindowId = BigInt(window.chain_window_id);

    try {
      const onChain = await r.read.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "windows",
        args: [chainWindowId],
      });

      if (onChain.sealedAt === 0n) {
        // No orders yet means no book to freeze. Sealing an empty window is legal but pointless,
        // and it would wedge deposits out of the tree until something settles or voids it.
        if (window.order_count === 0) continue;

        const root = bytes32(window.orders_root);
        if (!root) {
          await sql`select arclite.record_chain_error(${window.id}::bigint, 'no orders root to seal with')`;
          continue;
        }
        const hash = await r.send({
          address: pool,
          abi: poolAbi,
          functionName: "sealWindow",
          args: [chainWindowId, root, window.order_count, 1],
        });
        await sql`
          select arclite.record_chain_seal(${window.id}::bigint, ${chainWindowId.toString()}::bigint, ${hash}, ${window.orders_root})
        `;
        result.sealed += 1;
      } else {
        // Already sealed — a previous tick sent it and died before recording. Reconcile rather
        // than resend, and record it as reconciled rather than inventing a transaction hash: a
        // placeholder in `sealed_tx` reads as a real transaction and links to nothing.
        await sql`
          select arclite.record_chain_seal(${window.id}::bigint, ${chainWindowId.toString()}::bigint,
            ${null}, ${Buffer.from(onChain.ordersRoot.slice(2), "hex")})
        `;
      }
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await sql`select arclite.record_chain_error(${window.id}::bigint, ${message})`;
      result.errors.push(`seal ${window.seq}: ${message}`);
    }
  }

  // Price everything sealed but unpriced. Separate pass, so a seal that landed this tick is
  // priced this tick too — the ordering constraint is satisfied by the chain's own timestamps.
  const unpriced = await sql<{ id: string; chain_window_id: string }[]>`
    select id::text, chain_window_id::text
      from arclite.windows
     where chain_id = ${chainId} and (sealed_tx is not null or chain_reconciled) and priced_at is null
     order by seq limit 8
  `;

  if (unpriced.length > 0) {
    const count = await r.read.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "registeredCount",
    });
    const registered = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) =>
        r.read.readContract({
          address: registry,
          abi: registryAbi,
          functionName: "assetIdAt",
          args: [BigInt(i)],
        }),
      ),
    );

    // Everything registered *except* the quote asset.
    //
    // It is in the registry because the pool has to account for it — a quote note the pool knows
    // nothing about is one it can never pay out — but it must not be in the price table. The
    // crossing proof refuses a window that prices the asset it also pays out in: otherwise a
    // seller's "quote" would be units of the very asset being traded, conservation would still
    // balance, and the pool would hand out twice what it took in.
    //
    // Read from the pool rather than configured here, for the same reason the settler does: it
    // is a public input of every proof, so anything else simply fails to verify.
    const quoteAssetId = await r.read.readContract({
      address: pool,
      abi: poolAbi,
      functionName: "quoteAssetId",
    });
    const tradable = registered.filter((id) => id !== quoteAssetId);

    // Which assets a window prices, and why it is not simply "all of them".
    //
    // `PriceCommitter.MAX_ASSETS` is 32 — `pricesRoot` is a hash chain over 32 fixed-width
    // entries — and passing more reverts with `TooManyAssets`. Testnet registers three tradable
    // assets, so "price everything registered" was correct there and would have failed on
    // mainnet at the first window: 35 eligible equities, every `commitWindow` reverting, windows
    // sealing on chain and never pricing. Nothing in the testnet venue could have shown that.
    //
    // Pricing the assets a window actually has orders for is the fix `plan.md` already wanted
    // for cost, and it happens to be the one that makes the cap a non-issue: a window holds at
    // most 128 orders across at most 32 assets by construction, because the pool's own
    // `MAX_ASSETS` is what a crossing proof can reference. At 32 assets `commitWindow` is 8.2M
    // gas against 2.6M at ten, so the saving is real money on every window as well.
    //
    // An empty window still has to price — the contract rejects an empty asset list, and a
    // window that never prices never settles and blocks the queue behind it. It gets a
    // deterministic slice instead: same input, same table, so a retry cannot produce a different
    // commitment for the same window.
    //
    // The three cases are distinguished deliberately, because two of them look identical if you
    // only count revealed orders. The tick reveals before it prices, so a sealed window normally
    // has its `asset_id`s by now — but `revealSealedWindows` is allowed to fail (a window whose
    // timelock key never arrived), and a window with orders nobody has decrypted yet would
    // otherwise be priced as though it were empty. It would then settle against a table missing
    // the very asset it traded. So an unrevealed order falls back to the full table rather than
    // to the cheap path: correctness is worth more than the gas, and this is the case where
    // being wrong is silent.
    const assetsFor = async (windowId: string) => {
      const [counts] = await sql<{ total: number; revealed: number; ids: number[] }[]>`
        select count(*)::int                                          as total,
               count(asset_id)::int                                   as revealed,
               coalesce(array_agg(distinct asset_id)
                        filter (where asset_id is not null), '{}')    as ids
          from arclite.orders
         where window_id = ${windowId}::bigint
      `;

      // Nothing to cross. The table still has to exist and be committed, but nothing will ever
      // look a row up in it, so it is one row rather than 32 — 8.2M gas against a few hundred
      // thousand, on the great majority of windows.
      if (!counts || counts.total === 0) return tradable.slice(0, 1);

      // Orders the sealer has not decrypted. Price everything, and let the window fail honestly
      // downstream rather than against a table that quietly omits its asset.
      if (counts.revealed < counts.total) return tradable.slice(0, 32);

      const wanted = new Set(counts.ids);
      const forWindow = tradable.filter((id) => wanted.has(Number(id)));
      return (forWindow.length > 0 ? forWindow : tradable.slice(0, 1)).slice(0, 32);
    };

    for (const window of unpriced) {
      const id = BigInt(window.chain_window_id);
      const assetIds = await assetsFor(window.id);
      try {
        const existing = await r.read.readContract({
          address: pricer,
          abi: pricerAbi,
          functionName: "window",
          args: [id],
        });
        // A window can be priced exactly once. If it already was, record it — resending would
        // revert and stall the queue behind it.
        const hash =
          existing.committedAt === 0n
            ? await r.send({
                address: pricer,
                abi: pricerAbi,
                functionName: "commitWindow",
                args: [id, assetIds],
              })
            : "0x" + "0".repeat(64);
        const priced = await r.read.readContract({
          address: pricer,
          abi: pricerAbi,
          functionName: "window",
          args: [id],
        });
        await sql`
          select arclite.record_chain_prices(${window.id}::bigint, ${hash as string | null},
            ${Buffer.from(priced.pricesRoot.slice(2), "hex")}, ${priced.deferMask.toString()}::numeric,
            to_timestamp(${Number(priced.committedAt)}))
        `;
        result.priced += 1;
      } catch (error) {
        const message = (error as Error).message.slice(0, 500);
        await sql`select arclite.record_chain_error(${window.id}::bigint, ${message})`;
        result.errors.push(`price ${id}: ${message}`);
      }
    }
  }

  return result;
}
