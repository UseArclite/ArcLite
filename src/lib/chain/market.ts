import { createPublicClient, http, type PublicClient } from "viem";
import { aggregatorV3Abi, stockTokenAbi, tokenControlAbi } from "./abis";
import { CHAINS, CONTRACTS, type SupportedChainId } from "./chains";
import { getEligibleAssets, getQuoteAsset, type EligibleAsset } from "./registry";
import { assetSessionAt, SESSION_POLICY, sessionAt, type SessionKind } from "./sessions";

/**
 * Builds the market snapshot the dashboard renders: live reference prices, issuer multipliers,
 * quote NAV and per-asset guard state, read straight from Robinhood Chain.
 *
 * Deliberately has no database dependency. History and candles need Postgres, but *current*
 * prices do not, and keeping this path DB-free means the dashboard shows real numbers before
 * Supabase is provisioned.
 */

export type GuardReason =
  | "STALE_PRICE"
  | "EVENT_WINDOW"
  | "ORACLE_PAUSED"
  | "MULTIPLIER_PENDING"
  | "SESSION_CLOSED"
  | "TOKEN_PAUSED"
  | "REGISTRY";

export interface AssetSnapshot {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  kind: "STOCK" | "TREASURY" | "STABLE";
  /** Reference price in USD. Chainlink's answer already prices the token, not the share. */
  price: number;
  priceRaw: string;
  multiplier: number;
  multiplierRaw: string;
  priceUpdatedAt: string;
  priceAgeSeconds: number;
  session: SessionKind;
  tradable: boolean;
  logoUrl?: string;
  isin?: string;
  guard: {
    deferred: boolean;
    /** The two indicators the dashboard already renders. */
    stale: boolean;
    event: boolean;
    reasons: GuardReason[];
    detail: string | null;
  };
}

export interface MarketSnapshot {
  chainId: number;
  network: "mainnet" | "testnet";
  asOf: string;
  blockNumber: number;
  session: SessionKind;
  crossingEnabled: boolean;
  /** True only if the shared control contract has frozen every Robinhood token at once. */
  tokensPaused: boolean;
  quote: {
    symbol: string;
    name: string;
    address: string;
    decimals: number;
    kind: string;
    nav: number;
    navRaw: string;
    navUpdatedAt: string | null;
    navAgeSeconds: number | null;
  } | null;
  assets: AssetSnapshot[];
  eligibleCount: number;
  registryCount: number;
}

const MULTIPLIER_GUARD_WINDOW_SECONDS = 15 * 60;

export function client(chainId: SupportedChainId): PublicClient {
  const rpc = process.env.ARCLITE_RPC_URL || CHAINS[chainId].rpcUrls.default.http[0];
  return createPublicClient({
    chain: CHAINS[chainId],
    transport: http(rpc, { batch: true, timeout: 15_000 }),
  }) as PublicClient;
}

