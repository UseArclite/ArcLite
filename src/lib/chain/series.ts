import { aggregatorV3Abi, stockTokenAbi } from "./abis";
import { client } from "./market";
import { getEligibleAssets } from "./registry";
import { sessionAt, type SessionKind } from "./sessions";
import { observedSeries } from "./observed-series";
import type { SupportedChainId } from "./chains";

/**
 * Reference-price history, read straight from the Chainlink aggregator.
 *
 * The plan assumed the chart needed `price_candles` in Postgres. It doesn't, at least not yet:
 * aggregators expose `getRoundData(roundId)` for historical rounds, and RHC's equity feeds carry
 * ~1,000 rounds each (~13/day at a 0.5% deviation threshold). That is ample for 1D/1W/1M, so the
 * chart can be real before the database exists. The database still earns its place later — this
 * costs an RPC round trip per cold request and cannot survive a phase change in the aggregator.
 *
 * Round IDs on a proxy are `(phaseId << 64) | aggregatorRoundId`, so walking back decrements the
 * low 64 bits. Crossing a phase boundary would break that; such reads simply fail and are
 * dropped rather than being silently misdated.
 */

export type Range = "1D" | "1W" | "1M";

const RANGE_SECONDS: Record<Range, number> = {
  "1D": 24 * 60 * 60,
  "1W": 7 * 24 * 60 * 60,
  "1M": 30 * 24 * 60 * 60,
};

/** Points actually plotted. The SVG is 400×160, so more than this is invisible detail. */
const TARGET_POINTS = 48;

/** Hard cap on how far back to gallop looking for the window start. */
const MAX_LOOKBACK_ROUNDS = 4000;

export interface SeriesPoint {
  t: number;
  v: number;
  session: SessionKind;
}

export interface Series {
  symbol: string;
  range: Range;
  from: number;
  to: number;
  min: number;
  max: number;
  first: number;
  last: number;
  changePct: number;
  points: SeriesPoint[];
  /** Pre-rendered for the existing inline SVG, so the chart markup needs no restructuring. */
  polyline: string;
  axis: { left: string; right: string; label: string };
  rounds: number;
  truncated: boolean;
  /** True when the requested window held too few rounds and the view was widened to show more. */
  widened: boolean;
}

interface RoundRead {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
}

function decodeRound(result: unknown): RoundRead | null {
  const r = result as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
  if (!r) return null;
  const [roundId, answer, , updatedAt] = r;
  if (answer <= 0n || updatedAt === 0n) return null;
  return { roundId, answer, updatedAt };
}

const cache = new Map<string, { at: number; series: Series }>();
const CACHE_TTL_MS = 60_000;

