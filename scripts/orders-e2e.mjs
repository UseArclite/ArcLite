// Sealed order intake, end to end against a running server and a real Postgres.
//
// Proves the properties unit tests cannot: that an order can be submitted without a session,
// that the server accepts it without decrypting it, that the rate limit and duplicate-note
// checks bind over HTTP, and — the one that matters — that revealing the book produces the
// orders root `batch_cross` computes from the same orders.
//
//   bun scripts/orders-e2e.mjs
import { x25519 } from "@noble/curves/ed25519";
import { sealPayload, ordersRoot, revealWindow } from "../src/server/orders.ts";
import { TRADERS, UNIT, payloadFor } from "./lib/book.mjs";

const BASE = process.env.BASE ?? "http://localhost:8080";
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const hex = (b) => `0x${Buffer.from(b).toString("hex")}`;
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

const keyRes = await fetch(`${BASE}/api/orders/window-key`);
const key = await keyRes.json();
if (!key.publicKey) {
  console.error("no open window:", JSON.stringify(key));
  process.exit(1);
}
console.log(`window ${key.windowSeq}, seal mode ${key.sealMode}`);
check("the seal mode is stated, not implied", typeof key.sealNote === "string" && key.sealNote.length > 40);
check("KEYPAIR mode admits the operator can decrypt",
  key.sealMode !== "KEYPAIR" || /does not keep it from the operator/.test(key.sealNote),
  key.sealNote?.slice(0, 70));

const windowKey = Buffer.from(key.publicKey.slice(2), "hex");

// Signed, quote-funded and at real decimals — see scripts/lib/book.mjs for why each matters.
const book = TRADERS.map((t, i) => payloadFor(t, key.windowSeq, 1, i));

const submit = (body) =>
  fetch(`${BASE}/api/orders/submit`, {
    method: "POST",
    // No cookie, deliberately: a session here would put the address-to-order link in our logs.
    credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const commitments = [];
for (const [i, order] of book.entries()) {
  const commitment = hex(rand(32));
  commitments.push(commitment);
  const sealed = await sealPayload(order, windowKey);
  const res = await submit({
    windowSeq: key.windowSeq,
    accountHash: hex(rand(32)),
    commitment,
    nonceHash: hex(rand(32)),
    payloadCt: hex(sealed),
  });
  check(`order ${i} accepted`, res.status === 200 && res.body.ok === true, JSON.stringify(res.body));
}

// A note may be offered once, ever.
const dup = await submit({
  windowSeq: key.windowSeq, accountHash: hex(rand(32)), commitment: commitments[0],
  nonceHash: hex(rand(32)), payloadCt: hex(await sealPayload(book[0], windowKey)),
});
check("a repeated note is refused", dup.status === 409 && /already been offered/.test(dup.body.reason ?? ""),
  JSON.stringify(dup.body));

// Rate limit, per account per window.
const account = hex(rand(32));
let accepted = 0;
for (let i = 0; i < 10; i++) {
  const res = await submit({
    windowSeq: key.windowSeq, accountHash: account, commitment: hex(rand(32)),
    nonceHash: hex(rand(32)), payloadCt: hex(await sealPayload(book[0], windowKey)),
  });
  if (res.status === 200) accepted++;
}
check("the rate limit binds over HTTP", accepted === 8, `accepted ${accepted} of 10`);

// Malformed input is refused before it reaches Postgres.
const bad = await submit({ windowSeq: key.windowSeq, accountHash: "0xnope", commitment: commitments[0],
  nonceHash: hex(rand(32)), payloadCt: "0x00" });
check("a malformed account hash is refused", bad.status === 400, JSON.stringify(bad.body));

const junk = await submit({
  windowSeq: key.windowSeq, accountHash: hex(rand(32)), commitment: hex(rand(32)),
  nonceHash: hex(rand(32)), payloadCt: hex(rand(120)),
});
check("random bytes are accepted as a payload (the server cannot read it)", junk.status === 200,
  "this is the point: acceptance cannot depend on decrypting");

// Reveal, and compare against what batch_cross would compute.
const windowId = process.env.WINDOW_ROW_ID;
const revealed = await revealWindow(windowId, BigInt(key.windowSeq));
console.log(`\nrevealed ${revealed.revealed}, rejected ${revealed.rejected}`);
check("the undecryptable order was rejected, not dropped", revealed.rejected >= 1,
  `${revealed.rejected} rejected`);

const expected = ordersRoot(BigInt(key.windowSeq), 0n, [
  ...book.map((o) => ({ assetId: o.assetId, side: o.side, quantity: BigInt(o.quantity), owner: BigInt(o.owner), salt: BigInt(o.salt) })),
  ...Array.from({ length: 8 }, () => ({ assetId: 1, side: "buy", quantity: 30n * UNIT, owner: BigInt(book[0].owner), salt: 555n })),
]);
check("the revealed book hashes to the root batch_cross computes",
  revealed.ordersRoot === `0x${expected.toString(16).padStart(64, "0")}`,
  `${revealed.ordersRoot} vs 0x${expected.toString(16).padStart(64, "0")}`);

console.log(failures === 0 ? "\nall order intake checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
