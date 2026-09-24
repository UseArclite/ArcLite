// The whole venue, end to end, with nothing driven by hand after the orders go in.
//
//   shield real notes -> submit sealed orders over HTTP -> wait
//
// Everything after that is the cron's: reveal, seal on chain, price on chain, match, prove,
// settle. This script is a trader and nothing else, which is the point — `settle-live.mjs`
// proves the chain flow by driving each step itself, and that is exactly what it cannot tell you
// about the venue running unattended.
//
// It is also the only test that puts real notes behind the orders. The pipeline script stops at
// matching, so its orders can name notes that were never deposited; settlement cannot.
//
//   BASE=https://arclite.tech bun scripts/venue-e2e.mjs
import postgres from "postgres";
import { createPublicClient, createWalletClient, http, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rhcTestnet, ARCLITE } from "../src/lib/chain/chains.ts";
import { commitment } from "../src/lib/notes/note.ts";
import { sealPayload } from "../src/server/orders.ts";
import { readLeafSet } from "../src/server/leaves.ts";
import { TRADERS, noteFor, payloadFor } from "./lib/book.mjs";

const BASE = process.env.BASE ?? "http://localhost:8080";
const POOL = ARCLITE[46630].pool;
const ASSET_ID = 1;
const TOKENS = {
  1: "0xB32011d2CB1D071a4c2897fE61Af443Cb88E3f73", // tNVDA, 18 decimals
  4: "0x3d62863D523027d8bC5A362Bd99186fa1eb39A14", // tUSDG, 6 decimals
};

const sql = postgres(process.env.DATABASE_URL, { prepare: false, onnotice: () => {} });
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: rhcTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: rhcTestnet, transport: http() });
// A reverted transaction still produces a receipt, so waiting alone reports success for a failed
// call. Three queued deposits once hid behind an "everything worked" log for an hour.
// Retried on a nonce collision, because this script and the production relayer share an account
// on testnet and the relayer pings the sequencer heartbeat every minute. Two senders on one
// nonce is an operational fact here, not a bug to fix in the venue — mainnet gives the relayer
// its own key, and the nonce authority is Postgres rather than the RPC.
const send = async (args, attempt = 0) => {
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(args) });
    if (receipt.status !== "success") throw new Error(`${args.functionName} reverted`);
    return receipt;
  } catch (error) {
    const racing = /nonce too low|replacement transaction|already known/i.test(error.message ?? "");
    if (!racing || attempt >= 5) throw error;
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
    return send(args, attempt + 1);
  }
};

const poolAbi = [
  {
    type: "function",
    name: "shield",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint16" },
      { type: "uint128" },
      { type: "bytes32" },
      { type: "bytes" },
      { type: "bytes32[]" },
      { type: "bytes" },
    ],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "openWindowId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "voidWindow",
    stateMutability: "nonpayable",
    inputs: [{ type: "uint64" }],
    outputs: [],
  },
  {
    type: "function",
    name: "nextLeafIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
];
const tokenAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
  },
];

// ---------------------------------------------------------------------------------------
// 1. real notes in the pool
// ---------------------------------------------------------------------------------------
console.log(`=== 1. shielding against ${POOL} ===`);

// A sealed-but-unsettled window makes `shield` queue rather than insert, so the notes would
// never reach the tree and every membership proof would fail. `voidWindow` moves no value.
const open = await pub.readContract({ address: POOL, abi: poolAbi, functionName: "openWindowId" });
if (open !== 0n) {
  console.log(`  window ${open} is still open on chain; voiding it so deposits can enter the tree`);
  await send({ address: POOL, abi: poolAbi, functionName: "voidWindow", args: [open] });
}

// A fresh window id per run, mixed into `nsecret`, so a rerun never produces a commitment
// identical to the last run's — which would be found at the *earlier* leaf and spend a note the
// trader did not just deposit.
const runSalt = BigInt(Date.now());
const traders = TRADERS.map((t) => ({ ...t, nsecret: t.nsecret + runSalt }));
const notes = traders.map((t) => noteFor(t, ASSET_ID).note);

for (const [assetId, token] of Object.entries(TOKENS)) {
  const needed = notes
    .filter((n) => n.assetId === BigInt(assetId))
    .reduce((a, n) => a + n.units, 0n);
  if (needed === 0n) continue;
  await send({
    address: token,
    abi: tokenAbi,
    functionName: "mint",
    args: [account.address, needed],
  });
  await send({ address: token, abi: tokenAbi, functionName: "approve", args: [POOL, needed] });
}
for (const note of notes) {
  await send({
    address: POOL,
    abi: poolAbi,
    functionName: "shield",
    args: [Number(note.assetId), note.units, toHex(commitment(note), { size: 32 }), "0x", [], "0x"],
  });
}

const leaves = await readLeafSet(pub, POOL, BigInt(ARCLITE[46630].deployBlock));
const leafIndexOf = notes.map((n) => {
  const at = leaves.findIndex((l) => l === commitment(n));
  if (at === -1) throw new Error("a note is not in the tree — was the deposit queued?");
  return at;
});
console.log(`  ${notes.length} notes at leaves ${leafIndexOf.join(", ")}`);
check(
  "every note reached the tree",
  leafIndexOf.every((i) => i >= 0),
);

