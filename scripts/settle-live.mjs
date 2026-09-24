// A complete crossing, settled on the live chain.
//
// Everything downstream of the seal is derived from what the chain says, not from fixtures:
//
//   1. shield real notes into the deployed pool
//   2. decide the book, hash it, and seal the window with that ordersRoot
//   3. commitWindow — the contract reads the feeds itself and fixes pricesRoot and deferMask
//   4. read the committed table back and build the batch_cross witness from it
//   5. prove with barretenberg
//   6. settleBatch
//
// The ordering in 2 and 3 is the security property, not an implementation detail: the book is
// frozen before any price is observed, so nobody — operator included — holds a free option on
// the window's reference. The pool enforces it (`wp.committedAt < w.sealedAt` reverts).
//
//   bun scripts/settle-live.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rhcTestnet, ARCLITE } from "../src/lib/chain/chains.ts";
import { commitment, computeRoot, nullifier, ownerOf } from "../src/lib/notes/note.ts";
import { publicKey, sign } from "../src/lib/notes/grumpkin.ts";
import { readLeafSet } from "../src/server/leaves.ts";
import { emptyEntry, MAX_ASSETS } from "../src/lib/notes/prices.ts";
import { authPath, buildWitness, toProverToml } from "../src/server/witness.ts";
import { matchWindow } from "../src/server/matcher.ts";
import { hash2 } from "../src/lib/notes/poseidon2.ts";

const POOL = process.env.ARCLITE_POOL ?? ARCLITE[46630].pool;
const PRICER = process.env.ARCLITE_PRICER ?? ARCLITE[46630].priceCommitter;
const TOKEN = "0xB32011d2CB1D071a4c2897fE61Af443Cb88E3f73"; // tNVDA, assetId 1
const ASSET_ID = 1;
// tUSDG, six decimals, assetId 4. A buy is funded with this and a sell is paid in it. Never
// passed to `commitWindow`: the circuit refuses a window that prices the asset it pays out in.
const QUOTE_TOKEN = "0x3d62863D523027d8bC5A362Bd99186fa1eb39A14";
const QUOTE_ASSET_ID = 4n;
/// One whole tokenised share. The venue runs at eighteen decimals and the quote at six; at the
/// single-digit unit counts this script used to use, `filled x ref / 10^30` floors to zero and
/// the entire quote leg is arithmetic on nothing.
const UNIT = 10n ** 18n;
const DOMAIN_SPEND = 0x7370656e64n; // "spend"
const WINDOW = BigInt(process.env.WINDOW_ID ?? Math.floor(Date.now() / 1000));

