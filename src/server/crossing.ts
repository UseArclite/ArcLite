import { db, hasDb } from "./db";
import type { SupportedChainId } from "@/lib/chain/chains";

/**
 * How often each asset has actually crossed.
 *
 * `unmatched` is the expected outcome on a young venue, and until now the dashboard only said so
 * *afterwards* — the receipts panel apologising for a fill that never came. This is the same fact
 * delivered before the order is submitted, which is the only moment it can change a decision.
 *
 * ## The denominator is windows with a book, not windows
 *
 * The obvious phrasing is "crossed in 3 of the last 40 windows". On this venue that would be
 * close to meaningless: windows open every five minutes whether or not anybody is here, so the
 * denominator would be ~288 a day and almost all of them empty for every asset. "Crossed in 0 of
 * the last 288 windows" describes the clock, not the asset.
 *
 * `window_assets_matched` carries a row only for an asset that was actually in a window's match,
 * so counting those rows asks the question worth asking: *when there was a book in this asset,
 * how often did it cross?* Nine of eleven is a liquid asset. Zero of two is a young one. Both are
 * true statements the venue can stand behind, and neither is a forecast — which matters, because
 * a probability here would be a claim this data cannot support.
 */

export interface AssetCrossing {
  /** Registry id, as `window_assets_matched` and `fills` store it. */
  assetId: number;
  /** Windows in which this asset had a book at all. */
  booked: number;
  /** How many of those actually crossed size. */
  crossed: number;
  /** When the most recent crossing window sealed. */
  lastCrossAt: string | null;
}

export async function crossingHistory(chainId: SupportedChainId): Promise<AssetCrossing[]> {
  if (!hasDb()) return [];
  const sql = db();
  const rows = await sql<
    { asset_id: number; booked: number; crossed: number; last_cross_at: Date | null }[]
  >`
    select wam.asset_id,
           count(*)::int as booked,
           coalesce(sum(case when wam.matched > 0 then 1 else 0 end), 0)::int as crossed,
           max(case when wam.matched > 0 then w.seals_at end) as last_cross_at
      from arclite.window_assets_matched wam
      join arclite.windows w on w.id = wam.window_id
     where w.chain_id = ${chainId}
     group by wam.asset_id
     order by wam.asset_id
  `;
  return rows.map((r) => ({
    assetId: Number(r.asset_id),
    booked: r.booked,
    crossed: r.crossed,
    lastCrossAt: r.last_cross_at?.toISOString() ?? null,
  }));
}
