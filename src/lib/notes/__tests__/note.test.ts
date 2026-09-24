import { describe, expect, test } from "bun:test";
import {
  commitment,
  computeRoot,
  DEPTH,
  deriveNsecret,
  deriveRho,
  IncrementalTree,
  ivkForEpoch,
  nullifier,
  ownerOf,
  viewTag,
  zeroLadder,
} from "../note";

/**
 * The client must build exactly the notes and roots the circuit proves and the contract stores.
 *
 * The fixture below is the same one `circuits/unshield` uses in its own tests, and the expected
 * root and nullifier are the values `circuits/fixture` emitted for the real proof that bb
 * verified. So these assert agreement with the circuit, not merely internal consistency.
 */

const ASSET_ID = 1n;
const UNITS = 100n;
const NPK = 7n;
const PK_X = 11n;
const PK_Y = 13n;
const NSECRET = 17n;

// From `nargo execute --package fixture`, and the public inputs of the proof bb verified.
const EXPECTED_ROOT = 0x04dfb911529b795d17a1f74fdc6345251508901326a359c3a8fd00abd2f44c27n;
const EXPECTED_NULLIFIER = 0x24926ef182fe58fb14076a863a6ad752093417ab95eb1cf46cb015e0e6c17690n;
const EXPECTED_COMMITMENT = 0x01b2d87d6f4f966f6da54458e6a259c6463cc714df5ef6baa2edc5794ab6b087n;

function fixtureNote() {
  return {
    assetId: ASSET_ID,
    units: UNITS,
    owner: ownerOf(PK_X, PK_Y, NPK),
    nsecret: NSECRET,
  };
}

describe("note construction matches the circuit", () => {
  test("commitment", () => {
    expect(commitment(fixtureNote())).toBe(EXPECTED_COMMITMENT);
  });

  test("nullifier", () => {
    expect(nullifier(EXPECTED_COMMITMENT, NSECRET, 0n)).toBe(EXPECTED_NULLIFIER);
  });

  /**
   * The root the proof was built against. If this drifted, the client would build proofs the
   * contract rejects as an unknown root.
   */
  test("root of a single note in an empty tree", () => {
    expect(computeRoot(EXPECTED_COMMITMENT, zeroLadder(), 0n)).toBe(EXPECTED_ROOT);
  });

  test("the owner binding actually binds", () => {
    expect(ownerOf(PK_X, PK_Y, NPK)).not.toBe(ownerOf(PK_X + 1n, PK_Y, NPK));
    expect(ownerOf(PK_X, PK_Y, NPK)).not.toBe(ownerOf(PK_X, PK_Y, NPK + 1n));
  });

  /** Same note, different position: the nullifiers must differ or one could shadow the other. */
  test("nullifier is bound to the leaf index", () => {
    const c = commitment(fixtureNote());
    expect(nullifier(c, NSECRET, 0n)).not.toBe(nullifier(c, NSECRET, 1n));
  });
});

describe("deterministic recovery", () => {
  /**
   * The property that makes funds recoverable with no server, no indexer and no on-chain
   * ciphertext: a client regenerates its own notes from its key and a counter.
   */
  test("rho and nsecret are a pure function of the epoch key and counter", () => {
    const ivk = ivkForEpoch(0xabcdefn, 42n);
    expect(deriveRho(ivk, 3n)).toBe(deriveRho(ivk, 3n));
    expect(deriveNsecret(ivk, deriveRho(ivk, 3n))).toBe(deriveNsecret(ivk, deriveRho(ivk, 3n)));
  });

  test("different counters give different notes", () => {
    const ivk = ivkForEpoch(0xabcdefn, 42n);
    expect(deriveRho(ivk, 1n)).not.toBe(deriveRho(ivk, 2n));
  });

  /** Epoch scoping is what makes an auditor grant disclose one epoch and not the rest. */
  test("a different epoch yields an unrelated key", () => {
    expect(ivkForEpoch(0xabcdefn, 1n)).not.toBe(ivkForEpoch(0xabcdefn, 2n));
  });

  test("view tags are one byte and spread across the range", () => {
    const ivk = ivkForEpoch(0xabcdefn, 42n);
    const tags = new Set<number>();
    for (let i = 0n; i < 64n; i++) {
      const t = viewTag(ivk, i);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(256);
      tags.add(t);
    }
    // A degenerate tag function would collapse to a handful of values and destroy the filter's
    // usefulness without breaking anything visibly.
    expect(tags.size).toBeGreaterThan(40);
  });
});

describe("incremental tree agrees with the contract", () => {
  test("empty root is the zero ladder", () => {
    const tree = new IncrementalTree();
    expect(tree.root()).toBe(0x0e1a6b7d63a6e5a9e54e8f391dd4e9d49cdfedcbc87f02cd34d4641d2eb30491n);
  });

  test("one leaf reproduces the contract's root", () => {
    const tree = new IncrementalTree();
    tree.insert(1n);
    expect(tree.root()).toBe(0x0f1163e4a6c699933f342fee0d8c188626c7999bb17ad8b72f27836540cd840bn);
  });

  test("four leaves reproduce the contract's root", () => {
    const tree = new IncrementalTree();
    for (const l of [11n, 22n, 33n, 44n]) tree.insert(l);
    expect(tree.root()).toBe(0x2f4adc76aa848323a416713836219d439717ee67fb141abe08daf724827909c5n);
  });

  /**
   * Every leaf's path must reconstruct the same root — including right children, where the
   * sibling ordering reverses and a swapped conditional would pass only for index 0.
   */
  test("every leaf's path reconstructs the root", () => {
    const tree = new IncrementalTree();
    const leaves = [11n, 22n, 33n, 44n, 55n];
    leaves.forEach((l) => tree.insert(l));
    const root = tree.root();
    leaves.forEach((leaf, i) => {
      expect(computeRoot(leaf, tree.path(i), BigInt(i))).toBe(root);
    });
  });

  test("a wrong path does not reconstruct the root", () => {
    const tree = new IncrementalTree();
    [11n, 22n, 33n, 44n].forEach((l) => tree.insert(l));
    const bad = tree.path(0);
    bad[0] = bad[0] + 1n;
    expect(computeRoot(11n, bad, 0n)).not.toBe(tree.root());
  });

  test("path length matches the tree depth", () => {
    const tree = new IncrementalTree();
    tree.insert(1n);
    expect(tree.path(0).length).toBe(DEPTH);
  });
});
