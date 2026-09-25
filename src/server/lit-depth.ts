import { createPublicClient, http, type Address } from "viem";
import { CHAINS, type SupportedChainId } from "@/lib/chain/chains";

/**
 * How much lit liquidity exists for an asset, on the public DEX on this chain.
 *
 * The dashboard can now say an asset has crossed in none of its windows, which is true and
 * discouraging and incomplete. Whether a *market* exists is a different fact: NVDA has never
 * crossed here and has roughly $3.5 million of two-sided liquidity a block away. One of those
 * numbers says "don't bother"; the pair says "there is a market, it just isn't in here yet".
 *
 * ## Where this comes from, and what it is not
 *
 * The integration spec called for reading Prism's DEX through `getReserves()` — a Uniswap **v2**
 * interface. The pools on this chain are **v3**: `slot0`, `liquidity`, `fee` and `tickSpacing`
 * are present and `getReserves` reverts, so every depth call in that spec is written against an
 * interface that is not there. Fees are per-pool tiers (0.05% / 0.3% / 1%) rather than a flat
 * 0.30%.
 *
 * The factory was found on chain rather than from any documentation — walked from the one
 * published token address — so this needs no API, no scraping, no pinned key, and nobody who can
 * switch it off. It is public chain state, read the way anything else here reads public chain
 * state.
 *
 * **What the number means.** A v3 pool's `liquidity()` is the depth of the *currently active
 * tick*, not the whole book, and quoting it as "liquidity" would be quietly wrong. What is
 * reported instead is the pool's actual token balances — how much of each asset is really sitting
 * there — which is the figure a person means when they ask how deep a market is. The active-tick
 * figure comes along separately for anyone who wants it, named for what it is.
 *
 * A read failure is an absent line, never a wrong one: no pool found and no pool readable look
 * the same to the caller, and both render nothing.
 */

/** The DEX factory on Robinhood Chain, discovered on chain. Uniswap-v3 style. */
export const LIT_FACTORY: Partial<Record<SupportedChainId, Address>> = {
  4663: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
};

/** The tiers this factory actually deploys. Probed per pair because a pair may exist at several. */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

const factoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const poolAbi = [
  {
    type: "function",
    name: "liquidity",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
] as const;

const ZERO = "0x0000000000000000000000000000000000000000";

export interface AssetDepth {
  symbol: string;
  /** The pool with the most quote sitting in it, of the tiers that exist. */
  pool: Address;
  /** Fee tier in hundredths of a basis point, as the factory stores it. 3000 = 0.30%. */
  feeTier: number;
  /** Raw quote units held by the pool. */
  quoteRaw: string;
  /** Raw base units held by the pool. */
  baseRaw: string;
  /** The active tick's liquidity. Deliberately separate: it is not the pool's depth. */
  activeTickLiquidity: string;
}

/**
 * Depth for each asset that has a funded pool, keyed by symbol.
 *
 * Two multicalls: one to find pools across every tier, one to read the funded ones. At 35 assets
 * that is 140 `getPool` calls and roughly 90 reads — far too many as individual round trips, and
 * unremarkable as two batches.
 */
export async function litDepth(
  chainId: SupportedChainId,
  quote: Address,
  assets: { symbol: string; token: Address }[],
): Promise<AssetDepth[]> {
  const factory = LIT_FACTORY[chainId];
  if (!factory || assets.length === 0) return [];

  const client = createPublicClient({ chain: CHAINS[chainId], transport: http() });

  const pools = await client
    .multicall({
      contracts: assets.flatMap((a) =>
        FEE_TIERS.map(
          (fee) =>
            ({
              address: factory,
              abi: factoryAbi,
              functionName: "getPool",
              args: [quote, a.token, fee],
            }) as const,
        ),
      ),
      allowFailure: true,
    })
    .catch(() => null);
  if (!pools) return [];

  const candidates: { symbol: string; token: Address; pool: Address; feeTier: number }[] = [];
  assets.forEach((a, i) => {
    FEE_TIERS.forEach((fee, j) => {
      const r = pools[i * FEE_TIERS.length + j];
      if (r?.status === "success" && r.result && r.result !== ZERO) {
        candidates.push({
          symbol: a.symbol,
          token: a.token,
          pool: r.result as Address,
          feeTier: fee,
        });
      }
    });
  });
  if (candidates.length === 0) return [];

  const reads = await client
    .multicall({
      contracts: candidates.flatMap((c) => [
        { address: quote, abi: erc20Abi, functionName: "balanceOf", args: [c.pool] } as const,
        { address: c.token, abi: erc20Abi, functionName: "balanceOf", args: [c.pool] } as const,
        { address: c.pool, abi: poolAbi, functionName: "liquidity" } as const,
      ]),
      allowFailure: true,
    })
    .catch(() => null);
  if (!reads) return [];

  // A pair commonly exists at several tiers with all the money in one of them — the empty ones
  // are real contracts returning real zeros, and quoting the wrong one would report no market
  // where there is one. Keep the deepest per symbol.
  const best = new Map<string, AssetDepth>();
  candidates.forEach((c, i) => {
    const q = reads[i * 3];
    const b = reads[i * 3 + 1];
    const l = reads[i * 3 + 2];
    if (q?.status !== "success" || b?.status !== "success") return;
    const quoteRaw = q.result as bigint;
    if (quoteRaw === 0n) return;

    const prior = best.get(c.symbol);
    if (prior && BigInt(prior.quoteRaw) >= quoteRaw) return;
    best.set(c.symbol, {
      symbol: c.symbol,
      pool: c.pool,
      feeTier: c.feeTier,
      quoteRaw: quoteRaw.toString(),
      baseRaw: (b.result as bigint).toString(),
      activeTickLiquidity: l?.status === "success" ? (l.result as bigint).toString() : "0",
    });
  });

  return [...best.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}
