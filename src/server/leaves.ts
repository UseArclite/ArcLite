import type { Address, PublicClient } from "viem";

/**
 * Reconstructing the pool's commitment set from chain logs.
 *
 * Three things put a leaf in the tree, and only one of them is a `LeafInserted`:
 *
 *   * **A deposit** inserts one leaf and emits `LeafInserted`.
 *   * **A settlement** splices 32 at once and emits `OutputsPublished`, carrying the whole
 *     subtree and the index it landed at. Emitting 32 separate events would be gas for no extra
 *     information.
 *   * **Alignment** skips positions so a subtree can occupy a span-aligned slot. Those positions
 *     hold the zero leaf and emit nothing at all, because nothing was inserted —
 *     `test_SkippingEqualsInsertingZeroLeaves` is what proves skipping and inserting zeros build
 *     the same tree.
 *
 * Treating an unaccounted position as an error — which the first version did — makes the whole
 * set unreadable the moment a settlement happens. Treating it as a zero leaf is what the contract
 * actually did.
 *
 * The result is positional: `leaves[i]` is the leaf at index `i`, because a client rebuilds the
 * tree from this array and a misplaced entry produces a root the pool has never held.
 */

const LEAF_INSERTED = {
  type: "event",
  name: "LeafInserted",
  inputs: [
    { name: "index", type: "uint256", indexed: true },
    { name: "commitment", type: "bytes32", indexed: true },
    { name: "root", type: "bytes32" },
  ],
} as const;

const OUTPUTS_PUBLISHED = {
  type: "event",
  name: "OutputsPublished",
  inputs: [
    { name: "windowId", type: "uint64", indexed: true },
    { name: "subBatchIndex", type: "uint8" },
    { name: "startIndex", type: "uint32" },
    { name: "subtreeRoot", type: "bytes32" },
    { name: "commitments", type: "bytes32[]" },
  ],
} as const;

export async function readLeafSet(
  client: PublicClient,
  pool: Address,
  fromBlock: bigint,
): Promise<bigint[]> {
  const [inserted, spliced] = await Promise.all([
    client.getLogs({ address: pool, event: LEAF_INSERTED, fromBlock, toBlock: "latest" }),
    client.getLogs({ address: pool, event: OUTPUTS_PUBLISHED, fromBlock, toBlock: "latest" }),
  ]);

  const leaves: (bigint | undefined)[] = [];
  for (const log of inserted) {
    leaves[Number(log.args.index)] = BigInt(log.args.commitment!);
  }
  for (const log of spliced) {
    const start = Number(log.args.startIndex);
    for (const [i, c] of (log.args.commitments ?? []).entries()) {
      leaves[start + i] = BigInt(c);
    }
  }

  // Positions nothing claimed are the ones alignment skipped: zero leaves, exactly as the
  // contract's frontier holds them.
  return Array.from({ length: leaves.length }, (_, i) => leaves[i] ?? 0n);
}