const poolAbi = [
  { type:"function", name:"shield", stateMutability:"nonpayable",
    inputs:[{type:"uint16"},{type:"uint128"},{type:"bytes32"},{type:"bytes"},{type:"bytes32[]"},{type:"bytes"}],
    outputs:[{type:"uint32"}] },
  { type:"function", name:"sealWindow", stateMutability:"nonpayable",
    inputs:[{type:"uint64"},{type:"bytes32"},{type:"uint16"},{type:"uint8"}], outputs:[] },
  { type:"function", name:"settleBatch", stateMutability:"nonpayable",
    inputs:[{ type:"tuple", components:[
      {name:"windowId",type:"uint64"},{name:"subBatchIndex",type:"uint8"},{name:"proof",type:"bytes"},
      {name:"oldRoot",type:"bytes32"},{name:"outputsSubtreeRoot",type:"bytes32"},
      {name:"outputsSubtreeDepth",type:"uint8"},{name:"nullifiers",type:"bytes32[]"},
      {name:"outputCommitments",type:"bytes32[]"},
      {name:"receiptsRoot",type:"bytes32"},{name:"tapeLeaf",type:"bytes32"},
      {name:"filledOrders",type:"uint16"}]}], outputs:[] },
  { type:"function", name:"currentRoot", stateMutability:"view", inputs:[], outputs:[{type:"bytes32"}] },
  { type:"function", name:"nextLeafIndex", stateMutability:"view", inputs:[], outputs:[{type:"uint32"}] },
  { type:"function", name:"openWindowId", stateMutability:"view", inputs:[], outputs:[{type:"uint64"}] },
  { type:"function", name:"voidWindow", stateMutability:"nonpayable", inputs:[{type:"uint64"}], outputs:[] },
  { type:"function", name:"pendingDepositCount", stateMutability:"view", inputs:[], outputs:[{type:"uint256"}] },
  { type:"function", name:"nullifierSpent", stateMutability:"view", inputs:[{type:"bytes32"}], outputs:[{type:"bool"}] },
  { type:"function", name:"totalUnits", stateMutability:"view", inputs:[{type:"uint16"}], outputs:[{type:"uint256"}] },
];
const pricerAbi = [
  { type:"function", name:"heartbeat", stateMutability:"nonpayable", inputs:[], outputs:[] },
  { type:"function", name:"commitWindow", stateMutability:"nonpayable",
    inputs:[{type:"uint64"},{type:"uint16[]"}], outputs:[{type:"bytes32"},{type:"uint256"}] },
  { type:"function", name:"window", stateMutability:"view", inputs:[{type:"uint64"}],
    outputs:[{ type:"tuple", components:[{name:"pricesRoot",type:"bytes32"},{name:"deferMask",type:"uint256"},
      {name:"committedAt",type:"uint64"},{name:"assetCount",type:"uint16"},{name:"sequencerOk",type:"bool"}]}] },
  { type:"function", name:"entryOf", stateMutability:"view", inputs:[{type:"uint64"},{type:"uint16"}],
    outputs:[{ type:"tuple", components:[{name:"assetId",type:"uint16"},{name:"kind",type:"uint8"},
      {name:"flags",type:"uint8"},{name:"updatedAt",type:"uint64"},{name:"roundId",type:"uint80"},
      {name:"refValueE18",type:"uint128"},{name:"uiMultiplierE18",type:"uint128"}]}] },
];
const tokenAbi = [
  { type:"function", name:"approve", stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"}], outputs:[{type:"bool"}] },
  { type:"function", name:"mint", stateMutability:"nonpayable", inputs:[{type:"address"},{type:"uint256"}], outputs:[] },
];

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: rhcTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: rhcTestnet, transport: http() });
// A reverted transaction still produces a receipt, so a helper that only waits reports success
// for a failed call. That hid three queued deposits behind an "everything worked" log and cost
// an hour chasing a Merkle constraint that was never the problem.
const send = async (args) => {
  const receipt = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(args) });
  if (receipt.status !== "success") {
    throw new Error(`${args.functionName} reverted: ${receipt.transactionHash}`);
  }
  return receipt;
};

// ---------------------------------------------------------------------------------------
// 1. the book, and the notes backing it
// ---------------------------------------------------------------------------------------
// Two buyers and one seller, so the crossing has a shared side and pro-rata actually bites.
// Real Grumpkin keypairs: `owner` is derived from the key that signs the spend, and the circuit
// verifies a signature under it. A literal owner would be a note nobody can move.
const book = [
  { seq: 0, side: "buy",  quantity: 30n * UNIT, secret: 111n, npk: 7n,  nsecret: 333n, salt: 555n, noteUnits: 10_000_000000n },
  { seq: 1, side: "sell", quantity: 20n * UNIT, secret: 222n, npk: 9n,  nsecret: 444n, salt: 556n, noteUnits: 20n * UNIT },
  { seq: 2, side: "buy",  quantity: 10n * UNIT, secret: 777n, npk: 11n, nsecret: 888n, salt: 557n, noteUnits: 5_000_000000n },
].map((o) => {
  const pk = publicKey(o.secret);
  // `nsecret` is mixed with the window, so two runs never produce the same commitment. Without
  // it a rerun shields a note identical to the last run's, and locating it by commitment finds
  // the *earlier* leaf — a note that proves fine but is not the one just deposited.
  return { ...o, pk, owner: ownerOf(pk.x, pk.y, o.npk), nsecret: hash2(o.nsecret, WINDOW) };
});
// A seller funds the trade with the asset; a buyer funds it with quote. Taking both from the
// traded asset made a buy a no-op — the buyer spent a note of the asset and got the same asset
// back, while the seller's quote was minted from nowhere.
const notes = book.map((o) => ({
  assetId: o.side === "sell" ? BigInt(ASSET_ID) : QUOTE_ASSET_ID,
  units: o.noteUnits,
  owner: o.owner,
  nsecret: o.nsecret,
}));

