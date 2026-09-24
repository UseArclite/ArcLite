import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rhcTestnet, resolveChainId } from "@/lib/chain/chains";
import { relayer } from "@/server/relayer";

/**
 * Keep the testnet stand-in feeds alive.
 *
 * Robinhood Chain testnet has no Chainlink, so the venue runs against `TestnetPriceFeed`
 * contracts seeded once at deploy. Nobody updates them afterwards — and a day later every asset
 * is past `maxStalenessSec`, `deferMask` comes back all-ones, and the venue defers everything.
 * The dashboard then shows a fully guarded market with no explanation, which reads like a bug in
 * the guards rather than a feed with no keeper behind it.
 *
 * A real aggregator publishes on its own. These need someone to do it, so the oracle cron does:
 * the same answer republished at the current timestamp. **A liveness ping, not a price** — the
 * answer is read from the feed and written straight back, so this cannot move a market.
 *
 * Mainnet has real feeds and this must never run there. The guard is the chain id, and the
 * contracts refuse to exist on 4663 anyway (`TestnetOnly`), so a misconfiguration fails loudly
 * rather than quietly repricing something.
 */

const FEED_ABI = [
  {
    type: "function",
    name: "answer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int256" }],
  },
  {
    type: "function",
    name: "updatedAt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "setAnswer",
    stateMutability: "nonpayable",
    inputs: [{ type: "int256" }],
    outputs: [],
  },
] as const;

/**
 * The stand-in feeds, from `deployments/46630.json`, with the price each was seeded at.
 *
 * The anchor bounds the walk below. A feed that wandered freely would drift away from the price
 * the token is recognisably worth, and every expected number in the pipeline with it.
 */
const TESTNET_FEEDS: { feed: Address; symbol: string; anchor8: bigint; driftBps: number }[] = [
  {
    feed: "0x9c2dC66Bd7484b67341ccdca7515775B04A62264",
    symbol: "tNVDA",
    anchor8: 22_244_729_849n,
    driftBps: 200,
  },
  {
    feed: "0x1342192Db807F645Ea2Da56F63305643389BaB3b",
    symbol: "tAAPL",
    anchor8: 33_538_000_000n,
    driftBps: 200,
  },
  {
    feed: "0x599032FD4844FFdAf4F7eF3e65E2261D3AbED566",
    symbol: "tSPY",
    anchor8: 76_155_000_000n,
    driftBps: 150,
  },
  // The quote asset stays pinned. A quote that wandered would make every expected figure in the
  // pipeline a moving target for no test value, and a dollar that is not a dollar is its own bug.
  {
    feed: "0xFD8a6ca25B32285A89A8fF82831C7d5feC0bDB41",
    symbol: "tUSDG",
    anchor8: 100_000_000n,
    driftBps: 0,
  },
];

/** One step of the walk: small enough to look like a market, large enough to be visible. */
const STEP_BPS = 12;

/**
 * The next answer for a feed: a bounded random walk around its anchor.
 *
 * Pinned prices are not a neutral choice. A venue whose references never move never exercises
 * the deviation guard, never produces a chart with a shape, and never shows a window crossing at
 * a different reference from the last one — so the parts of the venue that exist to handle
 * movement go untested, and the dashboard renders a flat line that reads as broken.
 *
 * Each step is at most `STEP_BPS`, and the result is clamped to `driftBps` either side of the
 * seeded price, so tNVDA stays recognisably around $222 rather than wandering into a number that
 * makes every worked example in the repo wrong.
 */
export function nextAnswer(current: bigint, anchor8: bigint, driftBps: number): bigint {
  if (driftBps === 0) return anchor8;
  const step = BigInt(Math.round((Math.random() * 2 - 1) * STEP_BPS));
  const moved = current + (current * step) / 10_000n;
  const low = anchor8 - (anchor8 * BigInt(driftBps)) / 10_000n;
  const high = anchor8 + (anchor8 * BigInt(driftBps)) / 10_000n;
  return moved < low ? low : moved > high ? high : moved;
}

/**
 * Publish a new round on each stand-in feed, at most once per `staleAfterSeconds`.
 *
 * Every minute, not every six hours. The registered staleness bound is a day, so liveness alone
 * would need far less — but each call is also a *round*, and rounds are the only history these
 * feeds have. `price_observations` is keyed on `(feed_id, round_id)` where the round id is the
 * feed's `updatedAt`, so a feed that publishes twice a day yields two points, and the dashboard
 * chart renders a single dot. A minute apart, the chart fills in as the venue runs.
 */
export async function keepTestnetFeedsAlive(
  staleAfterSeconds = 45,
): Promise<{ skipped?: string; refreshed: number; errors: string[] }> {
  const result = { refreshed: 0, errors: [] as string[] };

  const chainId = resolveChainId();
  if (chainId !== 46630) return { ...result, skipped: "mainnet feeds keep themselves" };

  let r: ReturnType<typeof relayer>;
  try {
    r = relayer();
  } catch {
    return { ...result, skipped: "no RELAYER_PRIVATE_KEY" };
  }

  // `setAnswer` is owner-only, and the owner is the deployer. The relayer key is the deployer on
  // testnet; where it is not, every call reverts and that is recorded rather than hidden.
  const account = privateKeyToAccount((process.env.RELAYER_PRIVATE_KEY ?? "") as `0x${string}`);
  const wallet = createWalletClient({
    account,
    chain: rhcTestnet,
    transport: http(),
  });

  const now = BigInt(Math.floor(Date.now() / 1000));
  for (const { feed, symbol, anchor8, driftBps } of TESTNET_FEEDS) {
    try {
      const [answer, updatedAt] = await Promise.all([
        r.read.readContract({ address: feed, abi: FEED_ABI, functionName: "answer" }),
        r.read.readContract({ address: feed, abi: FEED_ABI, functionName: "updatedAt" }),
      ]);
      if (now - updatedAt < BigInt(staleAfterSeconds)) continue;

      // Mined before the next one is sent.
      //
      // Several sent back to back all read the same pending nonce and all but the first fail
      // with "nonce too low" — one feed silently never updating while the others did. Allocating
      // nonces here instead fixed that and broke the next sender: the heartbeat, right after
      // this in the same tick, asked the node for a pending nonce that did not yet reflect these
      // transactions and collided in turn. Explicit allocation and viem's own do not compose.
      //
      // Waiting composes with everything, because after a receipt the node's answer is simply
      // correct. It costs a few seconds per tick against a 300 s ceiling, and the alternative is
      // a nonce authority every sender has to agree to use — which is the right answer once
      // anything sends outside the tick, and is not that yet.
      const hash = await wallet.writeContract({
        address: feed,
        abi: FEED_ABI,
        functionName: "setAnswer",
        args: [nextAnswer(answer, anchor8, driftBps)],
      });
      await r.read.waitForTransactionReceipt({ hash });
      result.refreshed += 1;
    } catch (error) {
      result.errors.push(`${symbol}: ${(error as Error).message.slice(0, 200)}`);
    }
  }

  return result;
}
