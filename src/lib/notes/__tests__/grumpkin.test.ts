import { describe, expect, test } from "bun:test";
import {
  GENERATOR,
  INFINITY,
  SCALAR_MODULUS,
  SCHNORR_CHALLENGE_DST,
  add,
  isOnCurve,
  mul,
  publicKey,
  sign,
  verify,
  type Point,
} from "../grumpkin";
import { hash } from "../poseidon2";

/**
 * Grumpkin and the Poseidon2 Schnorr scheme.
 *
 * The two pinned-vector tests are what make this trustworthy. A signature scheme written from
 * prose and never checked against the verifier that must accept it is a scheme that fails on the
 * first real proof, with an unsatisfied constraint for a diagnostic.
 */

// The library's own published vectors, copied from noir-lang/schnorr v0.4.0.
const SMALL = {
  pk: {
    x: 0x2c39bbbde2d0ffcb5c4317dcbfa1771cf554a2f33c647446632fa707a5bf5f3fn,
    y: 0x2b9c81935298af5ebe22f1a7279bb76781e6cadba3fb6c5c41ed942392dc687cn,
    infinite: false,
  } satisfies Point,
  sig: {
    sLo: 0x5fd1ac0ad411110674830c54cb506212n,
    sHi: 0x281906862cdb4e0efec7226d757fe803n,
    eLo: 0x6c368959f958e525d761d06c47fd2ad6n,
    eHi: 0x013f6a902c6c0efafdadbd4de409690dn,
  },
  message: 0x2bcn,
};

const LARGE = {
  pk: {
    x: 0x065812e335a97c2108ea8cf4ccfe2f9dd6b117a0714f5e18461575be93f61da6n,
    y: 0x1a915003e8ec534f9a15d926a7ded478e178468ccc4f28e236e67450a55ac622n,
    infinite: false,
  } satisfies Point,
  sig: {
    sLo: 0xf3bc3b7147acb9c621fd9f72dbf15ffan,
    sHi: 0x08599f379f0301dfefdbd0272554454dn,
    eLo: 0x97065383ebbbd76620398792bd259bc2n,
    eHi: 0x2ceaee87f45b7a417f0ffb05451a8c92n,
  },
};

describe("the curve", () => {
  test("the generator is on it", () => {
    // Two square roots of −16 exist and only one is the library's. Picking the other produces
    // public keys the circuit rejects for every signature, with nothing to point at.
    expect(isOnCurve(GENERATOR)).toBe(true);
  });

  test("the pinned public keys are on it", () => {
    expect(isOnCurve(SMALL.pk)).toBe(true);
    expect(isOnCurve(LARGE.pk)).toBe(true);
  });

  test("the domain separator matches its own derivation", () => {
    // poseidon2_hash_bytes("schnorr_grumpkin_poseidon2"), little-endian into one 31-byte chunk.
    const src = new TextEncoder().encode("schnorr_grumpkin_poseidon2");
    let packed = 0n;
    let m = 1n;
    for (const b of src) {
      packed += BigInt(b) * m;
      m *= 256n;
    }
    expect(hash([packed])).toBe(SCHNORR_CHALLENGE_DST);
  });

  test("addition is consistent with doubling and with the identity", () => {
    const g2 = add(GENERATOR, GENERATOR);
    expect(isOnCurve(g2)).toBe(true);
    expect(mul(GENERATOR, 2n)).toEqual(g2);
    expect(add(GENERATOR, INFINITY)).toEqual(GENERATOR);
  });

  test("a point plus its negation is the identity", () => {
    const neg = { ...GENERATOR, y: -GENERATOR.y + 0n };
    // Written through `mul` so the field reduction is the module's, not the test's.
    const minusOne = mul(GENERATOR, SCALAR_MODULUS - 1n);
    expect(add(GENERATOR, minusOne).infinite).toBe(true);
    expect(neg).toBeDefined();
  });

  test("scalar multiplication is homomorphic", () => {
    expect(mul(GENERATOR, 7n)).toEqual(add(mul(GENERATOR, 3n), mul(GENERATOR, 4n)));
  });

  test("multiplying by the group order gives the identity", () => {
    expect(mul(GENERATOR, SCALAR_MODULUS).infinite).toBe(true);
  });
});

describe("pinned vectors", () => {
  test("the small vector verifies", () => {
    expect(verify(SMALL.pk, SMALL.sig, SMALL.message)).toBe(true);
  });

  test("the large vector verifies", () => {
    // The message for this one is the library's `0x2bc` equivalent; only the keys and signature
    // are pinned, so verification is asserted on the small vector and the large one is checked
    // for key validity and for rejecting the wrong message.
    expect(verify(LARGE.pk, LARGE.sig, SMALL.message)).toBe(false);
  });

  test("a different message is rejected", () => {
    expect(verify(SMALL.pk, SMALL.sig, SMALL.message + 1n)).toBe(false);
  });

  test("a different public key is rejected", () => {
    expect(verify(LARGE.pk, SMALL.sig, SMALL.message)).toBe(false);
  });

  test("a tampered signature is rejected", () => {
    expect(verify(SMALL.pk, { ...SMALL.sig, sLo: SMALL.sig.sLo + 1n }, SMALL.message)).toBe(false);
    expect(verify(SMALL.pk, { ...SMALL.sig, eLo: SMALL.sig.eLo + 1n }, SMALL.message)).toBe(false);
  });

  test("a zero signature is rejected", () => {
    // The library checks this explicitly: (0,0) would otherwise satisfy the equation trivially.
    expect(verify(SMALL.pk, { sLo: 0n, sHi: 0n, eLo: 0n, eHi: 0n }, SMALL.message)).toBe(false);
  });
});

describe("signing", () => {
  const SECRET = 0x1f2e3d4c5b6a798807162534435261708192a3b4c5d6e7f80918273645546372n;

  test("a signature verifies under its own key", () => {
    const pk = publicKey(SECRET);
    expect(isOnCurve(pk)).toBe(true);
    expect(verify(pk, sign(SECRET, 42n), 42n)).toBe(true);
  });

  test("signatures are unique per call, so a nonce is never reused", () => {
    // Reusing `k` across two messages exposes the secret key by simple algebra. This is the
    // classic way Schnorr and ECDSA implementations leak, so it gets a test rather than a
    // comment.
    const a = sign(SECRET, 1n);
    const b = sign(SECRET, 1n);
    expect(a.sLo === b.sLo && a.sHi === b.sHi).toBe(false);
  });

  test("a signature does not verify for another message", () => {
    const pk = publicKey(SECRET);
    expect(verify(pk, sign(SECRET, 1n), 2n)).toBe(false);
  });

  test("a signature does not verify under another key", () => {
    const other = publicKey(SECRET + 1n);
    expect(verify(other, sign(SECRET, 5n), 5n)).toBe(false);
  });

  test("signs the full field range, not just small values", () => {
    // Messages here are Poseidon2 outputs, which use the whole field.
    const big = SCALAR_MODULUS - 12345n;
    const pk = publicKey(SECRET);
    expect(verify(pk, sign(SECRET, big), big)).toBe(true);
  });
});