console.log("=== 1. shielding the notes ===");

// A sealed-but-unsettled window makes `shield` queue instead of insert, so notes would never
// reach the tree and every membership proof would fail. Clear it first — `voidWindow` moves no
// value, so this is recovery rather than a workaround.
const openWindow = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "openWindowId" });
if (openWindow !== 0n) {
  console.log(`  window ${openWindow} is still open; voiding it so deposits can enter the tree`);
  await send({ address: POOL, abi: poolAbi, functionName: "voidWindow", args: [openWindow] });
}

const startIndex = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "nextLeafIndex" });
console.log("  tree starts at leaf", startIndex);

// Two tokens now, because the two sides are funded differently.
for (const [token, assetId] of [[TOKEN, BigInt(ASSET_ID)], [QUOTE_TOKEN, QUOTE_ASSET_ID]]) {
  const needed = notes.filter((n) => n.assetId === assetId).reduce((a, n) => a + n.units, 0n);
  if (needed === 0n) continue;
  await send({ address: token, abi: tokenAbi, functionName: "mint", args: [account.address, needed] });
  await send({ address: token, abi: tokenAbi, functionName: "approve", args: [POOL, needed] });
}
for (let i = 0; i < notes.length; i++) {
  const c = commitment(notes[i]);
  await send({ address: POOL, abi: poolAbi, functionName: "shield",
    args: [Number(notes[i].assetId), notes[i].units, toHex(c, { size: 32 }), "0x", [], "0x"] });
  console.log(`  note ${i} -> leaf ${startIndex + i}  ${notes[i].units} of asset ${notes[i].assetId}`);
}

const oldRoot = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "currentRoot" });
console.log("  pool root:", oldRoot);

// The client rebuilds the whole tree locally, from the public commitment set, so its paths are
// its own rather than a server's answer. Read from LeafInserted logs and placed by index — log
// order and tree order are not the same thing once a settlement splices a subtree.
// `LeafInserted` alone covers single deposits. A settled batch splices a 32-leaf subtree and
// announces it through `OutputsPublished`, so a pool that has settled once reads back a tree
// with holes unless both are merged — and the holes are real zero leaves, not missing data.
const leaves = await readLeafSet(pub, POOL, BigInt(process.env.ARCLITE_POOL_BLOCK ?? ARCLITE[rhcTestnet.id].deployBlock));
console.log(`  read ${leaves.length} leaves from chain`);

// Locate each note by its commitment, exactly as the vault worker does. Assuming
// `startIndex + i` is what broke this before: the deposits had been queued, not inserted, and
// the indices pointed at leaves that did not exist.
const leafIndexOf = notes.map((n) => {
  const c = commitment(n);
  const at = leaves.findIndex((l) => l === c);
  if (at === -1) throw new Error(`note ${c.toString(16)} is not in the tree — was it queued?`);
  return at;
});
console.log("  notes sit at leaves", leafIndexOf.join(", "));
const localRoot = (() => {
  let node = leaves[0], idx = 0n;
  for (const sib of authPath(leaves, 0)) { node = (idx & 1n) === 0n ? hash2(node, sib) : hash2(sib, node); idx >>= 1n; }
  return node;
})();
if (BigInt(oldRoot) !== localRoot) throw new Error(`local tree disagrees with the pool: ${localRoot.toString(16)}`);
console.log("  local tree matches the pool's root");

// ---------------------------------------------------------------------------------------
// 2. seal the book — before any price is observed
// ---------------------------------------------------------------------------------------
const DOMAIN_ORDER = 0x6f72646572n;
let ordersRoot = hash2(DOMAIN_ORDER, WINDOW);
ordersRoot = hash2(ordersRoot, 0n); // sub-batch index
for (const o of book) {
  ordersRoot = hash2(ordersRoot, hash2(
    hash2(hash2(BigInt(ASSET_ID), o.side === "buy" ? 0n : 1n), o.quantity),
    hash2(o.owner, o.salt)));
}
console.log("\n=== 2. sealing window", WINDOW, "===");
await send({ address: POOL, abi: poolAbi, functionName: "sealWindow",
  args: [WINDOW, toHex(ordersRoot, { size: 32 }), book.length, 1] });
console.log("  ordersRoot 0x" + ordersRoot.toString(16).padStart(64, "0"));

