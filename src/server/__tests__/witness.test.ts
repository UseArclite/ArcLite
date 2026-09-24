import { describe, expect, test } from "bun:test";
import { commitment, computeRoot, type Note } from "@/lib/notes/note";
import {
  emptyEntry,
  packEntry,
  pricesRoot,
  MAX_ASSETS,
  FLAG_EVENT,
  FLAG_STALE,
  type PriceEntry,
} from "@/lib/notes/prices";
import { authPath, buildWitness, subtreeRoot, N_ORDERS, N_OUTPUTS } from "../witness";
import { resolveCircuitPath, toNoirInputs } from "../prover";
import { readFileSync } from "node:fs";
import { publicKey, sign } from "@/lib/notes/grumpkin";
import { ownerOf } from "@/lib/notes/note";
import { hash2 } from "@/lib/notes/poseidon2";

/// The registry's id for the quote asset. Deliberately not 1: the traded asset is 1, and both
/// the circuit and `buildWitness` refuse a window that prices the asset it also pays out in.
const QUOTE_ASSET_ID = 4n;

/**
 * The witness builder and the price table.
 *
 * The strongest evidence these agree with Noir is not here — it is that
 * `scripts/build-batch-witness.mjs` produces a `Prover.toml` the circuit accepts unchanged, and
 * that the resulting proof verifies both natively and on-chain. These tests cover the parts that
 * would otherwise fail as an unsatisfied constraint with no explanation: bounds, padding rules,
 * and the aggregates the circuit cross-checks.
 */

const NVDA = (over: Partial<PriceEntry> = {}): PriceEntry => ({
  assetId: 1n,
  kind: 0n,
  flags: 0n,
  updatedAt: 1_789_000_000n,
  roundId: 12_345n,
  refValueE18: 222_450_000_000_000_000_000n,
  uiMultiplierE18: 1_000_775_159_164_630_595n,
  ...over,
});

const table = (first: PriceEntry = NVDA()): PriceEntry[] => {
  const rows = Array.from({ length: MAX_ASSETS }, emptyEntry);
  rows[0] = first;
  return rows;
};

describe("price table packing", () => {
  test("packs the two words the contract hashes", () => {
    const [lo, hi] = packEntry(NVDA());
    // Fields recovered by shifting back out, which is what the circuit's recomposition proves.
    expect(lo & 0xffffn).toBe(1n);
    expect((lo >> 24n) & 0xffn).toBe(0n);
    expect(hi & ((1n << 128n) - 1n)).toBe(222_450_000_000_000_000_000n);
    expect(hi >> 128n).toBe(1_000_775_159_164_630_595n);
  });

  test("refuses a multiplier that would push `hi` past the field modulus", () => {
    // This is the bound that matters: an oversized multiplier wraps in the circuit, and two
    // different tables would hash to the same root.
    expect(() => packEntry(NVDA({ uiMultiplierE18: 1n << 126n }))).toThrow(/126 bits/);
  });

  test("refuses every other out-of-range field rather than truncating it", () => {
    expect(() => packEntry(NVDA({ assetId: 1n << 16n }))).toThrow(/16 bits/);
    expect(() => packEntry(NVDA({ flags: 256n }))).toThrow(/8 bits/);
    expect(() => packEntry(NVDA({ roundId: 1n << 80n }))).toThrow(/80 bits/);
  });

  test("a flag changes the root, so a guard cannot be cleared without detection", () => {
    const clean = pricesRoot(table(), 1, 77n, 1n, true);
    const flagged = pricesRoot(table(NVDA({ flags: BigInt(FLAG_EVENT) })), 1, 77n, 1n, true);
    expect(flagged.root).not.toBe(clean.root);
    expect(clean.deferMask).toBe(0n);
    expect(flagged.deferMask).toBe(1n);
  });

  test("the defer mask sets the bit for the row's position, not the asset id", () => {
    const rows = Array.from({ length: MAX_ASSETS }, emptyEntry);
    rows[0] = NVDA();
    rows[1] = NVDA({ assetId: 9n, flags: BigInt(FLAG_STALE) });
    expect(pricesRoot(rows, 2, 77n, 1n, true).deferMask).toBe(0b10n);
  });

  test("the window, the timestamp and the sequencer flag all bind the table", () => {
    const base = pricesRoot(table(), 1, 77n, 1n, true).root;
    expect(pricesRoot(table(), 1, 78n, 1n, true).root).not.toBe(base);
    expect(pricesRoot(table(), 1, 77n, 2n, true).root).not.toBe(base);
    expect(pricesRoot(table(), 1, 77n, 1n, false).root).not.toBe(base);
  });

  test("rows past the live count do not enter the chain", () => {
    const rows = table();
    const withNoise = table();
    withNoise[5] = NVDA({ assetId: 7n });
    expect(pricesRoot(withNoise, 1, 77n, 1n, true).root).toBe(
      pricesRoot(rows, 1, 77n, 1n, true).root,
    );
  });
});

