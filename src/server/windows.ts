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
    )
    select l.seq, e.seq as epoch_seq, l.status, l.opens_at, l.seals_at, now() as server_now,
           l.order_count, l.fill_count, l.deferred_symbols, l.sealed_at, l.settled_at,
           p.seq as prev_seq, p.status as prev_status,
           p.settled_at as prev_settled_at, p.fill_count as prev_fill_count
      from live l
      join arclite.epochs e on e.id = l.epoch_id
      left join prev p on true
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