// ---------------------------------------------------------------------------------------
// 3. price the window — the contract reads the feeds itself
// ---------------------------------------------------------------------------------------
console.log("\n=== 3. pricing ===");

// The heartbeat shim needs continuous liveness, not a single ping. A ping after a gap counts as
// recovery and starts the grace period, during which every asset defers pool-wide — so pricing
// immediately after one ping always yields deferMask = all. In production a cron pings every
// minute and no gap exists; here the gap has to be waited out deliberately.
const heartbeatAbi = [...pricerAbi,
  { type:"function", name:"sequencerOk", stateMutability:"view", inputs:[], outputs:[{type:"bool"}] }];
for (let attempt = 0; ; attempt++) {
  await send({ address: PRICER, abi: pricerAbi, functionName: "heartbeat" });
  if (await pub.readContract({ address: PRICER, abi: heartbeatAbi, functionName: "sequencerOk" })) {
    console.log(`  sequencer live after ${attempt + 1} heartbeat(s)`);
    break;
  }
  if (attempt >= 12) throw new Error("sequencer never came live; check the grace period");
  console.log("  in grace period, waiting…");
  await new Promise((r) => setTimeout(r, 15_000));
}

// Republish every feed at its current answer.
//
// The stand-in feeds have no keeper: they were written once at seeding and then sat still, so
// anything more than `maxStalenessSec` (a day) after a seed defers every asset and the venue
// looks broken for a reason that has nothing to do with the venue. A real Chainlink aggregator
// refreshes itself; these need someone to do it. Same answer, new `updatedAt` — this is a
// liveness ping, not a price change.
const feedAbi = [
  { type:"function", name:"answer", stateMutability:"view", inputs:[], outputs:[{type:"int256"}] },
  { type:"function", name:"setAnswer", stateMutability:"nonpayable", inputs:[{type:"int256"}], outputs:[] },
];
const FEEDS = [
  "0x9c2dC66Bd7484b67341ccdca7515775B04A62264", // tNVDA
  "0x1342192Db807F645Ea2Da56F63305643389BaB3b", // tAAPL
  "0x599032FD4844FFdAf4F7eF3e65E2261D3AbED566", // tSPY
];
for (const feed of FEEDS) {
  const answer = await pub.readContract({ address: feed, abi: feedAbi, functionName: "answer" });
  await send({ address: feed, abi: feedAbi, functionName: "setAnswer", args: [answer] });
}
console.log(`  refreshed ${FEEDS.length} feeds`);

await send({ address: PRICER, abi: pricerAbi, functionName: "commitWindow", args: [WINDOW, [1, 2, 3]] });
const wp = await pub.readContract({ address: PRICER, abi: pricerAbi, functionName: "window", args: [WINDOW] });
console.log("  pricesRoot", wp.pricesRoot, " deferMask", wp.deferMask.toString(), " sequencerOk", wp.sequencerOk);
if (wp.deferMask !== 0n) throw new Error("assets are deferred; nothing can cross");

const entries = Array.from({ length: MAX_ASSETS }, emptyEntry);
for (let i = 0; i < 3; i++) {
  const e = await pub.readContract({ address: PRICER, abi: pricerAbi, functionName: "entryOf", args: [WINDOW, i + 1] });
  entries[i] = { assetId: BigInt(e.assetId), kind: BigInt(e.kind), flags: BigInt(e.flags),
    updatedAt: BigInt(e.updatedAt), roundId: BigInt(e.roundId),
    refValueE18: BigInt(e.refValueE18), uiMultiplierE18: BigInt(e.uiMultiplierE18) };
}

// ---------------------------------------------------------------------------------------
// 4. match and build the witness from the committed table
// ---------------------------------------------------------------------------------------
console.log("\n=== 4. matching ===");
const result = matchWindow(
  book.map((o) => ({ seq: o.seq, assetId: ASSET_ID, side: o.side, quantity: o.quantity })),
  [{ assetId: ASSET_ID, price1e18: entries[0].refValueE18, decimals: 18, deferred: false }],
  { price1e18: 10n ** 18n, decimals: 6 },
);
for (const f of result.fills) console.log(`  order ${f.seq}: ${f.side} ${f.quantity} -> ${f.filled} (${f.reason})`);

