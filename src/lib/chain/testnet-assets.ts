import type { EligibleAsset } from "./registry";

/**
 * The testnet asset universe.
 *
 * `getEligibleAssets` builds the universe from Robinhood's registry API and the Chainlink feed
 * directory, filtering on `deployments.chainId`. Neither knows anything about chain 46630 — the
 * testnet tokens are our own stand-ins — so on testnet the filter matched nothing and the
 * dashboard rendered a market with no assets in it. Not an error, not a degraded state: an empty
 * list, which looks exactly like a venue with nothing listed.
 *
 * These are the stand-ins from `deployments/46630.json`, carrying the same surface the registry
 * probes: `uiMultiplier`, `newUIMultiplier`, `effectiveAt`, `oraclePaused`, and an 8-decimal
 * feed. Everything downstream — the guard evaluation, the session calendar, the multicall that
 * reads current state — is the mainnet path unchanged, because the shape is the same.
 *
 * The quote asset is deliberately absent. It is registered in `EligibleRegistry` so the pool can
 * account for it, but it is not a *tradable* asset: the crossing proof refuses a window that
 * prices the asset it also pays out in, and listing it would invite an order nothing can settle.
 */

/**
 * Tradable in every session. A stand-in feed has no exchange behind it, so there is no calendar
 * to respect — and the string matters: `assetSessionAt` tests for `TRADING_STATUS_TRADABLE`
 * exactly, and anything else reads as "not permitted" and defers the asset with
 * `SESSION_CLOSED`, which looks identical to a market that is genuinely shut.
 */
const ALWAYS_TRADABLE = {
  market: { whole: "TRADING_STATUS_TRADABLE", fractional: "TRADING_STATUS_TRADABLE" },
  extended: { whole: "TRADING_STATUS_TRADABLE", fractional: "TRADING_STATUS_TRADABLE" },
  overnight: { whole: "TRADING_STATUS_TRADABLE", fractional: "TRADING_STATUS_TRADABLE" },
};

/**
 * A day's staleness bound, matching what `SeedTestnet` registered on chain.
 *
 * The feeds have no keeper of their own; the oracle cron republishes them at their own answer
 * when they age past six hours. Without that they pass this bound within a day and every asset
 * defers — a venue that looks broken for a reason that has nothing to do with the venue.
 */
const HEARTBEAT_SECONDS = 86_400;

export const TESTNET_ELIGIBLE_ASSETS: EligibleAsset[] = [
  {
    symbol: "tNVDA",
    name: "ArcLite Test NVDA",
    address: "0xb32011d2cb1d071a4c2897fe61af443cb88e3f73",
    decimals: 18,
    registryMultiplier: "1.000775159164630595",
    pendingMultiplier: "1.000775159164630595",
    tradingCapabilities: ALWAYS_TRADABLE,
    feed: {
      address: "0x9c2dc66bd7484b67341ccdca7515775b04a62264",
      decimals: 8,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      deviationBps: 50,
    },
  },
  {
    symbol: "tAAPL",
    name: "ArcLite Test AAPL",
    address: "0x3427e64d42f01c68bfc08e1419b640ece3a68b76",
    decimals: 18,
    registryMultiplier: "1.000566080061092436",
    pendingMultiplier: "1.000566080061092436",
    tradingCapabilities: ALWAYS_TRADABLE,
    feed: {
      address: "0x1342192db807f645ea2da56f63305643389bab3b",
      decimals: 8,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      deviationBps: 50,
    },
  },
  {
    symbol: "tSPY",
    name: "ArcLite Test SPY",
    address: "0x9b1a569a57daa9998e4d7af82ce0ae0fe219d51a",
    decimals: 18,
    registryMultiplier: "1.001717991187472003",
    pendingMultiplier: "1.001717991187472003",
    tradingCapabilities: ALWAYS_TRADABLE,
    feed: {
      address: "0x599032fd4844ffdaf4f7ef3e65e2261d3abed566",
      decimals: 8,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      deviationBps: 50,
    },
  },
];