describe("trees", () => {
  test("an authentication path reaches the root it was built from", () => {
    const leaves = [11n, 22n, 33n];
    const root = computeRoot(leaves[0]!, authPath(leaves, 0), 0n);
    for (let i = 0; i < leaves.length; i++) {
      expect(computeRoot(leaves[i]!, authPath(leaves, i), BigInt(i))).toBe(root);
    }
  });

  test("the output subtree takes exactly 32 leaves", () => {
    expect(() => subtreeRoot([1n, 2n])).toThrow(/expected 32/);
    expect(typeof subtreeRoot(Array.from({ length: N_OUTPUTS }, (_, i) => BigInt(i)))).toBe(
      "bigint",
    );
  });
});

describe("witness", () => {
  // Real keypairs: `owner` is derived from the key that authorises the spend, so a literal owner
  // would be a note nobody can move.
  const keyFor = (secret: bigint, npk: bigint) => {
    const pk = publicKey(secret);
    return { pk, npk, owner: ownerOf(pk.x, pk.y, npk) };
  };
  const K0 = keyFor(111n, 7n);
  const K1 = keyFor(222n, 9n);

  const note = (units: bigint, owner: bigint, nsecret: bigint): Note => ({
    assetId: 1n,
    units,
    owner,
    nsecret,
  });

  /** A signature's contents are not checked here — the circuit does that — only that it flows. */
  const authFor = (k: ReturnType<typeof keyFor>) => {
    const sig = sign(111n, 1n);
    return {
      pkX: k.pk.x,
      pkY: k.pk.y,
      npk: k.npk,
      sLo: sig.sLo,
      sHi: sig.sHi,
      eLo: sig.eLo,
      eHi: sig.eHi,
    };
  };

  function twoSided() {
    const notes = [note(30n, K0.owner, 333n), note(20n, K1.owner, 444n)];
    const leaves = notes.map(commitment);
    return buildWitness({
      circuitVersion: 1n,
      windowId: 77n,
      subBatchIndex: 0n,
      oldRoot: computeRoot(leaves[0]!, authPath(leaves, 0), 0n),
      entries: table(),
      assetCount: 1,
      pricedAt: 1_789_000_000n,
      sequencerOk: true,
      quoteAssetId: QUOTE_ASSET_ID,
      orders: [
        {
          assetIndex: 0,
          side: "buy",
          quantity: 30n,
          filled: 20n,
          salt: 555n,
          note: notes[0]!,
          leafIndex: 0n,
          path: authPath(leaves, 0),
          auth: authFor(K0),
        },
        {
          assetIndex: 0,
          side: "sell",
          quantity: 20n,
          filled: 20n,
          salt: 556n,
          note: notes[1]!,
          leafIndex: 1n,
          path: authPath(leaves, 1),
          auth: authFor(K1),
        },
      ],
    });
  }

  test("derives the per-asset aggregates the circuit cross-checks", () => {
    const w = twoSided();
    const p = w.private as Record<string, bigint[]>;
    expect(p.asset_buy_total![0]).toBe(30n);
    expect(p.asset_sell_total![0]).toBe(20n);
    expect(p.asset_matched![0]).toBe(20n);
    // The sell side is smaller, so the bit stays 0.
    expect(p.buy_is_smaller![0]).toBe(0n);
  });

  test("witnesses the division rather than performing it in the field", () => {
    const w = twoSided();
    const p = w.private as Record<string, bigint[]>;
    // 30 × 20 / 30 = 20 exactly for the buyer; 20 × 20 / 20 = 20 for the seller.
    expect(p.prorata_q![0]).toBe(20n);
    expect(p.prorata_r![0]).toBe(0n);
    expect(p.prorata_q![1]).toBe(20n);
  });

  test("padding slots are inert: no quantity, no fill, no nullifier", () => {
    const w = twoSided();
    const p = w.private as Record<string, bigint[]>;
    for (let i = 2; i < N_ORDERS; i++) {
      expect(p.active![i]).toBe(0n);
      expect(p.quantity![i]).toBe(0n);
      expect(p.filled![i]).toBe(0n);
      expect(w.publicInputs.nullifiers[i]).toBe(0n);
    }
  });

  test("every real order publishes a distinct nullifier", () => {
    const w = twoSided();
    const spent = w.publicInputs.nullifiers.filter((n) => n !== 0n);
    expect(spent).toHaveLength(2);
    expect(new Set(spent.map(String)).size).toBe(2);
  });

  test("a deferred asset gets a matched size of zero", () => {
    const notes = [note(30n, K0.owner, 333n)];
    const leaves = notes.map(commitment);
    const w = buildWitness({
      circuitVersion: 1n,
      windowId: 77n,
      subBatchIndex: 0n,
      oldRoot: computeRoot(leaves[0]!, authPath(leaves, 0), 0n),
      entries: table(NVDA({ flags: BigInt(FLAG_STALE) })),
      assetCount: 1,
      pricedAt: 1n,
      sequencerOk: true,
      quoteAssetId: QUOTE_ASSET_ID,
      orders: [
        {
          assetIndex: 0,
          side: "buy",
          quantity: 30n,
          filled: 0n,
          salt: 1n,
          note: notes[0]!,
          leafIndex: 0n,
          path: authPath(leaves, 0),
          auth: authFor(K0),
        },
      ],
    });
    expect((w.private as Record<string, bigint[]>).asset_matched![0]).toBe(0n);
    expect(w.publicInputs.deferMask).toBe(1n);
  });

  test("refuses a sub-batch larger than the circuit", () => {
    const notes = [note(1n, K0.owner, 1n)];
    const leaves = notes.map(commitment);
    const one = {
      assetIndex: 0,
      side: "buy" as const,
      quantity: 1n,
      filled: 0n,
      salt: 1n,
      note: notes[0]!,
      leafIndex: 0n,
      path: authPath(leaves, 0),
      auth: authFor(K0),
    };
    expect(() =>
      buildWitness({
        circuitVersion: 1n,
        windowId: 1n,
        subBatchIndex: 0n,
        oldRoot: 0n,
        entries: table(),
        assetCount: 1,
        pricedAt: 1n,
        sequencerOk: true,
        quoteAssetId: QUOTE_ASSET_ID,
        orders: Array.from({ length: N_ORDERS + 1 }, () => one),
      }),
    ).toThrow(/at most 16/);
  });

  test("the public inputs are the 26 settleBatch builds", () => {
    const w = twoSided();
    const p = w.publicInputs;
    expect(p.nullifiers).toHaveLength(N_ORDERS);
    // 10 scalars + 16 nullifiers, matching the on-chain fixture's 832-byte public input blob.
    expect(10 + p.nullifiers.length).toBe(26);
  });
});