const witness = buildWitness({
  circuitVersion: 1n, windowId: WINDOW, subBatchIndex: 0n, oldRoot: BigInt(oldRoot),
  entries, assetCount: 3, pricedAt: BigInt(wp.committedAt), sequencerOk: wp.sequencerOk,
  quoteAssetId: QUOTE_ASSET_ID,
  orders: result.fills.map((f) => {
    const o = book[f.seq];
    const leafIndex = BigInt(leafIndexOf[f.seq]);
    const nul = nullifier(commitment(notes[f.seq]), o.nsecret, leafIndex);
    // Exactly the message `batch_cross` builds, over the *traded* asset — a buy is about tNVDA
    // even though it is paid for in tUSDG. Not bound to the slot or sub-batch: the sealer
    // assigns both after submission, so a trader signing offline cannot know them.
    const message = hash2(
      hash2(DOMAIN_SPEND, WINDOW),
      hash2(hash2(BigInt(ASSET_ID), f.side === "buy" ? 0n : 1n), hash2(f.quantity, nul)),
    );
    const sig = sign(o.secret, message);
    return {
      assetIndex: 0, side: f.side, quantity: f.quantity, filled: f.filled,
      salt: o.salt, note: notes[f.seq], leafIndex, path: authPath(leaves, leafIndexOf[f.seq]),
      auth: { pkX: o.pk.x, pkY: o.pk.y, npk: o.npk, sLo: sig.sLo, sHi: sig.sHi, eLo: sig.eLo, eHi: sig.eHi },
    };
  }),
  // Output notes. The circuit constrains only that they form the subtree the contract splices.
});

// Derived from the book by buildWitness and checked by the circuit: two per order, the residual
// and the received leg, both owned by that order's owner.
const outputs = witness.private.out_commitment;

// Check membership here rather than discovering it as an unsatisfiable constraint: the circuit
// would say "Failed constraint" and name a line, which is true but says nothing about why.
for (let i = 0; i < notes.length; i++) {
  const reached = computeRoot(commitment(notes[i]), authPath(leaves, leafIndexOf[i]), BigInt(leafIndexOf[i]));
  if (reached !== BigInt(oldRoot)) throw new Error(`note ${i} at leaf ${leafIndexOf[i]} does not reach the pool root`);
}
console.log("  every note's path reaches the pool root");

if (witness.publicInputs.ordersRoot !== ordersRoot) throw new Error("witness disagrees with the sealed book");
if (BigInt(wp.pricesRoot) !== witness.publicInputs.pricesRoot) throw new Error("witness disagrees with the committed table");
console.log("  witness agrees with the sealed book and the committed table");

writeFileSync("circuits/batch_cross/Prover.toml", toProverToml(witness));

// ---------------------------------------------------------------------------------------
// 5. prove
// ---------------------------------------------------------------------------------------
console.log("\n=== 5. proving ===");
const env = { ...process.env, PATH: `${process.env.HOME}/.nargo/bin:${process.env.HOME}/.bb:${process.env.PATH}` };
const run = (cmd, args) => execFileSync(cmd, args, { cwd: "circuits", env, stdio: ["ignore", "pipe", "pipe"] });
const started = Date.now();
run("nargo", ["execute", "--package", "batch_cross", "live_witness"]);
run("bb", ["prove", "-b", "target/batch_cross.json", "-w", "target/live_witness.gz",
  "-o", "target/batch_cross", "--verifier_target", "evm", "--write_vk", "--verify"]);
console.log(`  proved and natively verified in ${((Date.now() - started) / 1000).toFixed(2)}s`);

const proof = toHex(readFileSync("circuits/target/batch_cross/proof"));
const rawPi = readFileSync("circuits/target/batch_cross/public_inputs");
console.log(`  proof ${(proof.length - 2) / 2} bytes, ${rawPi.length / 32} public inputs`);

