import { hash2 } from "./poseidon2";

/**
 * The committed price table, mirroring `circuits/lib/arclite/src/price.nr` and
 * `contracts/src/PriceCommitter.sol`.
 *
 * Three implementations of one encoding. The contract is the authority — it derives the table
 * on-chain, after the book is sealed — the circuit proves the crossing used it, and this builds
 * the witness. A drift in any of the three produces a `pricesRoot` the other two cannot reach,
 * which surfaces as a proof that will not generate rather than as a wrong number.
 */

/** Matches `PriceCommitter.MAX_ASSETS` and `arclite::price::MAX_ASSETS`. */
export const MAX_ASSETS = 32;

/** `keccak256("arclite.prices.v1") % P`. */
export const DOMAIN_PRICES = 0x25e89cc1ebc10af8e231260a54693ca2358ec7f0b4e62799f0fba59a95ab35a6n;

export const FLAG_STALE = 0x01;
export const FLAG_PAUSED = 0x02;
export const FLAG_EVENT = 0x04;
export const FLAG_NAV_AGED = 0x08;
export const FLAG_MULTIPLIER_PENDING = 0x10;
export const FLAG_UNREADABLE = 0x20;

export interface PriceEntry {
  assetId: bigint;
  kind: bigint;
  flags: bigint;
  updatedAt: bigint;
  roundId: bigint;
  /** USD per whole token, 1e18-scaled: the feed answer already times `uiMultiplier`. */
  refValueE18: bigint;
  uiMultiplierE18: bigint;
}

export const emptyEntry = (): PriceEntry => ({
  assetId: 0n,
  kind: 0n,
  flags: 0n,
  updatedAt: 0n,
  roundId: 0n,
  refValueE18: 0n,
  uiMultiplierE18: 0n,
});

/**
 * The two words the contract hashes, packed exactly as `PriceCommitter._pack` packs them.
 *
 * The bounds are checked rather than assumed. `hi` is `refValue | multiplier << 128`; an
 * oversized multiplier pushes it past the BN254 modulus, where the circuit's field arithmetic
 * would wrap and two different tables could hash to the same root.
 */
export function packEntry(e: PriceEntry): [bigint, bigint] {
  const bound = (name: string, value: bigint, bits: number) => {
    if (value < 0n || value >= 1n << BigInt(bits)) {
      throw new Error(`${name} does not fit in ${bits} bits: ${value}`);
    }
  };
  bound("assetId", e.assetId, 16);
  bound("kind", e.kind, 8);
  bound("flags", e.flags, 8);
  bound("updatedAt", e.updatedAt, 64);
  bound("roundId", e.roundId, 80);
  bound("refValueE18", e.refValueE18, 128);
  // 126, matching the circuit, so `hi` stays below 2^254.
  bound("uiMultiplierE18", e.uiMultiplierE18, 126);

  const lo =
    e.assetId | (e.kind << 16n) | (e.flags << 24n) | (e.updatedAt << 32n) | (e.roundId << 96n);
  const hi = e.refValueE18 | (e.uiMultiplierE18 << 128n);
  return [lo, hi];
}

export const isDeferred = (e: PriceEntry): boolean => e.flags !== 0n;

/**
 * Rebuild `pricesRoot` and `deferMask` over the live rows.
 *
 * `entries` is fixed-width because circuit shapes are; `count` says how many rows are real.
 * Trailing rows are skipped in the chain but still occupy a mask bit position, which is what
 * makes a short table hash the same way the contract hashed it.
 */
export function pricesRoot(
  entries: readonly PriceEntry[],
  count: number,
  windowId: bigint,
  pricedAt: bigint,
  sequencerOk: boolean,
): { root: bigint; deferMask: bigint } {
  if (entries.length !== MAX_ASSETS) {
    throw new Error(`expected ${MAX_ASSETS} rows, got ${entries.length}`);
  }
  let h = hash2(DOMAIN_PRICES, windowId);
  h = hash2(h, pricedAt);
  h = hash2(h, sequencerOk ? 1n : 0n);

  let deferMask = 0n;
  for (let i = 0; i < MAX_ASSETS; i++) {
    const entry = entries[i]!;
    const [lo, hi] = packEntry(entry);
    if (i < count) {
      h = hash2(h, lo);
      h = hash2(h, hi);
      if (isDeferred(entry)) deferMask |= 1n << BigInt(i);
    }
  }
  return { root: h, deferMask };
}