// ---------------------------------------------------------------------------------------
// 2. orders, over HTTP, with no session
// ---------------------------------------------------------------------------------------
console.log("\n=== 2. submitting sealed orders ===");
// Wait for a window with enough time left to submit into.
//
// Shielding takes a handful of transactions, so by the time the orders are ready the window that
// was open at the start may have sealed — and an order submitted then is rejected with "window
// is past its seal time", which looks like a broken intake rather than a slow test.
let key;
for (const deadline = Date.now() + 8 * 60_000; ;) {
  key = await (await fetch(`${BASE}/api/orders/window-key`)).json();
  const left = key.sealsAt ? (Date.parse(key.sealsAt) - Date.parse(key.serverNow)) / 1000 : 0;
  if (key.publicKey && left > 60) break;
  if (Date.now() > deadline) {
    console.error("no window with room to submit into:", JSON.stringify(key));
    process.exit(1);
  }
  process.stdout.write(`\r  waiting for a fresh window (${Math.max(0, left | 0)}s left)      `);
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log("");
check(
  "the window key names the id a spend is signed against",
  typeof key.chainWindowId === "string",
  key.chainWindowId,
);
console.log(`  window seq ${key.windowSeq}, chain id ${key.chainWindowId}`);

const windowKey = Buffer.from(key.publicKey.slice(2), "hex");
const hex = (b) => `0x${Buffer.from(b).toString("hex")}`;
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

for (const [i, trader] of traders.entries()) {
  // Signed against the chain window id and the note's real leaf index. Both are what the circuit
  // checks, and both are things a signature over `seq` and a nominal index would get wrong.
  const payload = payloadFor(trader, key.chainWindowId, ASSET_ID, leafIndexOf[i]);
  const res = await fetch(`${BASE}/api/orders/submit`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      windowSeq: key.windowSeq,
      accountHash: hex(rand(32)),
      commitment: toHex(commitment(notes[i]), { size: 32 }),
      nonceHash: hex(rand(32)),
      payloadCt: hex(await sealPayload(payload, windowKey)),
    }),
  }).then((r) => r.json());
  if (!res.ok) {
    console.error(`order ${i} rejected:`, res);
    process.exit(1);
  }
}
console.log(`  submitted ${traders.length} orders`);

const stillSealed = await sql`
  select count(*)::int as n from arclite.orders o join arclite.windows w on w.id = o.window_id
   where w.seq = ${key.windowSeq}::bigint and o.asset_id is null`;
check(
  "the book is unreadable while the window is open",
  stillSealed[0].n === traders.length,
  `${stillSealed[0].n} of ${traders.length}`,
);

// ---------------------------------------------------------------------------------------
// 3. hands off
// ---------------------------------------------------------------------------------------
console.log("\n=== 3. waiting for the venue to settle it ===");
// Bring the seal forward so the run does not wait out a whole window. This is the only thing
// touched after submission, and it moves a deadline rather than a result.
await sql`
  update arclite.windows set opens_at = now() - interval '10 minutes', seals_at = now() - interval '1 second'
   where seq = ${key.windowSeq}::bigint and chain_id = 46630`;

const DEADLINE = Date.now() + 10 * 60_000;
let win;
while (Date.now() < DEADLINE) {
  const rows = await sql`
    select status, order_count, fill_count, sealed_tx, priced_tx, settled_tx,
           matcher_ran_at, chain_error, defer_mask
      from arclite.windows where seq = ${key.windowSeq}::bigint and chain_id = 46630`;
  win = rows[0];
  const stage = win.settled_tx
    ? "settled"
    : win.matcher_ran_at
      ? "matched"
      : win.priced_tx
        ? "priced"
        : win.sealed_tx
          ? "sealed"
          : win.order_count
            ? "revealed"
            : "open";
  process.stdout.write(
    `\r  ${stage}${win.chain_error ? ` — ${win.chain_error.slice(0, 80)}` : ""}          `,
  );
  if (win.settled_tx || win.chain_error) break;
  await new Promise((r) => setTimeout(r, 5_000));
}
console.log("");

check("the book was revealed", win.order_count === traders.length, `${win.order_count} orders`);
check("the window sealed on chain", win.sealed_tx !== null, win.sealed_tx ?? "none");
check("the window priced on chain", win.priced_tx !== null, `deferMask ${win.defer_mask}`);
check("the matcher ran", win.matcher_ran_at !== null);
check("the venue settled it unattended", win.settled_tx !== null, win.settled_tx ?? "none");
check("no chain error", win.chain_error === null, win.chain_error ?? "");

const fills = await sql`
  select f.seq, f.side, f.filled_raw::text as filled, f.reason from arclite.fills f
    join arclite.windows w on w.id = f.window_id
   where w.seq = ${key.windowSeq}::bigint order by f.seq`;
for (const f of fills)
  console.log(`    order ${f.seq}: ${f.side} filled ${f.filled} (${f.reason})`);

await sql.end();
console.log(failures === 0 ? "\nthe venue ran itself, start to finish" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
