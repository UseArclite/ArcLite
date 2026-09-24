import { decodeFunctionData, toHex, type Address, type Hash } from "viem";
import { ARCLITE, resolveChainId } from "@/lib/chain/chains";
import { commitment as noteCommitment } from "@/lib/notes/note";
import { emptyEntry, MAX_ASSETS, type PriceEntry } from "@/lib/notes/prices";
import { db } from "@/server/db";
import { authPath, buildWitness, N_ORDERS } from "@/server/witness";
import {
  executeWitness,
  proveBatch,
  proverUnavailableReason,
  toNoirInputs,
  verifyBatch,
} from "@/server/prover";
import { hasRelayer, relayer } from "@/server/relayer";
import { readLeafSet } from "@/server/leaves";

/**
 * Proving a matched window and settling it on chain.
 *
 * This is the last stage that was still driven by hand. Everything it needs already exists: the
 * matcher's fills, the price table the contract committed, and the notes the revealed orders
 * name. What it adds is the proof, and the transaction that spends it.
 *
 * ## Output notes belong to their traders, and the circuit enforces it
 *
 * The outputs are no longer chosen by whoever builds the proof. `batch_cross` derives them from
 * the sealed book — two per order, the residual and the received leg, both owned by that order's
 * owner — and refuses any subtree that differs. Before that constraint existed, a settler could
 * spend a trader's note and pay the whole proceeds into a note of their own while every
 * conservation check still passed.
 *
 * `nsecret_out` derives from the order's own `nsecret`, so a trader regenerates the note from key
 * material they already hold rather than needing anything published.
 *
 * **What is still missing:** spending a note requires only its `owner` preimage and `nsecret`,
 * with no signature. The settler learns `nsecret` from the revealed order, so it cannot redirect
 * a trade but it *can* construct a later batch that spends the same trader's notes. Closing that
 * needs a Schnorr signature per order bundle verified in-circuit — the design calls for one and
 * it is not implemented. Recorded in plan.md rather than left to be discovered.
 */

