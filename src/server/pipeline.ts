import { ARCLITE, resolveChainId } from "@/lib/chain/chains";
import { db } from "@/server/db";
import {
  matchWindow,
  checkInvariants,
  type AssetReference,
  type MatchOrder,
} from "@/server/matcher";
import { revealWindow } from "@/server/orders";
import { FLAG_EVENT, FLAG_STALE } from "@/lib/notes/prices";

/**
 * The stages between a sealed book and a provable batch.
 *
 * Order is not arbitrary. Each step depends on the previous one having reached the chain:
 *
 *   reveal  — decrypt the book, assign `seq`, derive `ordersRoot`
 *   seal    — freeze that root on chain          (chain-windows.ts)
 *   price   — the contract reads the feeds itself (chain-windows.ts)
 *   match   — cross at the reference the contract committed
 *
 * Matching last is the point. The matcher crosses at the price `PriceCommitter` derived *after*
 * the book was frozen, not at one we chose — so there is no window in which the operator both
 * knows the book and can still influence the reference. Running match before pricing would
 * quietly give that back.
 */

export interface PipelineResult {
  revealed: number;
  rejected: number;
  matched: number;
  fills: number;
  errors: string[];
}

const pricerAbi = [
  {
    type: "function",
    name: "entryOf",
    stateMutability: "view",
    inputs: [{ type: "uint64" }, { type: "uint16" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "assetId", type: "uint16" },
          { name: "kind", type: "uint8" },
          { name: "flags", type: "uint8" },
          { name: "updatedAt", type: "uint64" },
          { name: "roundId", type: "uint80" },
          { name: "refValueE18", type: "uint128" },
          { name: "uiMultiplierE18", type: "uint128" },
        ],
      },
    ],
  },
] as const;

/**
 * Decrypt any window whose book has closed but has not been opened yet.
 *
 * Runs before the chain seal, because the chain seal needs the orders root this produces. A
 * window whose key is gone reveals nothing and gets no root, which leaves it unsealed on chain —
 * visible in `/api/health` as a divergence, and eventually voided rather than settled against an
 * empty book that silently discarded real orders.
 */
export async function revealSealedWindows(
  chainId: number,
): Promise<{ revealed: number; rejected: number; errors: string[] }> {
  const sql = db();
  const due = await sql<{ id: string; seq: string; chain_window_id: string }[]>`
    select w.id::text, w.seq::text, w.chain_window_id::text
      from arclite.windows w
     where w.chain_id = ${chainId}
       and w.status not in ('OPEN', 'VOID', 'FAILED')
       and w.orders_root is null
       and exists (select 1 from arclite.orders o where o.window_id = w.id and o.status = 'SEALED')
     order by w.seq limit 4
  `;

  let revealed = 0;
  let rejected = 0;
  const errors: string[] = [];

  for (const window of due) {
    try {
      // The **chain** window id, not `seq`. `ordersRoot` is bound to it, the pool stores the
      // root under it, and `batch_cross` recomputes it from the same value — so revealing with
      // `seq` produced a root the settler could never reproduce. The window sealed, priced and
      // matched, and settlement reverted with `SumcheckFailed()`: a valid proof of a statement
      // about a different window id.
      //
      // Second time this exact confusion has cost a day. `seq` is a per-chain counter that
      // restarts whenever the database is rebuilt; `chain_window_id` is what the pool knows.
      // Anything the chain will check has to be bound to the latter.
      const result = await revealWindow(window.id, BigInt(window.chain_window_id));
      revealed += result.revealed;
      rejected += result.rejected;
      if (result.ordersRoot === null) {
        errors.push(`window ${window.seq}: sealing key is unavailable, book cannot be opened`);
      }
    } catch (error) {
      errors.push(`reveal ${window.seq}: ${(error as Error).message}`);
    }
  }

  return { revealed, rejected, errors };
}

/**
 * Cross every window that has been priced on chain but not matched.
 *
 * The references come from `PriceCommitter.entryOf` — what the contract committed, read back —
 * rather than from our own view of the feeds. Those can differ, and when they do the contract is
 * right: a proof built against anything else would cite a table the pool never committed.
 */
