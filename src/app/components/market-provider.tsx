"use client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { StockMeta } from "../lib/format";

/**
 * Live market data from /api/market/assets.
 *
 * Prices, multipliers, guards and the session all come from the chain. Execution is real too
 * now: the sealed order panel, the vault and the solvency record are the venue itself, and the
 * simulation that used to sit beside them has been removed.
 *
 * Before the endpoint answers there is nothing to show, and this says so rather than inventing
 * something. `live` is false and every consumer renders "—". The alternative — holding a
 * plausible price until the real one arrives — is how a stale $125.40 once sat on screen beside
 * assets trading at $226.
 */

export type SessionKind = "PRE" | "MARKET" | "POST" | "OVERNIGHT" | "CLOSED";

/**
 * Why an asset is not crossing, as `PriceCommitter` and the guard evaluation decide it.
 *
 * Declared here rather than imported from `@/lib/chain/market`, which pulls in viem and the RPC
 * client — a type-only import would erase, but the module is one careless value import away from
 * the browser bundle. The server owns the meaning; this is a copy of the vocabulary, and the two
 * are kept honest by `GUARD_COPY` below failing to compile if a member is added and not handled.
 */
export type GuardReason =
  | "STALE_PRICE"
  | "EVENT_WINDOW"
  | "ORACLE_PAUSED"
  | "MULTIPLIER_PENDING"
  | "SESSION_CLOSED"
  | "TOKEN_PAUSED"
  | "REGISTRY";

/**
 * Each reason in words, and what clears it.
 *
 * "Asset deferred" is the least useful true statement available: a stale feed clears on the next
 * round, a corporate action clears on a schedule, and a paused token clears when its issuer says
 * so. A trader who knows which one knows whether to wait five minutes or come back tomorrow.
 */
export const GUARD_COPY: Record<GuardReason, { title: string; detail: string }> = {
  STALE_PRICE: {
    title: "Reference too old",
    detail:
      "The feed has not answered recently enough for this session. It clears on the next round.",
  },
  EVENT_WINDOW: {
    title: "Corporate action",
    detail: "A scheduled event is in progress. Crossing resumes once the blackout window ends.",
  },
  ORACLE_PAUSED: {
    title: "Oracle paused",
    detail:
      "The issuer has paused this token's price oracle. Nothing crosses until they resume it.",
  },
  MULTIPLIER_PENDING: {
    title: "Multiplier update pending",
    detail:
      "The issuer has staged a new share multiplier. The guard holds either side of the moment it takes effect.",
  },
  SESSION_CLOSED: {
    title: "Market closed",
    detail: "This asset is outside the sessions it is permitted to trade in. It is not stale.",
  },
  TOKEN_PAUSED: {
    title: "Transfers frozen",
    detail: "The issuer's control contract has frozen transfers of this token.",
  },
  REGISTRY: {
    title: "Not eligible",
    detail: "The registry does not currently list this asset as crossable.",
  },
};

