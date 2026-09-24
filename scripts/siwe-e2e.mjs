// End-to-end SIWE check against a running dev server and a real Postgres.
// Proves the properties the unit tests cannot: nonce single-use across HTTP, domain binding,
// cookie issue/resolve/revoke, and that a signature for another address is rejected.
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

// The dev server binds 8080 (the Lovable sandbox config sets host/port/strictPort).
const BASE = process.env.BASE ?? "http://localhost:8080";
const HOST = new URL(BASE).host;
// Anvil's well-known account #1. A published test key, deliberately: it must never be mistaken
// for a secret, and anyone can re-run this script without being handed one.
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function nonce() {
  const r = await fetch(`${BASE}/api/auth/nonce`);
  if (!r.ok) throw new Error(`nonce ${r.status}: ${await r.text()}`);
  return r.json();
}

function message({ n, statement, domain = HOST, uri = BASE, address = account.address, chainId = 46630 }) {
  return createSiweMessage({ address, chainId, domain, nonce: n, statement, uri, version: "1", issuedAt: new Date() });
}

async function verify(msg, sig, headers = {}) {
  const r = await fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ message: msg, signature: sig }),
  });
  return { status: r.status, body: await r.json(), cookie: r.headers.get("set-cookie") };
}

// 1. happy path
const a = await nonce();
const msgA = message({ n: a.nonce, statement: a.statement });
const sigA = await account.signMessage({ message: msgA });
const okRes = await verify(msgA, sigA);
check("a valid signature opens a session", okRes.status === 200 && okRes.body.ok === true, JSON.stringify(okRes.body).slice(0, 200));
check("the session address is the lowercased signer", okRes.body.address === account.address.toLowerCase(), okRes.body.address);
check("a session cookie is set HttpOnly", /HttpOnly/i.test(okRes.cookie ?? ""), okRes.cookie ?? "none");

const cookie = (okRes.cookie ?? "").split(";")[0];

// 2. the cookie resolves
const sess = await (await fetch(`${BASE}/api/auth/session`, { headers: { cookie } })).json();
check("the cookie resolves to the same address", sess.address === account.address.toLowerCase(), JSON.stringify(sess));

// 3. replay of the same message must fail — the nonce is spent
const replay = await verify(msgA, sigA);
check("replaying the same signature is rejected", replay.status === 401, JSON.stringify(replay.body));

// 4. domain binding: a signature for another domain, posted here
const b = await nonce();
const msgB = message({ n: b.nonce, statement: b.statement, domain: "evil.com", uri: "https://evil.com/" });
const sigB = await account.signMessage({ message: msgB });
const relayed = await verify(msgB, sigB);
check("a signature bearing another domain is rejected", relayed.status === 401 && /evil\.com/.test(relayed.body.error ?? ""), JSON.stringify(relayed.body));

// 5. wrong chain
const c = await nonce();
const msgC = message({ n: c.nonce, statement: c.statement, chainId: 1 });
const sigC = await account.signMessage({ message: msgC });
const wrongChain = await verify(msgC, sigC);
check("a signature for another chain is rejected", wrongChain.status === 401, JSON.stringify(wrongChain.body));

// 6. a signature that does not match the stated address
const d = await nonce();
const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"); // anvil #7
const msgD = message({ n: d.nonce, statement: d.statement, address: account.address });
const sigD = await other.signMessage({ message: msgD });
const impostor = await verify(msgD, sigD);
check("a signature from a different key is rejected", impostor.status === 401, JSON.stringify(impostor.body));

// 7. that rejection still burned the nonce — no second bite
const reuse = await verify(msgD, await account.signMessage({ message: msgD }));
check("the nonce is spent even when verification failed", reuse.status === 401, JSON.stringify(reuse.body));

// 8. login CSRF
const e = await nonce();
const msgE = message({ n: e.nonce, statement: e.statement });
const csrf = await verify(msgE, await account.signMessage({ message: msgE }), { origin: "https://evil.com" });
check("a cross-site Origin is refused", csrf.status === 403, JSON.stringify(csrf.body));

// 9. logout revokes server-side, not just in the browser
const out = await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { cookie } });
check("logout succeeds", out.status === 200);
const after = await (await fetch(`${BASE}/api/auth/session`, { headers: { cookie } })).json();
check("the revoked cookie no longer resolves", after.address === null, JSON.stringify(after));

console.log(failures === 0 ? "\nall siwe checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
