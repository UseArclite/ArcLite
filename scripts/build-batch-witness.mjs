// Build a batch_cross witness from TypeScript and write circuits/batch_cross/Prover.toml.
//
// This is the parity check that matters most for Phase 4: every root in the file is recomputed
// inside the circuit and compared against a public input, so if the TypeScript and the Noir ever
// disagree about Poseidon2, the packing, or a domain separator, `nargo execute` fails here rather
// than a window settling on a wrong number.
//
//   bun scripts/build-batch-witness.mjs
import { writeFileSync } from "node:fs";
import { commitment, nullifier, ownerOf } from "../src/lib/notes/note.ts";
import { publicKey, sign } from "../src/lib/notes/grumpkin.ts";
import { emptyEntry } from "../src/lib/notes/prices.ts";
import { authPath, buildWitness, toProverToml } from "../src/server/witness.ts";
import { matchWindow } from "../src/server/matcher.ts";

const WINDOW = 77n;
const PRICED_AT = 1789000000n;

// One healthy asset: NVDA at its live reference and issuer multiplier.
const entries = Array.from({ length: 32 }, emptyEntry);
entries[0] = {
  assetId: 1n,
  kind: 0n,
  flags: 0n,
  updatedAt: PRICED_AT,
  roundId: 12345n,
  refValueE18: 222450000000000000000n,
  uiMultiplierE18: 1000775159164630595n,
};

// Three traders: two buyers and a seller, so the crossing exercises a shared side.
// Real Grumpkin keypairs: `owner` is derived from the key that authorises the spend, and the
// circuit verifies a signature under it. A literal owner would be a note nobody can move.
//
// At real decimals, and with the buyers funded in quote. A buy is paid for in USDG, so its note
// holds USDG (6 decimals, asset 0) while its order is in base units (18 decimals) — two numbers
// that are not comparable, which is why the payload carries both. At the toy unit counts this
// script used to run at, `filled x ref / 10^30` floored to zero and the whole quote leg was
// arithmetic on nothing.
const UNIT = 10n ** 18n; // one whole tokenised share
// The registry's id for tUSDG. Not in the priced table: the circuit refuses a window that
// prices the asset it also pays out in.
const QUOTE_ASSET_ID = 4n;
const keys = [
  { secret: 111n, npk: 7n, nsecret: 333n, noteAsset: QUOTE_ASSET_ID, units: 10_000_000000n }, // $10,000
  { secret: 222n, npk: 9n, nsecret: 444n, noteAsset: 1n, units: 20n * UNIT },
  { secret: 777n, npk: 11n, nsecret: 888n, noteAsset: QUOTE_ASSET_ID, units: 5_000_000000n }, // $5,000
].map((k) => {
  const pk = publicKey(k.secret);
  return { ...k, pk, owner: ownerOf(pk.x, pk.y, k.npk) };
});
const notes = keys.map((k) => ({
  assetId: k.noteAsset,
  units: k.units,
  owner: k.owner,
  nsecret: k.nsecret,
}));
const leaves = notes.map(commitment);

// The matcher decides the fills; the witness builder only rearranges them.
const result = matchWindow(
  [
    { seq: 0, assetId: 1, side: "buy", quantity: 30n * UNIT },
    { seq: 1, assetId: 1, side: "sell", quantity: 20n * UNIT },
    { seq: 2, assetId: 1, side: "buy", quantity: 10n * UNIT },
  ],
  [{ assetId: 1, price1e18: entries[0].refValueE18, decimals: 18, deferred: false }],
  { price1e18: 999991430000000000n, decimals: 6 },
);
console.log("matched:", result.assets[0].matched.toString());
for (const f of result.fills) {
  console.log(`  order ${f.seq}: ${f.side} ${f.quantity} -> filled ${f.filled} (${f.reason})`);
}

const DOMAIN_SPEND = 0x7370656e64n; // "spend"

const orders = result.fills.map((f, i) => {
  const k = keys[f.seq];
  const nul = nullifier(commitment(notes[f.seq]), k.nsecret, BigInt(f.seq));
  // Exactly the message batch_cross builds. If this drifts, the proof will not generate — which
  // is the point of signing here rather than trusting the two to stay in step.
  const message = hash2(
    hash2(DOMAIN_SPEND, WINDOW),
    hash2(hash2(1n, f.side === "buy" ? 0n : 1n), hash2(f.quantity, nul)),
  );
  const sig = sign(k.secret, message);
  return {
    assetIndex: 0,
    side: f.side,
    quantity: f.quantity,
    filled: f.filled,
    salt: BigInt(555 + i),
    note: notes[f.seq],
    leafIndex: BigInt(f.seq),
    path: authPath(leaves, f.seq),
    auth: { pkX: k.pk.x, pkY: k.pk.y, npk: k.npk, sLo: sig.sLo, sHi: sig.sHi, eLo: sig.eLo, eHi: sig.eHi },
  };
});

const witness = buildWitness({
  circuitVersion: 1n,
  windowId: WINDOW,
  subBatchIndex: 0n,
  // The root of the tree the notes actually sit in — computed the same way the contract builds
  // it, so a disagreement is caught here rather than on-chain.
  oldRoot: (() => {
    const path = authPath(leaves, 0);
    let node = leaves[0];
    let idx = 0n;
    for (const sibling of path) {
      node = (idx & 1n) === 0n ? hash2(node, sibling) : hash2(sibling, node);
      idx >>= 1n;
    }
    return node;
  })(),
  entries,
  assetCount: 1,
  pricedAt: PRICED_AT,
  sequencerOk: true,
  quoteAssetId: QUOTE_ASSET_ID,
  orders,
});

import { hash2 } from "../src/lib/notes/poseidon2.ts";

const out = "circuits/batch_cross/Prover.toml";
writeFileSync(out, toProverToml(witness));
console.log(`\nwrote ${out}`);
console.log("orders root:", witness.publicInputs.ordersRoot.toString(16));
console.log("prices root:", witness.publicInputs.pricesRoot.toString(16));
console.log("defer mask :", witness.publicInputs.deferMask.toString());