// ---------------------------------------------------------------------------------------
// 6. settle
// ---------------------------------------------------------------------------------------
console.log("\n=== 6. settling on chain ===");
const p = witness.publicInputs;
const receipt = await send({
  address: POOL, abi: poolAbi, functionName: "settleBatch",
  args: [{
    windowId: WINDOW, subBatchIndex: 0, proof,
    oldRoot, outputsSubtreeRoot: toHex(p.outputsSubtreeRoot, { size: 32 }), outputsSubtreeDepth: 5,
    nullifiers: p.nullifiers.map((n) => toHex(n, { size: 32 })),
    // Published so the commitment set stays reconstructible from chain data alone. Without them
    // a note created here could never be spent: its owner could not build a path to a leaf
    // nobody announced.
    outputCommitments: outputs.map((c) => toHex(c, { size: 32 })),
    receiptsRoot: toHex(p.receiptsRoot, { size: 32 }),
    tapeLeaf: toHex(p.tapeLeaf, { size: 32 }),
    filledOrders: result.fills.filter((f) => f.filled > 0n).length,
  }],
  // Verification alone is ~3M gas and forge's default estimate came in short before.
  gas: 6_000_000n,
});
console.log("  status:", receipt.status, " gas used:", receipt.gasUsed.toString());

const spent = await Promise.all(p.nullifiers.filter((n) => n !== 0n)
  .map((n) => pub.readContract({ address: POOL, abi: poolAbi, functionName: "nullifierSpent", args: [toHex(n, { size: 32 })] })));
console.log("  nullifiers marked spent:", spent.filter(Boolean).length, "of", spent.length);
console.log("  new pool root:", await pub.readContract({ address: POOL, abi: poolAbi, functionName: "currentRoot" }));
console.log("\na real batch crossing settled on chain", rhcTestnet.id);

// ---------------------------------------------------------------------------------------
// 7. publish the tape, once the delay has passed
// ---------------------------------------------------------------------------------------
// From the shared config, not a literal. A hardcoded address here drifted two redeploys
// behind the pool and published to a registry bound to a venue that no longer exists.
const TAPE = process.env.ARCLITE_TAPE ?? ARCLITE[46630].tapeRegistry;
const tapeAbi = [
  { type:"function", name:"publishTape", stateMutability:"nonpayable",
    inputs:[{type:"uint64"},{type:"uint8"},{type:"uint16[]"},{type:"uint128[]"}], outputs:[] },
  { type:"function", name:"status", stateMutability:"view", inputs:[{type:"uint64"}],
    outputs:[{type:"bool"},{type:"bool"},{type:"bool"},{type:"uint64"}] },
  { type:"function", name:"entries", stateMutability:"view", inputs:[{type:"uint64"}],
    outputs:[{ type:"tuple[]", components:[{name:"assetId",type:"uint16"},{name:"volume",type:"uint128"}] }] },
  { type:"function", name:"tapeDelay", stateMutability:"view", inputs:[], outputs:[{type:"uint64"}] },
];

console.log("\n=== 7. the delayed tape ===");
const delay = await pub.readContract({ address: TAPE, abi: tapeAbi, functionName: "tapeDelay" });

// The reveal is the per-asset matched volume the circuit committed to — aggregates only, never
// the book. Publishing early is refused by the contract, so this genuinely has to wait.
const early = await pub.readContract({ address: TAPE, abi: tapeAbi, functionName: "status", args: [WINDOW] });
console.log(`  publishable now: ${early[1]} (delay ${delay}s)`);

const assetIds = [1, 2, 3];
const volumes = assetIds.map((id) => (id === ASSET_ID ? result.assets[0].matched : 0n));

console.log(`  waiting out the delay…`);
await new Promise((r) => setTimeout(r, Number(delay) * 1000 + 5000));

const tapeReceipt = await send({ address: TAPE, abi: tapeAbi, functionName: "publishTape",
  args: [WINDOW, 1, assetIds, volumes], gas: 3_000_000n });
console.log("  published, gas used:", tapeReceipt.gasUsed.toString());

for (const e of await pub.readContract({ address: TAPE, abi: tapeAbi, functionName: "entries", args: [WINDOW] })) {
  console.log(`    asset ${e.assetId}: ${e.volume} units crossed`);
}

// The other half of the guarantee: the numbers were fixed before anyone could choose them.
console.log("\n  checking an edited tape is refused…");
try {
  await pub.simulateContract({ account, address: TAPE, abi: tapeAbi, functionName: "publishTape",
    args: [WINDOW + 1n, 1, assetIds, volumes.map((v) => v + 1n)] });
  console.log("    UNEXPECTED: an edited tape was accepted");
} catch {
  console.log("    refused, as it must be");
}