describe("the quote leg", () => {
  const keyFor = (secret: bigint, npk: bigint) => {
    const pk = publicKey(secret);
    return { pk, npk, owner: ownerOf(pk.x, pk.y, npk) };
  };
  const K0 = keyFor(111n, 7n);
  const K1 = keyFor(222n, 9n);
  const authFor = (k: ReturnType<typeof keyFor>) => {
    const sig = sign(111n, 1n);
    return {
      pkX: k.pk.x,
      pkY: k.pk.y,
      npk: k.npk,
      sLo: sig.sLo,
      sHi: sig.sHi,
      eLo: sig.eLo,
      eHi: sig.eHi,
    };
  };

  const UNIT = 10n ** 18n;
  // A buy is funded with quote, so its note is USDG at six decimals and asset 0; a sell is
  // funded with the asset itself. Built at real decimals because `filled × ref / 10^30` floors
  // to zero at the single-digit unit counts the other fixtures use, which is exactly how a quote
  // leg that moved no value at all stayed invisible.
  const buyerNote: Note = {
    assetId: QUOTE_ASSET_ID,
    units: 10_000_000000n,
    owner: K0.owner,
    nsecret: 333n,
  };
  const sellerNote: Note = { assetId: 1n, units: 20n * UNIT, owner: K1.owner, nsecret: 444n };

  function crossed() {
    const leaves = [commitment(buyerNote), commitment(sellerNote)];
    return buildWitness({
      circuitVersion: 1n,
      windowId: 77n,
      subBatchIndex: 0n,
      oldRoot: computeRoot(leaves[0]!, authPath(leaves, 0), 0n),
      entries: table(),
      assetCount: 1,
      pricedAt: 1_789_000_000n,
      sequencerOk: true,
      quoteAssetId: QUOTE_ASSET_ID,
      orders: [
        {
          assetIndex: 0,
          side: "buy",
          quantity: 30n * UNIT,
          filled: 20n * UNIT,
          salt: 555n,
          note: buyerNote,
          leafIndex: 0n,
          path: authPath(leaves, 0),
          auth: authFor(K0),
        },
        {
          assetIndex: 0,
          side: "sell",
          quantity: 20n * UNIT,
          filled: 20n * UNIT,
          salt: 556n,
          note: sellerNote,
          leafIndex: 1n,
          path: authPath(leaves, 1),
          auth: authFor(K1),
        },
      ],
    });
  }

  test("draws the buyer's payment from its quote note, not from the asset", () => {
    const w = crossed();
    const p = w.private as Record<string, bigint[]>;
    // 20 whole shares at $222.45 = 4449.00 USDG, exactly, at six decimals.
    const cost = 4_449_000000n;
    expect(p.quote_q![0]).toBe(cost);

    // The buyer's residual is the unspent quote and the received leg is the asset. Before buyers
    // funded with quote, both legs were the traded asset and the two cancelled: the buyer's
    // note came back whole and the trade moved nothing.
    const residual = {
      assetId: QUOTE_ASSET_ID,
      units: 10_000_000000n - cost,
      owner: K0.owner,
      nsecret: hash2(333n, hash2(77n, 0n)),
    };
    const received = {
      assetId: 1n,
      units: 20n * UNIT,
      owner: K0.owner,
      nsecret: hash2(333n, hash2(77n, 1n)),
    };
    expect(p.out_commitment![0]).toBe(commitment(residual));
    expect(p.out_commitment![1]).toBe(commitment(received));
  });

  test("proves the note covers the whole order, not only the part that filled", () => {
    const p = crossed().private as Record<string, bigint[]>;
    // The matcher chose a 20-share fill, but the order was for 30. The note has to cover 30 —
    // the matcher picks the fill after the order is signed, so a note that covered some outcomes
    // and not others would make a valid crossing unprovable after the fact.
    expect(p.max_cost_q![0]).toBe(6_673_500000n);
    expect(p.max_cost_r![0]).toBe(0n);
  });
});

