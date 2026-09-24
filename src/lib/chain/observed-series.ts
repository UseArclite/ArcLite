import { hasDb, db } from "@/server/db";
import { sessionAt } from "./sessions";
import type { SeriesPoint } from "./series";

/**
 * Price history from what the venue observed, rather than from the feed's own rounds.
 *
 * The chart walks a Chainlink aggregator backwards with `getRoundData`, which is right on
 * mainnet: the feed keeps every round and each one is a real observation. The testnet stand-ins
 * do not — `TestnetPriceFeed.getRoundData` returns the *current* answer for any round id, so
 * every point walked back has the same value and the same timestamp. They collapse to one point
 * and the chart renders a single flat dot, which looks like a broken chart rather than a mock
 * with no history behind it.
 *
 * The oracle cron already writes `price_observations` every minute, which is a real time series
 * of what this venue actually saw. On testnet that is the only honest source; using it also
 * means the chart fills in as the venue runs rather than needing the feeds redeployed.
 *
 * Deliberately not used on mainnet. There the aggregator's own rounds are the record, they go
 * back further than this database does, and each one is the price the venue would have crossed
 * at — which is a stronger claim than "what our poller happened to catch".
 */
export async function observedSeries(
  chainId: number,
  symbol: string,
  fromSeconds: number,
  targetPoints: number,
): Promise<SeriesPoint[]> {
  if (!hasDb()) return [];

  const sql = db();
  // `price_1e18` is the reference already: the feed answer scaled by the issuer multiplier, the
  // same number the chart plots on mainnet. Taking it from the column rather than recomputing
  // keeps one definition of "reference price".
  const rows = await sql<{ observed_at: Date; price_1e18: string }[]>`
    select o.feed_updated_at as observed_at, o.price_1e18::text
      from arclite.price_observations o
      join arclite.price_feeds f on f.id = o.feed_id
      join arclite.assets a on a.id = f.asset_id
     where a.chain_id = ${chainId}
       and lower(a.token_symbol) = ${symbol.toLowerCase()}
       and o.feed_updated_at >= to_timestamp(${fromSeconds})
     order by o.feed_updated_at
  `;
  if (rows.length === 0) return [];

  // One row per minute adds up; thin evenly rather than returning thousands of points for a
  // 400px-wide polyline. Evenly by index, not by time, so a gap in the observations shows as a
  // gap rather than being interpolated over.
  const stride = Math.max(1, Math.ceil(rows.length / targetPoints));
  const points: SeriesPoint[] = [];
  for (let i = 0; i < rows.length; i += stride) {
    const row = rows[i]!;
    const t = row.observed_at.getTime();
    points.push({
      t,
      v: Number(BigInt(row.price_1e18)) / 1e18,
      session: sessionAt(new Date(t)),
    });
  }
  // Always include the most recent observation: the chart's last value is the one a reader
  // compares against the price shown beside it, and a stride that skips it makes them disagree.
  const last = rows[rows.length - 1]!;
  if (points[points.length - 1]?.t !== last.observed_at.getTime()) {
    points.push({
      t: last.observed_at.getTime(),
      v: Number(BigInt(last.price_1e18)) / 1e18,
      session: sessionAt(last.observed_at),
    });
  }
  return points;
}
