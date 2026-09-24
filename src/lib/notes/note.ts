import { hash, hash2, P } from "./poseidon2";

/**
 * Shielded note construction — the client half of what the circuits prove.
 *
 * Every function here mirrors `circuits/lib/arclite/src/note.nr` exactly. They are kept as small
 * named functions rather than inlined so a drift between client and circuit is a one-line diff
 * rather than a hunt: if these disagree, the browser computes a commitment the circuit will not
 * prove and the contract will not recognise, which presents to the user as a deposit that
 * vanished.
 */

/** Tree depth. Must equal `CommitmentTree.DEPTH` and `arclite::merkle::DEPTH`. */
export const DEPTH = 24;

export interface Note {
  assetId: bigint;
  units: bigint;
  /** poseidon2([pk.x, pk.y, npk]) — binds the note to a spending key. */
  owner: bigint;
  /** Per-note nullifier secret. Reveals this note's nullifier and nothing about any other. */
  nsecret: bigint;
}

export function ownerOf(pkX: bigint, pkY: bigint, npk: bigint): bigint {
  return hash([pkX, pkY, npk]);
}

export function commitment(n: Note): bigint {
  // nsecret is hashed before being committed, so the commitment never exposes it directly.
  return hash([n.assetId, n.units, n.owner, hash([n.nsecret])]);
}

/**
 * Bound to the leaf index as well as the note, so two identical notes at different positions
 * produce different nullifiers and neither can shadow the other.
 */
export function nullifier(commitment_: bigint, nsecret: bigint, leafIndex: bigint): bigint {
  return hash([commitment_, nsecret, leafIndex]);
}

/**
 * Deterministic note randomness.
 *
 * `rho` and `nsecret` derive from the epoch viewing key and a counter, so a client can
 * regenerate every note it owns from its own key alone. That is what makes recovery independent
 * of any server, indexer, or on-chain ciphertext — none of them are load-bearing for funds.
 */
export function deriveRho(ivkEpoch: bigint, counter: bigint): bigint {
  return hash2(ivkEpoch, counter);
}

export function deriveNsecret(ivkEpoch: bigint, rho: bigint): bigint {
  return hash([ivkEpoch, rho, 1n]);
}

/** Per-epoch viewing key. Handing one to an auditor discloses exactly that epoch. */
export function ivkForEpoch(ivk: bigint, epoch: bigint): bigint {
  return hash2(ivk, epoch);
}

/**
 * A 1-byte tag published alongside each note so a client can ask the indexer for candidates
 * rather than trial-decrypting every commitment ever made. Cuts the work from thousands of
 * attempts to a handful, which is the difference between an instant balance and a spinner.
 */
export function viewTag(ivkEpoch: bigint, counter: bigint): number {
  return Number(hash([ivkEpoch, counter, 2n]) & 0xffn);
}

/** Zero-subtree ladder, matching `CommitmentTree`'s constructor. */
export function zeroLadder(depth: number = DEPTH): bigint[] {
  const zeros: bigint[] = [];
  let z = 0n;
  for (let i = 0; i < depth; i++) {
    zeros.push(z);
    z = hash2(z, z);
  }
  return zeros;
}

/**
 * Recompute a root from a leaf and its path.
 *
 * Ordering must match `CommitmentTree._insert` and `arclite::merkle::compute_root`: the node is
 * the LEFT child when the index bit is 0. Reversing it yields roots the contract can never reach.
 */
export function computeRoot(leaf: bigint, path: readonly bigint[], index: bigint): bigint {
  let node = leaf;
  let idx = index;
  for (let i = 0; i < path.length; i++) {
    node = (idx & 1n) === 0n ? hash2(node, path[i]) : hash2(path[i], node);
    idx >>= 1n;
  }
  return node;
}

/**
 * An append-only incremental tree, mirroring the contract so the client can build paths without
 * trusting a server's answer. Only the frontier is kept, so memory is O(depth) not O(leaves).
 */
export class IncrementalTree {
  private readonly zeros: bigint[];
  private readonly frontier: bigint[];
  private readonly leaves: bigint[] = [];

  constructor(readonly depth: number = DEPTH) {
    this.zeros = zeroLadder(depth);
    this.frontier = [...this.zeros];
  }

  get size(): number {
    return this.leaves.length;
  }

  insert(leaf: bigint): number {
    const index = this.leaves.length;
    this.leaves.push(leaf);
    let idx = index;
    let node = leaf;
    for (let level = 0; level < this.depth; level++) {
      if ((idx & 1) === 0) {
        this.frontier[level] = node;
        node = hash2(node, this.zeros[level]);
      } else {
        node = hash2(this.frontier[level], node);
      }
      idx >>= 1;
    }
    return index;
  }

  /** Authentication path for a leaf, computed from the full leaf set. */
  path(index: number): bigint[] {
    const path: bigint[] = [];
    let level = this.leaves.slice();
    let idx = index;
    for (let d = 0; d < this.depth; d++) {
      const sibling = idx ^ 1;
      path.push(sibling < level.length ? level[sibling] : this.zeros[d]);
      const next: bigint[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : this.zeros[d];
        next.push(hash2(left, right));
      }
      level = next;
      idx >>= 1;
    }
    return path;
  }

  root(): bigint {
    if (this.leaves.length === 0) {
      let z = 0n;
      for (let i = 0; i < this.depth; i++) z = hash2(z, z);
      return z;
    }
    return computeRoot(this.leaves[0], this.path(0), 0n);
  }
}

/** Reduce an arbitrary byte string into the field, for deriving keys from a signature. */
export function toField(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v % P;
}
