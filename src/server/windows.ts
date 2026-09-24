import { db } from "./db";
import type { SupportedChainId } from "@/lib/chain/chains";

/**
 * Window lifecycle access.
 *
 * The state machine itself lives in `arclite.advance_windows()` rather than here. A cron tick is
 * a fresh stateless invocation, and the database sits ~250ms away, so the whole transition is one
 * PL/pgSQL call in one transaction instead of a conversation. It is also the safer shape: the
 * transition and its snapshot commit together or not at all.
 */

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

/**
 * Collapse the nine lifecycle states onto the five stages the dashboard renders
 * (Ready · Sealed · Crossing · Proof · Settled). MATCHING and MATCHED are both "crossing";
 * PROVING and SETTLING are both "proof"; the terminal failure states fall back to Ready so a
 * voided window shows an honest reset rather than a stuck progress bar.
 */
export const PHASE_INDEX: Record<WindowStatus, number> = {
  OPEN: 0,
  SEALED: 1,
  MATCHING: 2,
  MATCHED: 2,
  PROVING: 3,
  SETTLING: 3,
  SETTLED: 4,
  VOID: 0,
  FAILED: 0,
};

export interface WindowView {
  seq: number;
  epochSeq: number;
  status: WindowStatus;
  phase: number;
  opensAt: string;
  sealsAt: string;
  /** The client clock cannot be trusted for a countdown; anchor it to the server's. */
  serverNow: string;
  secondsToSeal: number;
  orderCount: number;
  fillCount: number;
  deferredSymbols: string[];
  sealedAt: string | null;
  settledAt: string | null;
  /**
   * Whether anyone has been here lately.
   *
   * `orderCount` alone describes one window, and on a venue this young that number is almost
   * always zero — which reads identically to a venue that is broken, or empty, or was never
   * live at all. These say which. Cheap: `order_count` is a column on `arclite.windows`, so it
   * is an aggregate over rows the same query already touches.
   */
  recent: {
    /** Orders across every window opened in the last 24 hours. */
    orders24h: number;
    /** How many windows that covers, so the number has a denominator. */
    windows24h: number;
    /** When the most recent window that carried any order sealed. Unbounded lookback. */
    lastOrderAt: string | null;
  };
  previous: {
    seq: number;
    status: WindowStatus;
    settledAt: string | null;
    fillCount: number;
  } | null;
}

export async function advanceWindows(
  chainId: SupportedChainId,
  windowSeconds: number,
  epochSeconds: number,
): Promise<Record<string, number | string>> {
  const sql = db();
  const rows = await sql<{ result: Record<string, number | string> }[]>`
    select arclite.advance_windows(${chainId}, ${windowSeconds}, ${epochSeconds}) as result
  `;
  return rows[0]?.result ?? {};
}

export async function currentWindow(chainId: SupportedChainId): Promise<WindowView | null> {
  const sql = db();
  // One round trip for the live window, its epoch and the previous window.
  const rows = await sql<
    {
      seq: string;
      epoch_seq: string;
      status: WindowStatus;
      opens_at: Date;
      seals_at: Date;
      server_now: Date;
      order_count: number;
      fill_count: number;
      deferred_symbols: string[];
      sealed_at: Date | null;
      settled_at: Date | null;
      prev_seq: string | null;
      prev_status: WindowStatus | null;
      prev_settled_at: Date | null;
      prev_fill_count: number | null;
      orders_24h: number | null;
      windows_24h: number | null;
      last_order_at: Date | null;
    }[]
  >`
    with live as (
      select * from arclite.windows
       where chain_id = ${chainId}
         and status in ('OPEN','SEALED','MATCHING','MATCHED','PROVING','SETTLING')
       order by seq desc limit 1
    ),
    prev as (
      select * from arclite.windows
       where chain_id = ${chainId}
         and status in ('SETTLED','VOID','FAILED')
       order by seq desc limit 1
    ),
    -- The last day of windows, as one row. Bounded by time rather than by count so the answer
    -- does not change meaning when the window length is retuned.
    day as (
      select coalesce(sum(order_count), 0)::int as orders_24h,
             count(*)::int as windows_24h
        from arclite.windows
       where chain_id = ${chainId}
         and opens_at > now() - interval '24 hours'
    ),
    -- Deliberately not bounded to the day: "the last order was three weeks ago" is a true and
    -- useful thing to be able to say, and it is the sentence a quiet venue needs.
    last_order as (
      select max(opens_at) as at
        from arclite.windows
       where chain_id = ${chainId}
         and order_count > 0
    )
    select l.seq, e.seq as epoch_seq, l.status, l.opens_at, l.seals_at, now() as server_now,
           l.order_count, l.fill_count, l.deferred_symbols, l.sealed_at, l.settled_at,
           p.seq as prev_seq, p.status as prev_status,
           p.settled_at as prev_settled_at, p.fill_count as prev_fill_count,
           d.orders_24h, d.windows_24h, lo.at as last_order_at
      from live l
      join arclite.epochs e on e.id = l.epoch_id
      left join prev p on true
      left join day d on true
      left join last_order lo on true
  `;

  const r = rows[0];
  if (!r) return null;

  const serverNow = r.server_now.getTime();
  return {
    seq: Number(r.seq),
    epochSeq: Number(r.epoch_seq),
    status: r.status,
    phase: PHASE_INDEX[r.status],
    opensAt: r.opens_at.toISOString(),
    sealsAt: r.seals_at.toISOString(),
    serverNow: r.server_now.toISOString(),
    secondsToSeal: Math.max(0, Math.round((r.seals_at.getTime() - serverNow) / 1000)),
    orderCount: r.order_count,
    fillCount: r.fill_count,
    deferredSymbols: r.deferred_symbols ?? [],
    sealedAt: r.sealed_at?.toISOString() ?? null,
    settledAt: r.settled_at?.toISOString() ?? null,
    recent: {
      orders24h: r.orders_24h ?? 0,
      windows24h: r.windows_24h ?? 0,
      lastOrderAt: r.last_order_at?.toISOString() ?? null,
    },
    previous: r.prev_seq
      ? {
          seq: Number(r.prev_seq),
          status: r.prev_status as WindowStatus,
          settledAt: r.prev_settled_at?.toISOString() ?? null,
          fillCount: r.prev_fill_count ?? 0,
        }
      : null,
  };
}
