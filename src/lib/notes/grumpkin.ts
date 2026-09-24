import { hash } from "./poseidon2";
import { P } from "./poseidon2";

/**
 * Grumpkin, and the Poseidon2 Schnorr scheme Noir's `schnorr` library verifies.
 *
 * This exists so a trader can *authorise* a spend, not merely reveal its secret. Until now
 * spending a note needed only the `owner` preimage and `nsecret`, both of which the settler
 * learns from a revealed order — so it could replay that note into a later batch. A signature it
 * cannot forge is the difference between "the operator is trusted not to" and "the operator
 * cannot".
 *
 * ## The curve
 *
 * Grumpkin is `y² = x³ − 17` over BN254's *scalar* field, which is Noir's `Field`. Its own scalar
 * field is BN254's base field — the two curves' fields swap places, which is what makes it cheap
 * to do curve arithmetic inside a BN254 circuit: 4,419 gates per verification, against 42,891 for
 * secp256k1 ECDSA. That measurement is why this is Schnorr rather than the Ethereum key a wallet
 * already holds.
 *
 * ## The scheme
 *
 *   e = Poseidon2([DST, R.x, pk.x, pk.y, message])
 *   verify: R = s·G + e·pk, then recompute e and compare
 *   sign:   k random, R = k·G, s = k − e·sk  (mod n)
 *
 * Everything is pinned against the library's own published test vectors below. A signature scheme
 * implemented from prose and never checked against the verifier is a signature scheme that fails
 * on the first real proof.
 */

/** Grumpkin's base field: BN254's scalar field, the same modulus Poseidon2 works over. */
export const FIELD_MODULUS = P;

/** Grumpkin's scalar field: BN254's base field. Signature scalars live here. */
export const SCALAR_MODULUS =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

/** `poseidon2_hash_bytes("schnorr_grumpkin_poseidon2")`, pinned by the library. */
export const SCHNORR_CHALLENGE_DST =
  0x024c76938ed06b8ec1d9094b1013d190baa4011372f0604643bda812a63b832en;

const TWO_POW_128 = 1n << 128n;

export interface Point {
  x: bigint;
  y: bigint;
  /** Grumpkin has no affine point at infinity, so it is carried as a flag. */
  infinite: boolean;
}

export const INFINITY: Point = { x: 0n, y: 0n, infinite: true };

const mod = (a: bigint, m: bigint = FIELD_MODULUS) => ((a % m) + m) % m;

function invert(a: bigint, m: bigint = FIELD_MODULUS): bigint {
  // Extended Euclid rather than Fermat: one inversion per point addition, and this is ~20x
  // cheaper than exponentiating by m-2.
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("value is not invertible");
  return mod(old_s, m);
}

export function isOnCurve(p: Point): boolean {
  if (p.infinite) return true;
  return mod(p.y * p.y) === mod(p.x * p.x * p.x - 17n);
}

export function add(a: Point, b: Point): Point {
  if (a.infinite) return b;
  if (b.infinite) return a;
  if (a.x === b.x) {
    // Same x: either a doubling, or two points that cancel.
    if (mod(a.y + b.y) === 0n) return INFINITY;
    const lambda = mod(3n * a.x * a.x * invert(2n * a.y));
    const x = mod(lambda * lambda - 2n * a.x);
    return { x, y: mod(lambda * (a.x - x) - a.y), infinite: false };
  }
  const lambda = mod((b.y - a.y) * invert(b.x - a.x));
  const x = mod(lambda * lambda - a.x - b.x);
  return { x, y: mod(lambda * (a.x - x) - a.y), infinite: false };
}

export function mul(p: Point, scalar: bigint): Point {
  let k = mod(scalar, SCALAR_MODULUS);
  let acc = INFINITY;
  let base = p;
  // Double-and-add. Not constant time, and it does not need to be: every scalar multiplied here
  // is either a public key derivation the signer already knows or a verification of public
  // values. The signing nonce is the one secret, and it is used once and discarded.
  while (k > 0n) {
    if (k & 1n) acc = add(acc, base);
    base = add(base, base);
    k >>= 1n;
  }
  return acc;
}

/**
 * The generator `EmbeddedCurvePoint::generator()` returns.
 *
 * x = 1, and y is the square root of −16. Two roots exist; the one below is the library's, and
 * `generatorMatchesCircuit` in the tests is what proves this is the right one rather than its
 * negation — picking the wrong root produces public keys the circuit rejects for every signature.
 */
export const GENERATOR: Point = {
  x: 1n,
  y: 0x0000000000000000000000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272cn,
  infinite: false,
};

/** e = Poseidon2([DST, R.x, pk.x, pk.y, message]) */
export function challenge(rx: bigint, pk: Point, message: bigint): bigint {
  return hash([SCHNORR_CHALLENGE_DST, rx, pk.x, pk.y, message]);
}

export interface Signature {
  /** `s`, split at 2^128 the way `EmbeddedCurveScalar` carries it. */
  sLo: bigint;
  sHi: bigint;
  eLo: bigint;
  eHi: bigint;
}

const split = (v: bigint) => ({ lo: v % TWO_POW_128, hi: v / TWO_POW_128 });
const join = (lo: bigint, hi: bigint) => lo + hi * TWO_POW_128;

export function publicKey(secret: bigint): Point {
  return mul(GENERATOR, secret);
}

/**
 * Verify, exactly as the circuit does.
 *
 * Kept so a signature can be checked before it is handed to a prover: a bad signature caught here
 * is a clear error, while the same signature caught in-circuit is an unsatisfied constraint.
 */
export function verify(pk: Point, sig: Signature, message: bigint): boolean {
  if (!isOnCurve(pk)) return false;
  const s = join(sig.sLo, sig.sHi);
  const e = join(sig.eLo, sig.eHi);
  if (s === 0n || e === 0n) return false;

  const r = add(mul(GENERATOR, s), mul(pk, e));
  if (r.infinite) return false;
  return challenge(r.x, pk, message) === e;
}

/**
 * Sign a message with a Grumpkin secret key.
 *
 * `k` comes from the CSPRNG and is discarded. Reusing it across two messages would expose the
 * secret key by simple algebra, which is the classic way Schnorr and ECDSA implementations leak.
 */
export function sign(secret: bigint, message: bigint): Signature {
  const pk = publicKey(secret);
  for (let attempt = 0; attempt < 64; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let k = 0n;
    for (const b of bytes) k = (k << 8n) | BigInt(b);
    k = mod(k, SCALAR_MODULUS);
    if (k === 0n) continue;

    const r = mul(GENERATOR, k);
    if (r.infinite) continue;

    const e = challenge(r.x, pk, message);
    // s = k − e·sk, in the *scalar* field. Reducing in the wrong field here produces signatures
    // that verify locally and fail in-circuit, because the circuit does the scalar arithmetic on
    // the curve rather than in Field.
    const s = mod(k - mod(e, SCALAR_MODULUS) * mod(secret, SCALAR_MODULUS), SCALAR_MODULUS);
    if (s === 0n || e === 0n) continue;

    const sp = split(s);
    const ep = split(e);
    return { sLo: sp.lo, sHi: sp.hi, eLo: ep.lo, eHi: ep.hi };
  }
  throw new Error("could not produce a signature after 64 attempts");
}