describe("the circuit ABI", () => {
  // `toNoirInputs` hand-lists every parameter, and the list drifted: `quote_asset_id`,
  // `max_cost_q` and `max_cost_r` were added to the circuit and to `toProverToml` but not here.
  // Nothing caught it, because the shape is only checked when the witness executes — inside a
  // Vercel function, on the settlement path, reported as a window that failed.
  //
  // Reading the compiled circuit's own ABI is the only version of this test that cannot go
  // stale: the circuit is the definition, so a parameter added to it fails here until it is
  // supplied, and one removed fails until it stops being.
  const circuit = JSON.parse(readFileSync(resolveCircuitPath(), "utf8")) as {
    abi: { parameters: { name: string }[] };
  };

  test("every parameter the circuit declares is supplied, and nothing else is", () => {
    const witness = buildWitness({
      circuitVersion: 1n,
      windowId: 77n,
      subBatchIndex: 0n,
      oldRoot: 0n,
      entries: table(),
      assetCount: 1,
      pricedAt: 1_789_000_000n,
      sequencerOk: true,
      quoteAssetId: 4n,
      orders: [],
    });

    const declared = circuit.abi.parameters.map((p) => p.name).sort();
    const supplied = Object.keys(toNoirInputs(witness)).sort();
    expect(supplied).toEqual(declared);
  });
});
