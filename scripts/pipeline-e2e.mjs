// The whole server pipeline, against a running server, a real Postgres, and the live chain.
//
//   submit sealed orders -> tick -> reveal -> seal on chain -> price on chain -> match
//
// Everything after submission is driven by the cron, not by this script. The point is that the
// venue runs itself: the only thing done by hand here is being a trader.
//
//   bun scripts/pipeline-e2e.mjs
import postgres from "postgres";
import { sealPayload } from "../src/server/orders.ts";
import { TRADERS, UNIT, payloadFor } from "./lib/book.mjs";

const BASE = process.env.BASE ?? "http://localhost:8080";
const sql = postgres(process.env.DATABASE_URL, { prepare: false, ssl: false, onnotice: () => {} });

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const hex = (b) => `0x${Buffer.from(b).toString("hex")}`;
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const tick = () => fetch(`${BASE}/api/cron/tick`).then((r) => r.json());
const unlock = () => sql`update arclite.cron_locks set lease_until = now() where name = 'tick'`;

await tick();
await unlock();

const key = await (await fetch(`${BASE}/api/orders/window-key`)).json();
if (!key.publicKey) { console.error("no open window:", JSON.stringify(key)); process.exit(1); }
console.log(`window ${key.windowSeq}`);

// Two buyers and a seller of asset 1, so the crossing has a shared side and pro-rata bites.
// Signed, quote-funded and at real decimals — see scripts/lib/book.mjs for why each of those
// three matters.
const book = TRADERS.map((t, i) => payloadFor(t, key.windowSeq, 1, i));

for (const order of book) {
  const res = await fetch(`${BASE}/api/orders/submit`, {
    method: "POST", credentials: "omit",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      windowSeq: key.windowSeq, accountHash: hex(rand(32)), commitment: hex(rand(32)),
      nonceHash: hex(rand(32)),
      payloadCt: hex(await sealPayload(order, Buffer.from(key.publicKey.slice(2), "hex"))),
    }),
  }).then((r) => r.json());
  if (!res.ok) { console.error("submit failed:", res); process.exit(1); }
}
console.log(`submitted ${book.length} sealed orders\n`);

// Nothing is readable yet. This is the property the whole intake design exists for.
const sealed = await sql`
  select count(*)::int as n from arclite.orders o
    join arclite.windows w on w.id = o.window_id
   where w.seq = ${key.windowSeq}::bigint and o.asset_id is null`;
check("the book is unreadable while the window is open", sealed[0].n === book.length,
  `${sealed[0].n} of ${book.length} still sealed`);

// Close the book and let the tick do the rest.
await sql`
  update arclite.windows
     set opens_at = now() - interval '10 minutes', seals_at = now() - interval '1 second'
   where seq = ${key.windowSeq}::bigint and chain_id = 46630`;

for (let i = 0; i < 4; i++) {
  await unlock();
  const t = await tick();
  console.log(`tick ${i + 1}: reveal=${JSON.stringify(t.reveal)} chain=${JSON.stringify(t.chain)} match=${JSON.stringify(t.match)}`);
  if (t.match?.matched > 0) break;
}

const w = await sql`
  select status, order_count, fill_count, gross_value,
         encode(orders_root,'hex') as orders_root, encode(prices_root,'hex') as prices_root,
         sealed_tx, chain_reconciled, priced_tx, priced_at, defer_mask, chain_error
    from arclite.windows where seq = ${key.windowSeq}::bigint and chain_id = 46630`;
const win = w[0];
console.log("");
check("the book was revealed", win.orders_root !== null, `root 0x${(win.orders_root ?? "").slice(0, 16)}…`);
// Either we sealed it, or we found it already sealed and reconciled. Both are "the chain knows
// about this window"; only an invented hash would make them look the same.
check("the window sealed on chain", win.sealed_tx !== null || win.chain_reconciled,
  win.sealed_tx ?? (win.chain_reconciled ? "reconciled" : "none"));
check("the window priced on chain", win.priced_at !== null, `deferMask ${win.defer_mask}`);
check("no chain error", win.chain_error === null, win.chain_error ?? "");

const fills = await sql`
  select f.seq, f.side, f.quantity_raw::text as q, f.filled_raw::text as f, f.reason
    from arclite.fills f join arclite.windows w on w.id = f.window_id
   where w.seq = ${key.windowSeq}::bigint order by f.seq`;
for (const f of fills) console.log(`    order ${f.seq}: ${f.side} ${f.q} -> filled ${f.f} (${f.reason})`);

check("every order got a fill", fills.length === book.length, `${fills.length} fills`);

const deferred = win.defer_mask !== null && BigInt(win.defer_mask) !== 0n;
if (deferred) {
  // Correct behaviour, not a failure: a guarded asset crosses nothing, and the fills must say so
  // rather than quietly reporting zero with a misleading reason.
  check("a deferred asset crossed nothing and says why",
    fills.every((f) => f.f === "0" && (f.reason === "stale" || f.reason === "event")),
    fills.map((f) => f.reason).join(","));
} else {
  const buys = fills.filter((f) => f.side === "buy").reduce((a, f) => a + BigInt(f.f), 0n);
  const sells = fills.filter((f) => f.side === "sell").reduce((a, f) => a + BigInt(f.f), 0n);
  check("buys and sells filled each other exactly", buys === sells, `${buys} vs ${sells}`);
  check("the smaller side filled completely", sells === 20n * UNIT, `${sells}`);
  check("pro-rata split the shared side 15/5",
    fills.filter((f) => f.side === "buy").map((f) => f.f).join(",") ===
      [15n * UNIT, 5n * UNIT].join(","),
    fills.filter((f) => f.side === "buy").map((f) => f.f).join(","));
}

await sql.end();
console.log(failures === 0 ? "\nthe pipeline ran itself" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