export async function matchPricedWindows(
  chainId: number,
): Promise<{ matched: number; fills: number; errors: string[] }> {
  const sql = db();
  const deployed = ARCLITE[resolveChainId()];
  const errors: string[] = [];
  let matched = 0;
  let fills = 0;

  if (!deployed.priceCommitter) return { matched, fills, errors: ["no price committer deployed"] };

  const due = await sql<{ id: string; seq: string; chain_window_id: string }[]>`
    select id::text, seq::text, chain_window_id::text from arclite.windows_needing_match(${chainId})
  `;
  if (due.length === 0) return { matched, fills, errors };

  const { relayer } = await import("@/server/relayer");
  const client = relayer().read;

  for (const window of due) {
    try {
      const orders = await sql<
        { id: string; seq: number; asset_id: number; side: "buy" | "sell"; quantity_raw: string }[]
      >`
        select id::text, seq, asset_id, side, quantity_raw::text
          from arclite.orders
         where window_id = ${window.id}::bigint and status in ('REVEALED', 'MATCHED')
         order by seq
      `;

      if (orders.length === 0) {
        // Nothing to cross. Recorded as a match with no fills rather than left unmatched, so the
        // window can progress instead of being retried every tick forever.
        await sql`select arclite.record_match(${window.id}::bigint, '[]'::jsonb, '[]'::jsonb, 0)`;
        matched += 1;
        continue;
      }

      // One reference per asset actually in the book, read back from the contract.
      const assetIds = [...new Set(orders.map((o) => o.asset_id))];
      const references: AssetReference[] = await Promise.all(
        assetIds.map(async (assetId) => {
          const entry = await client.readContract({
            address: deployed.priceCommitter as `0x${string}`,
            abi: pricerAbi,
            functionName: "entryOf",
            args: [BigInt(window.chain_window_id), assetId],
          });
          const flags = Number(entry.flags);
          return {
            assetId,
            price1e18: entry.refValueE18,
            decimals: 18,
            deferred: flags !== 0,
            // The dashboard renders these two and the circuit constrains them, so the mapping
            // from flag bits to a reason lives in one place rather than being re-guessed.
            deferReason:
              (flags & FLAG_EVENT) !== 0
                ? "event"
                : (flags & FLAG_STALE) !== 0
                  ? "stale"
                  : undefined,
          } satisfies AssetReference;
        }),
      );

      const book: MatchOrder[] = orders.map((o) => ({
        seq: o.seq,
        assetId: o.asset_id,
        side: o.side,
        quantity: BigInt(o.quantity_raw),
      }));

      // USDG is the quote. Its own reference is not committed per window yet, so it is pinned at
      // par here; the dual-reference path is already a variable throughout the matcher and the
      // circuit, so opening the treasury lane is a value change rather than a rewrite.
      const result = matchWindow(book, references, { price1e18: 10n ** 18n, decimals: 6 });

      // Re-derive the circuit's constraints from the result before anything is written. A
      // matcher bug caught here names the broken property; caught by the prover it is an
      // unsatisfied constraint with a line number and nothing else.
      const problems = checkInvariants(result);
      if (problems.length > 0)
        throw new Error(`matcher violated its own invariants: ${problems.join("; ")}`);

      const bySeq = new Map(orders.map((o) => [o.seq, o.id]));
      const fillRows = result.fills.map((f) => ({
        order_id: Number(bySeq.get(f.seq)),
        seq: f.seq,
        asset_id: f.assetId,
        side: f.side,
        quantity_raw: f.quantity.toString(),
        filled_raw: f.filled.toString(),
        residual_raw: f.residual.toString(),
        quote_raw: f.quote.toString(),
        reason: f.reason,
      }));
      const assetRows = result.assets.map((a) => ({
        asset_id: a.assetId,
        buy_total: a.buyTotal.toString(),
        sell_total: a.sellTotal.toString(),
        matched: a.matched.toString(),
        deferred: a.deferred,
      }));

      const written = await sql<{ record_match: number }[]>`
        select arclite.record_match(${window.id}::bigint, ${sql.json(fillRows)},
          ${sql.json(assetRows)}, ${result.paid.toString()}::numeric)
      `;
      fills += written[0]?.record_match ?? 0;
      matched += 1;
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await sql`select arclite.record_chain_error(${window.id}::bigint, ${message})`;
      errors.push(`match ${window.seq}: ${message}`);
    }
  }

  return { matched, fills, errors };
}