export interface MarketAsset {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  price: number;
  /** The same reference as `price`, 1e18-scaled and exact. Money maths uses this, not the float. */
  priceRaw: string;
  multiplier: number;
  priceUpdatedAt: string;
  priceAgeSeconds: number;
  session: SessionKind;
  tradable: boolean;
  logoUrl?: string;
  isin?: string;
  guard: {
    deferred: boolean;
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
  tokensPaused: boolean;
  quote: {
    symbol: string;
    name: string;
    decimals: number;
    nav: number;
    navUpdatedAt: string | null;
    navAgeSeconds: number | null;
  } | null;
  assets: MarketAsset[];
  eligibleCount: number;
  registryCount: number;
}

export interface Market {
  /** Keyed by symbol, in the shape the existing components already index. */
  stocks: Record<string, StockMeta>;
  symbols: string[];
  guards: Record<
    string,
    { stale: boolean; event: boolean; deferred: boolean; reasons: GuardReason[] }
  >;
  detail: Record<string, string | null>;
  nav: number;
  quoteSymbol: string;
  session: SessionKind;
  crossingEnabled: boolean;
  network: "mainnet" | "testnet" | null;
  chainId: number | null;
  blockNumber: number | null;
  eligibleCount: number;
  /** False while loading or after a failure. There are no numbers on screen when it is false. */
  live: boolean;
  loading: boolean;
  error: string | null;
  snapshot: MarketSnapshot | null;
}

/**
 * What the market looks like before the chain has answered: nothing.
 *
 * This used to be a three-symbol fixture — NVDA at $125.40, AAPL at $210.80, a quote asset
 * called USDY, a treasury NAV of 1.0842 — so the page had something to render while loading.
 * Every consumer gates on `live`, so it was *mostly* invisible, and "mostly" is the problem: a
 * failed `/api/market/assets` left the site showing a confident $125.40 for an asset trading at
 * $226. A wrong price shown as a real one is worse than no price, and on a venue where people
 * deposit against these numbers it is not a cosmetic difference.
 *
 * Empty is the honest default. It renders as "—" and "Loading live reference…", which is what
 * is actually true.
 */
const FIXTURE: Market = {
  stocks: {},
  symbols: [],
  guards: {},
  detail: {},
  nav: 0,
  quoteSymbol: "",
  session: "CLOSED",
  crossingEnabled: false,
  network: null,
  chainId: null,
  blockNumber: null,
  eligibleCount: 0,
  live: false,
  loading: true,
  error: null,
  snapshot: null,
};

const MarketContext = createContext<Market>(FIXTURE);

async function fetchMarket(): Promise<MarketSnapshot> {
  const res = await fetch("/api/market/assets", { headers: { accept: "application/json" } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `market endpoint returned ${res.status}`);
  }
  return (await res.json()) as MarketSnapshot;
}

function MarketState({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["market", "assets"],
    queryFn: fetchMarket,
    // Equity feeds only move on a 0.5% deviation or the 24h heartbeat, so polling harder buys
    // nothing and costs RPC budget.
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    retry: 2,
  });

  const value = useMemo<Market>(() => {
    if (!data) {
      return {
        ...FIXTURE,
        loading: isLoading,
        error: error ? (error as Error).message : null,
      };
    }

    const stocks: Record<string, StockMeta> = {};
    const guards: Market["guards"] = {};
    const detail: Record<string, string | null> = {};
    for (const a of data.assets) {
      // The whole asset, not three fields of it. The snapshot has always carried the logo, the
      // ISIN and the age of the price; flattening them away here is why none of it was ever on
      // screen.
      stocks[a.symbol] = {
        name: a.name,
        price: a.price,
        multiplier: a.multiplier,
        isin: a.isin,
        priceAgeSeconds: a.priceAgeSeconds,
        priceUpdatedAt: a.priceUpdatedAt,
      };
      guards[a.symbol] = {
        stale: a.guard.stale,
        event: a.guard.event,
        deferred: a.guard.deferred,
        reasons: a.guard.reasons ?? [],
      };
      detail[a.symbol] = a.guard.detail;
    }

    return {
      stocks,
      symbols: data.assets.map((a) => a.symbol),
      guards,
      detail,
      nav: data.quote?.nav ?? 1,
      // No fallback symbol. The quote asset is whatever the registry says it is — USDG here,
      // tUSDG on testnet — and naming one that the venue does not hold was how the old fixture's
      // "USDY" ended up on screen beside real prices.
      quoteSymbol: data.quote?.symbol ?? "",
      session: data.session,
      crossingEnabled: data.crossingEnabled,
      network: data.network,
      chainId: data.chainId,
      blockNumber: data.blockNumber,
      eligibleCount: data.eligibleCount,
      live: true,
      loading: false,
      error: null,
      snapshot: data,
    };
  }, [data, isLoading, error]);

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  // One client per browser session; a fresh one per request on the server so SSR renders never
  // share cache across users.
  if (typeof window === "undefined") {
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }
  browserQueryClient ??= new QueryClient();
  return browserQueryClient;
}

