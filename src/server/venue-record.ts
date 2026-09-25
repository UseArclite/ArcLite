import { db, hasDb } from "./db";
import type { SupportedChainId } from "@/lib/chain/chains";

/**
 * What this venue has actually done, in aggregate.
 *
 * The roadmap entry for this is explicit that the denominators go in: *"the ratio of windows that
 * crossed is the interesting number and hiding it would be the wrong instinct."* That is right,
 * and on this venue today it is unflattering — 797 windows, 4 orders, nothing crossed. A page
 * showing only the flattering half of that would be worse than no page, because the figures it
 * omitted are exactly the ones somebody is trying to find out.
 *
 * Aggregate only. Nothing here is per-account or per-order: these are counts over `windows` and
 * `window_assets_matched`, both of which are venue-level tables. A public record that leaked which
 * account did what would be the one kind of transparency this product cannot offer.
 */

export interface VenueRecord {
  /** Windows the venue has opened, ever. */
  windows: number;
  /** Of those, how many reached SETTLED. */
  settled: number;
  /** Windows that ended VOID or FAILED — the machinery not working. */
  failed: number;
  /** Windows that carried at least one order. The denominator that matters. */
  withOrders: number;
  /** Windows in which something actually crossed. */
  withFills: number;
  /** Orders submitted across the venue's life. */
  orders: number;
  /** Fills recorded, including those that crossed nothing. */
  fills: number;
  /** Fills that actually moved size. */
  crossed: number;
  /** Distinct assets that have ever had a book. */
  assetsBooked: number;
  /** Assets the venue will price at all. */
  assetsEligible: number;
  /** When the first window opened. */
  since: string | null;
}

export async function venueRecord(chainId: SupportedChainId): Promise<VenueRecord | null> {
  if (!hasDb()) return null;
  const sql = db();

  const [w] = await sql<
    {
      windows: number;
      settled: number;
      failed: number;
      with_orders: number;
      with_fills: number;
      orders: number;
      fills: number;
      since: Date | null;
    }[]
  >`
    select count(*)::int as windows,
           count(*) filter (where status = 'SETTLED')::int as settled,
           count(*) filter (where status in ('VOID','FAILED'))::int as failed,
           count(*) filter (where order_count > 0)::int as with_orders,
           count(*) filter (where fill_count > 0)::int as with_fills,
           coalesce(sum(order_count), 0)::int as orders,
           coalesce(sum(fill_count), 0)::int as fills,
           min(opens_at) as since
      from arclite.windows
     where chain_id = ${chainId}
  `;

  // `matched` and `partial` are the reasons that moved size. `unmatched`, `stale` and `event` are
  // orders that rested — counted separately rather than folded in, because the difference between
  // "an order was filled" and "an order existed" is the whole question this page answers.
  const [c] = await sql<{ crossed: number }[]>`
    select count(*)::int as crossed
      from arclite.fills f
      join arclite.windows wi on wi.id = f.window_id
     where wi.chain_id = ${chainId} and f.reason in ('matched','partial')
  `;

  const [a] = await sql<{ booked: number }[]>`
    select count(distinct wam.asset_id)::int as booked
      from arclite.window_assets_matched wam
      join arclite.windows wi on wi.id = wam.window_id
     where wi.chain_id = ${chainId}
  `;

  const [e] = await sql<{ eligible: number }[]>`
    select count(*)::int as eligible from arclite.assets
     where chain_id = ${chainId} and eligible
  `;

  return {
    windows: w?.windows ?? 0,
    settled: w?.settled ?? 0,
    failed: w?.failed ?? 0,
    withOrders: w?.with_orders ?? 0,
    withFills: w?.with_fills ?? 0,
    orders: w?.orders ?? 0,
    fills: w?.fills ?? 0,
    crossed: c?.crossed ?? 0,
    assetsBooked: a?.booked ?? 0,
    assetsEligible: e?.eligible ?? 0,
    since: w?.since?.toISOString() ?? null,
  };
}