function scaleToNumber(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function to1e18(raw: bigint, decimals: number): bigint {
  return decimals === 18
    ? raw
    : decimals < 18
      ? raw * 10n ** BigInt(18 - decimals)
      : raw / 10n ** BigInt(decimals - 18);
}

interface RawAssetRead {
  answer: bigint;
  updatedAt: bigint;
  roundId: bigint;
  answeredInRound: bigint;
  multiplier: bigint;
  pendingMultiplier: bigint;
  effectiveAt: bigint;
  oraclePaused: boolean;
}

function evaluateGuard(
  asset: EligibleAsset,
  read: RawAssetRead,
  nowSeconds: number,
  session: SessionKind,
  tokensPaused: boolean,
): AssetSnapshot["guard"] {
  const reasons: GuardReason[] = [];
  const ageSeconds = nowSeconds - Number(read.updatedAt);

  if (tokensPaused) reasons.push("TOKEN_PAUSED");
  if (read.oraclePaused) reasons.push("ORACLE_PAUSED");

  if (session === "CLOSED") {
    reasons.push("SESSION_CLOSED");
  } else {
    // Staleness is judged against the *session*, never the raw heartbeat: equity feeds stop
    // updating when the market shuts, and treating that as a fault defers everything all weekend.
    const bound = SESSION_POLICY[session].maxPriceAgeSeconds;
    if (read.answer <= 0n || read.answeredInRound < read.roundId || ageSeconds > bound) {
      reasons.push("STALE_PRICE");
    }
  }

  // A staged multiplier about to activate is a corporate action in progress.
  const effectiveAt = Number(read.effectiveAt);
  if (
    read.pendingMultiplier > 0n &&
    read.pendingMultiplier !== read.multiplier &&
    effectiveAt > 0 &&
    effectiveAt <= nowSeconds + MULTIPLIER_GUARD_WINDOW_SECONDS
  ) {
    reasons.push("MULTIPLIER_PENDING");
  }

  const stale = reasons.some(
    (r) => r === "STALE_PRICE" || r === "ORACLE_PAUSED" || r === "TOKEN_PAUSED",
  );
  const event = reasons.some((r) => r === "MULTIPLIER_PENDING" || r === "EVENT_WINDOW");

  let detail: string | null = null;
  if (reasons.includes("TOKEN_PAUSED")) detail = "All Robinhood tokens are paused by the issuer.";
  else if (reasons.includes("ORACLE_PAUSED")) detail = "Issuer paused this asset's oracle.";
  else if (reasons.includes("MULTIPLIER_PENDING")) detail = "Issuer multiplier update pending.";
  else if (reasons.includes("STALE_PRICE"))
    detail = `Reference ${Math.round(ageSeconds / 60)} min old.`;
  else if (reasons.includes("SESSION_CLOSED")) detail = "Market closed.";

  return { deferred: reasons.length > 0, stale, event, reasons, detail };
}

export async function getMarketSnapshot(chainId: SupportedChainId): Promise<MarketSnapshot> {
  const pub = client(chainId);
  const contracts = CONTRACTS[chainId];
  const [assets, blockNumber] = await Promise.all([
    getEligibleAssets(chainId),
    pub.getBlockNumber(),
  ]);

  // One multicall for every asset's feed round and token state, plus the global pause flag.
  const calls = assets.flatMap((a) => [
    { address: a.feed.address, abi: aggregatorV3Abi, functionName: "latestRoundData" } as const,
    { address: a.address, abi: stockTokenAbi, functionName: "uiMultiplier" } as const,
    { address: a.address, abi: stockTokenAbi, functionName: "newUIMultiplier" } as const,
    { address: a.address, abi: stockTokenAbi, functionName: "effectiveAt" } as const,
    { address: a.address, abi: stockTokenAbi, functionName: "oraclePaused" } as const,
  ]);

  const controlCalls = contracts.tokenControl
    ? [
        {
          address: contracts.tokenControl as `0x${string}`,
          abi: tokenControlAbi,
          functionName: "paused",
        } as const,
      ]
    : [];

  const quoteFeedCalls = contracts.usdgUsdFeed
    ? [
        {
          address: contracts.usdgUsdFeed as `0x${string}`,
          abi: aggregatorV3Abi,
          functionName: "latestRoundData",
        } as const,
      ]
    : [];

  const results = await pub.multicall({
    contracts: [...calls, ...controlCalls, ...quoteFeedCalls],
    allowFailure: true,
  });

  const nowSeconds = Math.floor(Date.now() / 1000);
  const now = new Date();
  // Testnet keeps its own hours: the stand-in tokens track no exchange, so a US equity calendar
  // would shut the venue every night and all weekend for a market that does not exist. Mainnet
  // uses the real session, where the calendar is the point.
  const testnet = chainId === 46630;
  const marketSession = testnet ? "MARKET" : sessionAt(now);

  const controlIdx = calls.length;
  const tokensPaused =
    controlCalls.length > 0 && results[controlIdx]?.status === "success"
      ? (results[controlIdx].result as boolean)
      : false;

  const snapshots: AssetSnapshot[] = [];
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const base = i * 5;
    const round = results[base];
    const mult = results[base + 1];
    const pending = results[base + 2];
    const eff = results[base + 3];
    const paused = results[base + 4];

    // A failed read is a deferral, never a guess at a price.
    if (round?.status !== "success" || mult?.status !== "success") continue;

    const [roundId, answer, , updatedAt, answeredInRound] = round.result as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];

    const read: RawAssetRead = {
      roundId,
      answer,
      updatedAt,
      answeredInRound,
      multiplier: mult.result as bigint,
      pendingMultiplier: pending?.status === "success" ? (pending.result as bigint) : 0n,
      effectiveAt: eff?.status === "success" ? (eff.result as bigint) : 0n,
      oraclePaused: paused?.status === "success" ? (paused.result as boolean) : false,
    };

    const session = testnet ? "MARKET" : assetSessionAt(a.tradingCapabilities, now);
    const guard = evaluateGuard(a, read, nowSeconds, session, tokensPaused);

    snapshots.push({
      symbol: a.symbol,
      name: a.name,
      address: a.address,
      decimals: a.decimals,
      kind: "STOCK",
      price: scaleToNumber(read.answer, a.feed.decimals),
      priceRaw: to1e18(read.answer, a.feed.decimals).toString(),
      multiplier: scaleToNumber(read.multiplier, 18),
      multiplierRaw: read.multiplier.toString(),
      priceUpdatedAt: new Date(Number(read.updatedAt) * 1000).toISOString(),
      priceAgeSeconds: nowSeconds - Number(read.updatedAt),
      session,
      tradable: !guard.deferred && SESSION_POLICY[session].allowCrossing,
      logoUrl: a.logoUrl,
      isin: a.isin,
      guard,
    });
  }

  const quoteMeta = getQuoteAsset(chainId);
  let quote: MarketSnapshot["quote"] = null;
  if (quoteMeta) {
    const quoteIdx = controlIdx + controlCalls.length;
    const quoteRound = quoteFeedCalls.length > 0 ? results[quoteIdx] : undefined;
    let nav = 1;
    let navRaw = 10n ** 18n;
    let navUpdatedAt: string | null = null;
    let navAgeSeconds: number | null = null;

    if (quoteRound?.status === "success") {
      const [, answer, , updatedAt] = quoteRound.result as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      if (answer > 0n) {
        nav = scaleToNumber(answer, 8);
        navRaw = to1e18(answer, 8);
        navUpdatedAt = new Date(Number(updatedAt) * 1000).toISOString();
        navAgeSeconds = nowSeconds - Number(updatedAt);
      }
    }

    quote = {
      symbol: quoteMeta.symbol,
      name: quoteMeta.name,
      address: quoteMeta.address,
      decimals: quoteMeta.decimals,
      kind: quoteMeta.kind,
      nav,
      navRaw: navRaw.toString(),
      navUpdatedAt,
      navAgeSeconds,
    };
  }

  return {
    chainId,
    network: chainId === 4663 ? "mainnet" : "testnet",
    asOf: now.toISOString(),
    blockNumber: Number(blockNumber),
    session: marketSession,
    crossingEnabled: SESSION_POLICY[marketSession].allowCrossing && !tokensPaused,
    tokensPaused,
    quote,
    assets: snapshots,
    eligibleCount: snapshots.length,
    registryCount: assets.length,
  };
}