export function MarketProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      <MarketState>{children}</MarketState>
    </QueryClientProvider>
  );
}

export function useMarket(): Market {
  return useContext(MarketContext);
}

export type WindowStatus =
  | "OPEN"
  | "SEALED"
  | "MATCHING"
  | "MATCHED"
  | "PROVING"
  | "SETTLING"
  | "SETTLED"
  | "VOID"
  | "FAILED";

export interface WindowView {
  seq: number;
  epochSeq: number;
  status: WindowStatus;
  /** 0-4, indexing the dashboard's existing five stages. */
  phase: number;
  opensAt: string;
  sealsAt: string;
  serverNow: string;
  secondsToSeal: number;
  orderCount: number;
  fillCount: number;
  deferredSymbols: string[];
  /** When the book actually froze, and when the window finished. Null until each happens. */
  sealedAt: string | null;
  settledAt: string | null;
  /**
   * Whether anyone has been here lately, beyond this one window.
   *
   * Optional because a response cached across a rolling deploy will not carry it, and a panel
   * that threw on a missing field would take the window clock down with it.
   */
  recent?: {
    orders24h: number;
    windows24h: number;
    lastOrderAt: string | null;
  };
  previous: {
    seq: number;
    status: WindowStatus;
    settledAt: string | null;
    fillCount: number;
  } | null;
}

/**
 * The live batch window, from the server.
 *
 * This is what replaces the local setTimeout chain: every browser reads the same auction clock,
 * so two people watching see the same window advance at the same moment. `secondsToSeal` is
 * recomputed locally from `serverNow` between polls, so the countdown is smooth without
 * trusting the client's own clock — which can be minutes off.
 */
export function useWindow() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["market", "window"],
    queryFn: async (): Promise<WindowView | null> => {
      const res = await fetch("/api/market/window");
      if (!res.ok) throw new Error(`window returned ${res.status}`);
      const body = (await res.json()) as { window: WindowView | null };
      return body.window;
    },
    staleTime: 1_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  // Offset between the server's clock and ours, measured at each poll.
  const skewMs = useMemo(() => {
    if (!data) return 0;
    return new Date(data.serverNow).getTime() - Date.now();
  }, [data]);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!data) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [data]);

  const secondsToSeal = data
    ? Math.max(0, Math.round((new Date(data.sealsAt).getTime() - (Date.now() + skewMs)) / 1000))
    : 0;

  return {
    window: data ?? null,
    secondsToSeal,
    loading: isLoading,
    error: error ? (error as Error).message : null,
  };
}

export type Range = "1D" | "1W" | "1M";

export interface SeriesPoint {
  /** Epoch milliseconds, as the feed reported the round. */
  t: number;
  v: number;
  session: SessionKind;
}

export interface Series {
  symbol: string;
  range: Range;
  /** The plotted rounds. Served all along and never read: the chart drew the polyline alone. */
  points: SeriesPoint[];
  from: number;
  to: number;
  min: number;
  max: number;
  first: number;
  last: number;
  changePct: number;
  polyline: string;
  axis: { left: string; right: string; label: string };
  rounds: number;
  /** The requested window held too few rounds, so the view was widened. Say so in the UI. */
  widened: boolean;
}

/**
 * Reference-price history for one asset.
 *
 * Served from historical Chainlink rounds rather than a database, so the chart is real today.
 * Returns undefined while loading or on failure — the caller must not substitute a fixture
 * polyline, which would be a drawn lie rather than a missing chart.
 */
export function useSeries(symbol: string, range: Range) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["market", "series", symbol, range],
    queryFn: async (): Promise<Series> => {
      const res = await fetch(
        `/api/market/series?symbol=${encodeURIComponent(symbol)}&range=${range}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `series returned ${res.status}`);
      }
      return (await res.json()) as Series;
    },
    enabled: Boolean(symbol),
    staleTime: range === "1D" ? 30_000 : 300_000,
    retry: 1,
  });
  return { series: data, loading: isLoading, error: error ? (error as Error).message : null };
}
