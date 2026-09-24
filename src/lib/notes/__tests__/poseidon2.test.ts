import { describe, expect, test } from "bun:test";
import { hash, hash2, permute, P } from "../poseidon2";

/**
 * The third implementation of the same hash.
 *
 * Noir computes it in-circuit, `Poseidon2.sol` on-chain, and this in the browser. All three must
 * agree exactly: a note the client computes has to be the note the circuit proves and the
 * contract stores. A divergence here would show up as "your deposit vanished", not as an error.
 *
 * Expected values come from `circuits/vectors` and `circuits/tree`, executed by nargo against
 * the same barretenberg blackbox the circuits use — independent ground truth, and the identical
 * constants the Solidity tests assert against.
 */

describe("permutation", () => {
  test("permute([0,0,0,0]) matches Noir", () => {
    expect(permute([0n, 0n, 0n, 0n])[0]).toBe(
      0x18dfb8dc9b82229cff974efefc8df78b1ce96d9d844236b496785c698bc6732en,
    );
  });

  test("permute([1,2,3,4]) matches Noir, first and last lane", () => {
    const r = permute([1n, 2n, 3n, 4n]);
    expect(r[0]).toBe(0x224785a48a72c75e2cbb698143e71d5d41bd89a2b9a7185871e39a54ce5785b1n);
    expect(r[3]).toBe(0x16c877b5b9c04d873218804ccbf65d0eeb12db447f66c9ca26fec380055df7e9n);
  });
});

describe("sponge", () => {
  test("hash([1])", () => {
    expect(hash([1n])).toBe(0x168758332d5b3e2d13be8048c8011b454590e06c44bce7f702f09103eef5a373n);
  });

  test("hash([1,2])", () => {
    expect(hash2(1n, 2n)).toBe(0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383n);
  });

  /**
   * The boundary case. Three inputs exactly fill RATE, so Noir skips the final permutation. A
   * port that permutes unconditionally agrees on 1, 2, 4 and 5 inputs and silently disagrees
   * here — which means every 3-element hash, and so every 3-field commitment, would be wrong.
   */
  test("hash([1,2,3]) — exact chunk, no trailing permutation", () => {
    expect(hash([1n, 2n, 3n])).toBe(
      0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8n,
    );
  });

  test("hash([1,2,3,4]) — spans two chunks", () => {
    expect(hash([1n, 2n, 3n, 4n])).toBe(
      0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9n,
    );
  });

  test("hash([0,0])", () => {
    expect(hash2(0n, 0n)).toBe(0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1n);
  });
});

describe("tree agreement", () => {
  /**
   * The zero ladder the contract derives in its constructor. If the client disagreed, every
   * Merkle path it built for a sparse branch would be wrong.
   */
  test("empty depth-24 root matches the contract", () => {
    let zero = 0n;
    for (let i = 0; i < 24; i++) zero = hash2(zero, zero);
    expect(zero).toBe(0x0e1a6b7d63a6e5a9e54e8f391dd4e9d49cdfedcbc87f02cd34d4641d2eb30491n);
  });

  test("root after one leaf matches the contract", () => {
    let zero = 0n;
    let node = 1n;
    for (let i = 0; i < 24; i++) {
      node = hash2(node, zero);
      zero = hash2(zero, zero);
    }
    expect(node).toBe(0x0f1163e4a6c699933f342fee0d8c188626c7999bb17ad8b72f27836540cd840bn);
  });
});

describe("field discipline", () => {
  test("output is always reduced mod P", () => {
    for (let i = 0n; i < 20n; i++) {
      const h = hash2(i, i * 7n + 3n);
      expect(h).toBeLessThan(P);
      expect(h).toBeGreaterThanOrEqual(0n);
    }
  });

  test("inputs above the modulus reduce rather than corrupt", () => {
    // A caller passing an unreduced value must not get a different answer than the reduced one.
    expect(hash2(P + 5n, 2n)).toBe(hash2(5n, 2n));
  });

  test("distinct inputs give distinct outputs", () => {
    const seen = new Set<bigint>();
    for (let i = 0n; i < 50n; i++) seen.add(hash2(i, 1n));
    expect(seen.size).toBe(50);
  });
});