const poolAbi = [
  {
    type: "function",
    name: "settleBatch",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "windowId", type: "uint64" },
          { name: "subBatchIndex", type: "uint8" },
          { name: "proof", type: "bytes" },
          { name: "oldRoot", type: "bytes32" },
          { name: "outputsSubtreeRoot", type: "bytes32" },
          { name: "outputsSubtreeDepth", type: "uint8" },
          { name: "nullifiers", type: "bytes32[]" },
          { name: "outputCommitments", type: "bytes32[]" },
          { name: "receiptsRoot", type: "bytes32" },
          { name: "tapeLeaf", type: "bytes32" },
          { name: "filledOrders", type: "uint16" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "windows",
    stateMutability: "view",
    inputs: [{ type: "uint64" }],
    // Flattened, not a tuple: a public mapping getter returns the struct's fields as separate
    // values. Declaring one tuple decoded `ordersRoot` as 824401279 — small enough to be
    // obviously not a hash, which is the only reason it was caught.
    outputs: [
      { name: "ordersRoot", type: "bytes32" },
      { name: "tapeCommitment", type: "bytes32" },
      { name: "sealedAt", type: "uint64" },
      { name: "settledAt", type: "uint64" },
      { name: "orderCount", type: "uint16" },
      { name: "subBatchCount", type: "uint8" },
      { name: "subBatchesSettled", type: "uint8" },
      { name: "finalized", type: "bool" },
      { name: "voided", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "quoteAssetId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "currentRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
] as const;

const pricerAbi = [
  // Present only so the pricing transaction's calldata can be decoded — the ordered asset list
  // it carries is not recoverable from contract state.
  {
    type: "function",
    name: "commitWindow",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint64" }, { type: "uint16[]" }],
    outputs: [{ type: "bytes32" }, { type: "uint256" }],
  },
  {
    type: "function",
    name: "window",
    stateMutability: "view",
    inputs: [{ type: "uint64" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "pricesRoot", type: "bytes32" },
          { name: "deferMask", type: "uint256" },
          { name: "committedAt", type: "uint64" },
          { name: "assetCount", type: "uint16" },
          { name: "sequencerOk", type: "bool" },
        ],
      },
    ],
  },
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

export interface SettleResult {
  skipped?: string;
  settled: number;
  errors: string[];
}

/**
 * The asset ids a window was priced over, in committed order.
 *
 * `PriceCommitter` stores entries as `_entries[windowId][assetId]` and keeps only `assetCount`,
 * so the ordered list it hashed cannot be read back from state. It can be read back from the
 * transaction that made the call, which is the same bytes the contract executed.
 *
 * The fallback covers a window priced before `priced_tx` was recorded: the old positional
 * assumption, which is right exactly when the priced assets are 1..n — true on testnet, and the
 * reason this was wrong for a year without failing.
 */
async function committedAssetIds(
  r: ReturnType<typeof relayer>,
  pricedTx: string | null,
  assetCount: number,
): Promise<number[]> {
  if (pricedTx) {
    const tx = await r.read.getTransaction({ hash: pricedTx as Hash }).catch(() => null);
    if (tx) {
      const { functionName, args } = decodeFunctionData({ abi: pricerAbi, data: tx.input });
      if (functionName === "commitWindow") {
        const ids = (args as readonly [bigint, readonly number[]])[1];
        if (ids.length !== assetCount) {
          throw new Error(
            `priced ${assetCount} assets but ${pricedTx} names ${ids.length} — wrong transaction`,
          );
        }
        return [...ids];
      }
    }
  }
  return Array.from({ length: assetCount }, (_, i) => i + 1);
}

export async function settleMatchedWindows(): Promise<SettleResult> {
  const result: SettleResult = { settled: 0, errors: [] };

  const unavailable = proverUnavailableReason();
  if (unavailable) return { ...result, skipped: unavailable };
  if (!hasRelayer()) return { ...result, skipped: "no RELAYER_PRIVATE_KEY" };

  const chainId = resolveChainId();
  const deployed = ARCLITE[chainId];
  if (!deployed.pool || !deployed.priceCommitter) {
    return { ...result, skipped: "contracts are not deployed on this network" };
  }

  const sql = db();
  const due = await sql<
    { id: string; seq: string; chain_window_id: string; priced_tx: string | null }[]
  >`
    select id::text, seq::text, chain_window_id::text, priced_tx from arclite.windows
     where chain_id = ${chainId} and matcher_ran_at is not null and settled_tx is null
       and status not in ('VOID', 'FAILED')
     order by seq limit 1
  `;
  if (due.length === 0) return result;

  const r = relayer();
  const pool = deployed.pool as Address;
  const pricer = deployed.priceCommitter as Address;

  for (const window of due) {
    const chainWindowId = BigInt(window.chain_window_id);
    try {
      const fills = await sql<
        {
          seq: number;
          asset_id: number;
          side: "buy" | "sell";
          quantity_raw: string;
          filled_raw: string;
          note_units_raw: string;
          owner_field: string;
          salt_field: string;
          commitment: Uint8Array;
          pk_x: string;
          pk_y: string;
          npk: string;
          sig_s_lo: string;
          sig_s_hi: string;
          sig_e_lo: string;
          sig_e_hi: string;
        }[]
      >`
        select f.seq, f.asset_id, f.side, f.quantity_raw::text, f.filled_raw::text,
               o.note_units_raw::text, o.owner_field::text, o.salt_field::text, o.commitment,
               o.pk_x::text, o.pk_y::text, o.npk::text,
               o.sig_s_lo::text, o.sig_s_hi::text, o.sig_e_lo::text, o.sig_e_hi::text
          from arclite.fills f join arclite.orders o on o.id = f.order_id
         where f.window_id = ${window.id}::bigint order by f.seq
      `;
      if (fills.length === 0) {
        await sql`select arclite.record_chain_error(${window.id}::bigint, 'nothing to settle')`;
        continue;
      }
      if (fills.length > N_ORDERS) throw new Error(`${fills.length} orders exceeds one sub-batch`);

      // The relayer's read client carries an account, which viem's `PublicClient` type says it
      // does not. Only `getLogs` is used, and the cast is confined to this one call rather than
      // loosening the shared reader for everyone.
      const leaves = await readLeafSet(
        r.read as unknown as Parameters<typeof readLeafSet>[0],
        pool,
        BigInt(deployed.deployBlock ?? 0),
      );
      const position = new Map<bigint, number>();
      for (let i = 0; i < leaves.length; i++)
        if (!position.has(leaves[i]!)) position.set(leaves[i]!, i);

      // Read from the pool rather than configured here: it is a public input of the proof and
      // the pool holds it in an immutable, so anything else would simply fail to verify.
      const quoteAssetId = BigInt(
        await r.read.readContract({ address: pool, abi: poolAbi, functionName: "quoteAssetId" }),
      );

      const committed = await r.read.readContract({
        address: pricer,
        abi: pricerAbi,
        functionName: "window",
        args: [chainWindowId],
      });
      // Which assets were priced, in the order they were priced.
      //
      // `entryOf(windowId, assetId)` is keyed by **asset id**, and the price root is a hash
      // chain over the entries in committed order — so reconstructing the table needs the exact
      // `uint16[]` that went into `commitWindow`, and the contract does not keep it. Only
      // `assetCount` survives on chain.
      //
      // This used to read `entryOf(windowId, i + 1)`, treating the second argument as a 1-based
      // position. On testnet that is indistinguishable from correct: the priced assets are 1, 2
      // and 3, so position and asset id are the same number. On mainnet the first real order was
      // for NVDA, asset 22, priced alone — position 1 read an empty slot, and settlement aborted
      // with "asset not in the committed table" for an asset that was very much in it.
      //
      // The pricing transaction's calldata is the authoritative record: it is what the contract
      // actually hashed. Recomputing the selection here instead would be a second implementation
      // of a decision already made, free to drift from it between pricing and settlement.
      const pricedAssetIds = await committedAssetIds(r, window.priced_tx, committed.assetCount);

      const entries: PriceEntry[] = Array.from({ length: MAX_ASSETS }, emptyEntry);
      for (let i = 0; i < committed.assetCount; i++) {
        const e = await r.read.readContract({
          address: pricer,
          abi: pricerAbi,
          functionName: "entryOf",
          args: [chainWindowId, pricedAssetIds[i]!],
        });
        entries[i] = {
          assetId: BigInt(e.assetId),
          kind: BigInt(e.kind),
          flags: BigInt(e.flags),
          updatedAt: BigInt(e.updatedAt),
          roundId: BigInt(e.roundId),
          refValueE18: BigInt(e.refValueE18),
          uiMultiplierE18: BigInt(e.uiMultiplierE18),
        };
      }

      const orders = fills.map((f) => {
        // The note is not the order. A seller's note holds the asset being sold; a **buyer's
        // holds quote**, because that is what a buy is funded with. Rebuilding both as
        // `{asset_id, quantity}` made a buy a no-op — the buyer spent a note of the asset and
        // was handed the same asset back — and the quote a seller received came from nowhere.
        const note = {
          assetId: f.side === "buy" ? quoteAssetId : BigInt(f.asset_id),
          units: BigInt(f.note_units_raw),
          owner: BigInt(f.owner_field),
          nsecret: BigInt(f.salt_field),
        };
        // The order claimed a commitment at submission; the revealed payload has to rebuild it.
        // If it does not, the order does not correspond to a real note and proving it would be
        // proving a spend of something that was never deposited.
        const rebuilt = noteCommitment(note);
        const claimed = BigInt(toHex(f.commitment));
        if (rebuilt !== claimed) {
          // Say which field is wrong, not just that one is. The commitment covers four values
          // and the message named none of them, so the same sentence stood for a bad salt, a
          // buy funded from the wrong asset, and a note whose units were the order's quantity.
          throw new Error(
            `order ${f.seq}: revealed payload does not rebuild its commitment ` +
              `(asset ${note.assetId}, units ${note.units}, owner ${note.owner}, ` +
              `nsecret from salt_field; rebuilt ${rebuilt}, claimed ${claimed}). ` +
              `The order salt must be the note's nsecret — see OrderPayload.salt.`,
          );
        }
        const leafIndex = position.get(rebuilt);
        if (leafIndex === undefined) {
          throw new Error(`order ${f.seq}: its note is not in the pool's tree — was it shielded?`);
        }
        const assetIndex = entries.findIndex((e) => e.assetId === BigInt(f.asset_id));
        if (assetIndex < 0) throw new Error(`order ${f.seq}: asset not in the committed table`);

        return {
          assetIndex,
          side: f.side,
          quantity: BigInt(f.quantity_raw),
          filled: BigInt(f.filled_raw),
          salt: BigInt(f.salt_field),
          note,
          leafIndex: BigInt(leafIndex),
          path: authPath(leaves, leafIndex),
          // The owner's authorisation, carried through from the revealed payload. Without it the
          // circuit refuses the spend, which is the point: the settler knows the note's secrets
          // and still cannot move it.
          auth: {
            pkX: BigInt(f.pk_x),
            pkY: BigInt(f.pk_y),
            npk: BigInt(f.npk),
            sLo: BigInt(f.sig_s_lo),
            sHi: BigInt(f.sig_s_hi),
            eLo: BigInt(f.sig_e_lo),
            eHi: BigInt(f.sig_e_hi),
          },
        };
      });

      const oldRoot = await r.read.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "currentRoot",
      });

      const witness = buildWitness({
        circuitVersion: 1n,
        windowId: chainWindowId,
        subBatchIndex: 0n,
        oldRoot: BigInt(oldRoot),
        entries,
        assetCount: committed.assetCount,
        pricedAt: BigInt(committed.committedAt),
        sequencerOk: committed.sequencerOk,
        quoteAssetId,
        orders,
      });

      // Derived by `buildWitness` from the sealed book, and checked by the circuit — so these
      // are the only outputs that can possibly prove.
      const outputs = (witness.private as { out_commitment: bigint[] }).out_commitment;

      const solved = await executeWitness(toNoirInputs(witness));
      const proof = await proveBatch(solved);
      // Verify before spending gas. A rejected proof costs a local check, not a settlement.
      if (!(await verifyBatch(proof))) throw new Error("the proof did not verify locally");

      const p = witness.publicInputs;

      // And check the statement matches the one `settleBatch` will assemble.
      //
      // A proof verifies against the public inputs it was *made* with; the contract rebuilds
      // several of them from its own state — the `ordersRoot` it sealed, the `pricesRoot` and
      // `deferMask` the committer fixed, its immutable `quoteAssetId` — and verifies against
      // those. A disagreement is a valid proof of a different statement, and the verifier says
      // only `SumcheckFailed()`: a word that names nothing and costs a settlement's gas.
      //
      // So the comparison is against the chain, not against the witness that produced the
      // proof. Comparing a witness to itself always agrees, which is worth saying because the
      // first version of this check did exactly that.
      const onChainWindow = (await r.read.readContract({
        address: pool,
        abi: poolAbi,
        functionName: "windows",
        args: [chainWindowId],
      })) as unknown as readonly [`0x${string}`, ...unknown[]];
      const asContractSees: [string, bigint, bigint][] = [
        ["orders_root", p.ordersRoot, BigInt(onChainWindow[0])],
        ["prices_root", p.pricesRoot, BigInt(committed.pricesRoot)],
        ["defer_mask", p.deferMask, committed.deferMask],
        ["quote_asset_id", p.quoteAssetId, quoteAssetId],
      ];
      for (const [name, proved, onChain] of asContractSees) {
        if (proved !== onChain) {
          throw new Error(
            `${name} disagrees with the chain: the proof used ${proved}, settleBatch will use ${onChain}`,
          );
        }
      }

      const hash = await r.send({
        address: pool,
        abi: poolAbi,
        functionName: "settleBatch",
        args: [
          {
            windowId: chainWindowId,
            subBatchIndex: 0,
            proof: toHex(proof.proof),
            oldRoot,
            outputsSubtreeRoot: toHex(p.outputsSubtreeRoot, { size: 32 }),
            outputsSubtreeDepth: 5,
            nullifiers: p.nullifiers.map((n) => toHex(n, { size: 32 })),
            outputCommitments: outputs.map((c) => toHex(c, { size: 32 })),
            receiptsRoot: toHex(p.receiptsRoot, { size: 32 }),
            tapeLeaf: toHex(p.tapeLeaf, { size: 32 }),
            filledOrders: fills.filter((f) => BigInt(f.filled_raw) > 0n).length,
          },
        ],
        // Verification alone is ~3M gas and an estimate came in short before, reverting the
        // inner call while leaving the outer frame enough to revert — which reads as a logic
        // failure rather than a gas one.
        gas: 8_000_000n,
      });

      await sql`update arclite.windows set settled_tx = ${hash}, proved_at = now() where id = ${window.id}::bigint`;
      result.settled += 1;
    } catch (error) {
      // Unwrap the cause chain. Node's `fetch` reports "fetch failed" and puts the actual
      // failure — DNS, TLS, a refused connection, the host — in `cause`, so recording only the
      // message loses everything that identifies what could not be reached. The prover fetches
      // the SRS at cold start, so "fetch failed" alone does not even say whether the venue could
      // not reach the chain or could not reach barretenberg's.
      const chain: string[] = [];
      for (let e: unknown = error, depth = 0; e && depth < 4; depth++) {
        const err = e as { message?: string; code?: string; cause?: unknown };
        const part = [err.message, err.code].filter(Boolean).join(" ");
        if (part && !chain.includes(part)) chain.push(part);
        e = err.cause;
      }
      const message = chain.join(" <- ").slice(0, 500);

      // Some failures are not worth a second attempt, let alone ten.
      //
      // A window whose book cannot satisfy the circuit's constraints will fail identically every
      // time: the inputs are frozen at seal, the committed prices never change, and the prover
      // is deterministic. Retrying is not resilience, it is ten minutes of gas and ten minutes
      // during which the venue looks like it might still recover.
      //
      // `assert_max_bit_size` is the signature of exactly one thing here — a quantity that went
      // negative and wrapped, which is what an order costing more than its note produces. A buy
      // of 1 NVDA against a $1 note did this: it sealed, priced and matched, then failed to
      // prove ten times over. The client now rejects that order up front; this makes sure the
      // venue gives up immediately on anything that slips past.
      const permanent = /assert_max_bit_size|Circuit execution failed|PUBLIC_INPUT_COUNT/i.test(
        message,
      );
      if (permanent) {
        await sql`select arclite.fail_window_now(${window.id}::bigint, ${message})`;
        result.errors.push(`settle ${window.seq}: unprovable, failed immediately — ${message}`);
      } else {
        await sql`select arclite.record_chain_error(${window.id}::bigint, ${message})`;
        result.errors.push(`settle ${window.seq}: ${message}`);
      }
    }
  }

  return result;
}