export async function getSeries(
  chainId: SupportedChainId,
  symbol: string,
  range: Range,
): Promise<Series> {
  const key = `${chainId}:${symbol.toLowerCase()}:${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.series;

  const assets = await getEligibleAssets(chainId);
  // Case-insensitive: the caller's casing is whatever a link or a bookmark carried, and the
  // answer should not depend on it.
  const asset = assets.find((a) => a.symbol.toLowerCase() === symbol.toLowerCase());
  if (!asset) throw new Error(`${symbol} is not an eligible asset`);

  const pub = client(chainId);
  const feed = asset.feed.address;

  const [latestRaw] = await Promise.all([
    pub.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "latestRoundData" }),
    pub
      .readContract({ address: asset.address, abi: stockTokenAbi, functionName: "uiMultiplier" })
      .catch(() => 10n ** 18n),
  ]);

  const latest = decodeRound(latestRaw);
  if (!latest) throw new Error(`${symbol} has no valid latest round`);

  const to = Number(latest.updatedAt);
  const from = to - RANGE_SECONDS[range];

  // On testnet the feed keeps no history: `TestnetPriceFeed.getRoundData` returns the current
  // answer for any round id, so walking backwards yields the same value and timestamp every
  // time and the chart collapses to a single dot. The oracle cron's `price_observations` is a
  // real series of what the venue saw, and it is the only honest source here.
  //
  // Mainnet keeps using the aggregator's own rounds: they reach further back than this database
  // does, and each one is a price the venue would have crossed at, which is a stronger claim
  // than "what our poller happened to catch".
  if (chainId === 46630) {
    const observed = await observedSeries(chainId, symbol, from, TARGET_POINTS);
    if (observed.length >= 2) {
      // Never truncated: the query asked for the whole range and returned what exists in it.
      const built = build(symbol, range, observed, false, observed.length, false);
      cache.set(key, { at: Date.now(), series: built });
      return built;
    }
  }

  // Gallop backwards to find roughly how many rounds cover the window, rather than assuming a
  // rate — deviation-triggered feeds are bursty, and a fixed guess is wrong in both directions.
  let span = 16;
  let oldestOffset = 0;
  let truncated = false;
  while (span <= MAX_LOOKBACK_ROUNDS) {
    const probeId = latest.roundId - BigInt(span);
    const probe = await pub
      .readContract({
        address: feed,
        abi: aggregatorV3Abi,
        functionName: "getRoundData",
        args: [probeId],
      })
      .then(decodeRound)
      .catch(() => null);

    if (!probe) {
      // Ran off the start of the phase: take what exists.
      truncated = true;
      break;
    }
    oldestOffset = span;
    if (Number(probe.updatedAt) <= from) break;
    span *= 2;
    if (span > MAX_LOOKBACK_ROUNDS) truncated = true;
  }

  // Sample evenly across the covered range so one multicall yields the whole chart.
  const stride = Math.max(1, Math.ceil(oldestOffset / TARGET_POINTS));
  const offsets: number[] = [];
  for (let o = oldestOffset; o > 0; o -= stride) offsets.push(o);
  offsets.push(0);

  const results = await pub.multicall({
    contracts: offsets.map((o) => ({
      address: feed,
      abi: aggregatorV3Abi,
      functionName: "getRoundData" as const,
      args: [latest.roundId - BigInt(o)] as const,
    })),
    allowFailure: true,
  });

  const scale = 10 ** asset.feed.decimals;
  const points: SeriesPoint[] = [];
  for (const r of results) {
    if (r.status !== "success") continue;
    const round = decodeRound(r.result);
    if (!round) continue;
    const t = Number(round.updatedAt);
    if (t < from) continue;
    points.push({
      t: t * 1000,
      v: Number(round.answer) / scale,
      session: sessionAt(new Date(t * 1000)),
    });
  }
  points.sort((a, b) => a.t - b.t);

  // A strict window is the honest default, but over a weekend or a holiday a 24h window can
  // contain a single round — real data, useless chart. Rather than pad it with invented points,
  // widen to the most recent rounds that exist and say so in the axis label.
  let widened = false;
  if (points.length < 4) {
    const fallback: SeriesPoint[] = [];
    for (const r of results) {
      if (r.status !== "success") continue;
      const round = decodeRound(r.result);
      if (!round) continue;
      const t = Number(round.updatedAt);
      fallback.push({
        t: t * 1000,
        v: Number(round.answer) / scale,
        session: sessionAt(new Date(t * 1000)),
      });
    }
    fallback.sort((a, b) => a.t - b.t);
    const recent = fallback.slice(-Math.max(TARGET_POINTS, 12));
    if (recent.length > points.length) {
      points.length = 0;
      points.push(...recent);
      widened = true;
    }
  }

  if (points.length === 0) throw new Error(`${symbol} has no rounds in the ${range} window`);

  const built = build(symbol, range, points, widened, offsets.length, truncated);
  cache.set(key, { at: Date.now(), series: built });
  return built;
}

/**
 * Turn points into the shape the dashboard renders, whatever produced them.
 *
 * Shared by both sources deliberately: the polyline's coordinate space has to match the SVG's
 * `viewBox` exactly, and a second copy of that arithmetic is a second thing to get wrong.
 */
function build(
  symbol: string,
  range: Range,
  points: SeriesPoint[],
  widened: boolean,
  rounds: number,
  truncated: boolean,
): Series {
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const first = values[0];
  const last = values[values.length - 1];

  // Match the existing SVG's coordinate space exactly: viewBox="0 0 400 160", y inverted, with a
  // little padding so the extremes aren't clipped against the frame.
  const W = 400;
  const H = 160;
  const PAD = 12;
  const tMin = points[0].t;
  const tMax = points[points.length - 1].t;
  const tRange = Math.max(1, tMax - tMin);
  const vRange = Math.max(1e-9, max - min);
  const polyline = points
    .map((p) => {
      const x = ((p.t - tMin) / tRange) * W;
      const y = H - PAD - ((p.v - min) / vRange) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const fmt = (ms: number, withDate: boolean) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      ...(withDate
        ? { month: "short", day: "numeric" }
        : { hour: "2-digit", minute: "2-digit", hour12: false }),
    }).format(new Date(ms));

  const spanHours = (tMax - tMin) / 3_600_000;
  const sameDay = spanHours < 24 && !widened;
  const axis = sameDay
    ? { left: fmt(tMin, false), right: fmt(tMax, false), label: "LAST 24 HOURS" }
    : {
        left: fmt(tMin, true),
        right: fmt(tMax, true),
        // Don't claim a 24-hour view when the market was shut and the points span days.
        label: widened
          ? `LAST ${points.length} REFERENCE UPDATES`
          : range === "1W"
            ? "LAST 7 DAYS"
            : "LAST 30 DAYS",
      };

  const series: Series = {
    symbol,
    range,
    from: tMin,
    to: tMax,
    min,
    max,
    first,
    last,
    changePct: first === 0 ? 0 : ((last - first) / first) * 100,
    points,
    polyline,
    axis,
    rounds,
    truncated,
    widened,
  };
  return series;
}
