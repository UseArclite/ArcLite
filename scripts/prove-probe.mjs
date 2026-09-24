// The full serverless proving path: build a witness, solve it in JS, prove it, verify it.
// No nargo, no native bb — only what a Vercel function would have.
//
//   node --experimental-strip-types scripts/prove-probe.mjs
import { commitment } from "../src/lib/notes/note.ts";
import { emptyEntry } from "../src/lib/notes/prices.ts";
import { authPath, buildWitness } from "../src/server/witness.ts";
import { matchWindow } from "../src/server/matcher.ts";
import {
  executeWitness, proveBatch, verifyBatch, shutdownProver, toNoirInputs, proverUnavailableReason,
} from "../src/server/prover.ts";
import { hash2 } from "../src/lib/notes/poseidon2.ts";

const reason = proverUnavailableReason();
if (reason) { console.error(reason); process.exit(1); }

const entries = Array.from({ length: 32 }, emptyEntry);
entries[0] = {
  assetId: 1n, kind: 0n, flags: 0n, updatedAt: 1789000000n, roundId: 12345n,
  refValueE18: 222450000000000000000n, uiMultiplierE18: 1000775159164630595n,
};

const notes = [
  { assetId: 1n, units: 30n, owner: 111n, nsecret: 333n },
  { assetId: 1n, units: 20n, owner: 222n, nsecret: 444n },
  { assetId: 1n, units: 10n, owner: 777n, nsecret: 888n },
];
const leaves = notes.map(commitment);
const oldRoot = (() => {
  let node = leaves[0], idx = 0n;
  for (const s of authPath(leaves, 0)) { node = (idx & 1n) === 0n ? hash2(node, s) : hash2(s, node); idx >>= 1n; }
  return node;
})();

const result = matchWindow(
  [{ seq: 0, assetId: 1, side: "buy", quantity: 30n },
   { seq: 1, assetId: 1, side: "sell", quantity: 20n },
   { seq: 2, assetId: 1, side: "buy", quantity: 10n }],
  [{ assetId: 1, price1e18: entries[0].refValueE18, decimals: 18, deferred: false }],
  { price1e18: 10n ** 18n, decimals: 6 },
);

const witness = buildWitness({
  circuitVersion: 1n, windowId: 77n, subBatchIndex: 0n, oldRoot,
  entries, assetCount: 3, pricedAt: 1789000000n, sequencerOk: true,
  orders: result.fills.map((f) => ({
    assetIndex: 0, side: f.side, quantity: f.quantity, filled: f.filled,
    salt: BigInt(555 + f.seq), note: notes[f.seq],
    leafIndex: BigInt(f.seq), path: authPath(leaves, f.seq),
  })),
  outputs: [9001n, 9002n, 9003n],
});

let t = Date.now();
const solved = await executeWitness(toNoirInputs(witness));
console.log(`witness solved in JS in ${((Date.now() - t) / 1000).toFixed(2)}s (${solved.length} bytes)`);

const proof = await proveBatch(solved);
console.log(`proved in ${(proof.provingMs / 1000).toFixed(2)}s`);
console.log(`proof fields ${proof.proof.length}, public inputs ${proof.publicInputs.length}`);
console.log(`peak rss ${Math.round(process.memoryUsage().rss / 1e6)}MB`);
console.log("verifies:", await verifyBatch(proof));
await shutdownProver();
