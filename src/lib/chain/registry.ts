import { CONTRACTS, type SupportedChainId } from "./chains";
import { TESTNET_ELIGIBLE_ASSETS } from "./testnet-assets";

/**
 * The eligible asset universe.
 *
 * Robinhood publishes the canonical asset list at api.robinhood.com/rhj/assets — ~195 tokenized
 * assets on mainnet. Chainlink publishes its feed directory separately. Only the **intersection**
 * is tradable here: a venue that cannot derive a guarded reference for an asset has no business
 * crossing it. As of 2026-09-21 that intersection is 35 symbols out of 195.
 *
 * Both sources are public HTTP with no auth, cached in-process because a serverless instance is
 * reused across invocations and neither list changes minute to minute.
 */

const REGISTRY_URL = "https://api.robinhood.com/rhj/assets";
const FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

const REGISTRY_TTL_MS = 6 * 60 * 60 * 1000; // asset listings change on the order of days
const FEEDS_TTL_MS = 6 * 60 * 60 * 1000;

export interface RegistryAsset {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimals: number;
  isin?: string;
  logoUrl?: string;
  status: string;
  currentMultiplier: string;
  pendingMultiplier: string;
  deployments: { contractAddress: string; chainId: number; networkName: string }[];
  tradingCapabilities?: Record<string, { whole?: string; fractional?: string }>;
}

export interface ChainlinkFeed {
  name: string;
  proxyAddress: string;
  decimals: number;
  heartbeat: number;
  threshold: number;
  feedCategory?: string;
  feedType?: string;
}

export interface EligibleAsset {
  symbol: string;
  name: string;
  address: `0x${string}`;
  decimals: number;
  isin?: string;
  logoUrl?: string;
  /** From the registry API. The authoritative value is read on-chain; this is the fallback. */
  registryMultiplier: string;
  pendingMultiplier: string;
  tradingCapabilities?: Record<string, { whole?: string; fractional?: string }>;
  feed: {
    address: `0x${string}`;
    decimals: number;
    heartbeatSeconds: number;
    deviationBps: number;
  };
}

interface Cached<T> {
  value: T;
  at: number;
}

let registryCache: Cached<RegistryAsset[]> | null = null;
let feedsCache: Cached<ChainlinkFeed[]> | null = null;
let eligibleCache: Cached<EligibleAsset[]> | null = null;

async function fetchJson<T>(url: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

export async function getRegistryAssets(force = false): Promise<RegistryAsset[]> {
  if (!force && registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) {
    return registryCache.value;
  }
  const data = await fetchJson<{ assets: RegistryAsset[] }>(REGISTRY_URL);
  registryCache = { value: data.assets ?? [], at: Date.now() };
  return registryCache.value;
}

export async function getChainlinkFeeds(force = false): Promise<ChainlinkFeed[]> {
  if (!force && feedsCache && Date.now() - feedsCache.at < FEEDS_TTL_MS) {
    return feedsCache.value;
  }
  const data = await fetchJson<ChainlinkFeed[]>(FEEDS_URL);
  feedsCache = { value: data, at: Date.now() };
  return feedsCache.value;
}

/**
 * Feed names look like `Robinhood NVDA / USD`, and occasionally `Robinhood SGOV-USD`. Both
 * separators appear in the live directory, so handle each rather than assuming one.
 */
function symbolFromFeedName(name: string): string | null {
  if (!name.startsWith("Robinhood ")) return null;
  const rest = name.slice("Robinhood ".length);
  return rest.split(" / ")[0].split("-")[0].trim() || null;
}

export async function getEligibleAssets(
  chainId: SupportedChainId,
  force = false,
): Promise<EligibleAsset[]> {
  // Testnet's universe is not in Robinhood's registry and its feeds are not in Chainlink's
  // directory — both are our own stand-ins — so filtering the mainnet sources by chain id
  // matched nothing and the dashboard rendered a market with no assets in it. Not an error and
  // not a degraded state: an empty list, indistinguishable from a venue with nothing listed.
  if (chainId === 46630) return TESTNET_ELIGIBLE_ASSETS;

  if (!force && eligibleCache && Date.now() - eligibleCache.at < REGISTRY_TTL_MS) {
    return eligibleCache.value;
  }

  const [assets, feeds] = await Promise.all([getRegistryAssets(force), getChainlinkFeeds(force)]);

  const feedBySymbol = new Map<string, ChainlinkFeed>();
  for (const feed of feeds) {
    const symbol = symbolFromFeedName(feed.name);
    if (symbol) feedBySymbol.set(symbol, feed);
  }

  const eligible: EligibleAsset[] = [];
  for (const asset of assets) {
    if (asset.status !== "ASSET_STATUS_ACTIVE") continue;
    const deployment = asset.deployments?.find((d) => d.chainId === chainId);
    if (!deployment) continue;
    const feed = feedBySymbol.get(asset.tokenSymbol);
    if (!feed) continue; // registry-listed but unpriceable — not tradable here

    eligible.push({
      symbol: asset.tokenSymbol,
      // Registry names read "NVIDIA • Robinhood Token"; the dashboard wants just the issuer.
      name: asset.tokenName.split("•")[0].trim(),
      address: deployment.contractAddress.toLowerCase() as `0x${string}`,
      decimals: asset.tokenDecimals,
      isin: asset.isin,
      logoUrl: asset.logoUrl,
      registryMultiplier: asset.currentMultiplier,
      pendingMultiplier: asset.pendingMultiplier,
      tradingCapabilities: asset.tradingCapabilities,
      feed: {
        address: feed.proxyAddress.toLowerCase() as `0x${string}`,
        decimals: feed.decimals,
        heartbeatSeconds: feed.heartbeat,
        deviationBps: Math.round((feed.threshold ?? 0) * 100),
      },
    });
  }

  eligible.sort((a, b) => a.symbol.localeCompare(b.symbol));
  eligibleCache = { value: eligible, at: Date.now() };
  return eligible;
}

/** The quote asset. USDG at launch; the treasury lane stays dormant until a real one exists. */
export function getQuoteAsset(chainId: SupportedChainId) {
  const contracts = CONTRACTS[chainId];
  if (!contracts.usdg) return null;
  return {
    symbol: chainId === 46630 ? "tUSDG" : "USDG",
    name: chainId === 46630 ? "ArcLite Test USDG" : "Global Dollar",
    address: contracts.usdg as `0x${string}`,
    decimals: 6, // verified on-chain — note this differs from the 18dp stock tokens
    kind: "STABLE" as const,
    feedAddress: contracts.usdgUsdFeed as `0x${string}`,
  };
}
