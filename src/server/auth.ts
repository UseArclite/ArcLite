import { createPublicClient, http, type Address } from "viem";
import { generateSiweNonce, parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { CHAINS, resolveChainId, type SupportedChainId } from "@/lib/chain/chains";
import { db } from "@/server/db";

/**
 * Sign-In With Ethereum (EIP-4361) sessions.
 *
 * What a session is for, and what it is deliberately not for:
 *
 *   for — per-account rate limiting on order intake, scoping a user's own receipts, and minting
 *         a Supabase-compatible JWT so Realtime and direct reads land inside RLS.
 *   not  — authenticating an order. Order submission carries the Schnorr signature in the sealed
 *         payload and is fetched with `credentials: 'omit'`. A cookie on that path would link a
 *         shielded order to a wallet address in our own access logs, which is the single linkage
 *         this venue exists to remove. Keep them separate; it is not an oversight.
 *
 * Three checks carry the security here, and each fails closed:
 *
 *   1. **Domain binding.** The message's `domain` must equal the Host we were actually called on.
 *      Without it a phishing site collects a signature for its own domain and relays it here.
 *      Comparing against our own Host rather than a configured constant means Vercel preview
 *      URLs work without weakening anything: a signature bearing `evil.com` never matches the
 *      host it was replayed to.
 *   2. **Single-use nonce**, enforced by a conditional UPDATE in Postgres (migration 0003).
 *      Replay protection cannot be stateless — an HMAC'd timestamp is replayable for its whole
 *      validity window.
 *   3. **Chain binding.** A signature for another chain is not a signature for this venue.
 *
 * `verifySiweMessage` recovers the signer itself and also accepts EIP-1271 smart accounts, so a
 * contract wallet works without a second code path.
 */

export const SESSION_COOKIE = "arclite_session";

/**
 * The nonce shape `arclite.auth_nonces` will accept (migration 0003).
 *
 * Duplicated here on purpose so a viem release that changes `generateSiweNonce` fails a unit
 * test instead of a CHECK constraint on a live sign-in. It already would have: the first version
 * of that constraint capped the nonce at 64 characters and viem emits 96.
 */
export const NONCE_PATTERN = /^[A-Za-z0-9]{8,128}$/;
export const NONCE_TTL_SECONDS = 10 * 60;
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Shown in MetaMask's signing prompt. The person reading it is the last line of defence. */
export const SIWE_STATEMENT =
  "Sign in to ArcLite. This proves you control this address. It does not approve any transaction, " +
  "move any funds, or submit any order.";

export interface SessionAccount {
  address: Address;
  chainId: SupportedChainId;
  expiresAt: Date;
}

// ------------------------------------------------------------------------------------------
// cookies — small enough to own, and the flags matter too much to leave to a dependency
// ------------------------------------------------------------------------------------------

export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  // HttpOnly: the token must be unreachable from page JS, including anything that ends up in the
  // bundle later. SameSite=Lax: the session is only ever used by our own fetches, and Strict
  // would drop it on a normal inbound link. Secure everywhere except plain-HTTP localhost, where
  // the browser would otherwise refuse to store it during development.
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return serializeSessionCookie("", 0);
}

export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

// ------------------------------------------------------------------------------------------
// tokens
// ------------------------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 256 bits from the CSPRNG. Long enough that guessing is not a threat model. */
export function mintSessionToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * What the database stores. A dump of `arclite.sessions` must not let the reader hold anyone's
 * session — the same reason a password table stores digests rather than passwords.
 */
export async function hashToken(token: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return new Uint8Array(digest);
}

// ------------------------------------------------------------------------------------------
// Supabase JWT
// ------------------------------------------------------------------------------------------

/**
 * A stable UUID for an address.
 *
 * Supabase's `auth.uid()` is `(claims->>'sub')::uuid`, so a `sub` that is not a UUID does not
 * merely return null — it raises, and it raises while evaluating *any* RLS policy on the
 * request, including on tables we do not own. Putting the address straight into `sub` is
 * therefore a landmine rather than a shortcut. The address travels in its own claim; `sub` gets
 * a deterministic v8 UUID derived from it, so it is stable per account and collision-free in
 * practice.
 */
export async function addressUuid(address: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`arclite:${address.toLowerCase()}`),
    ),
  );
  const b = digest.slice(0, 16);
  b[6] = (b[6]! & 0x0f) | 0x80; // version 8 — custom, per RFC 9562
  b[8] = (b[8]! & 0x3f) | 0x80; // IETF variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Mint a Supabase-compatible HS256 JWT so Realtime and direct browser reads run as
 * `authenticated` and land inside RLS rather than bypassing it.
 *
 * Returns null when `SUPABASE_JWT_SECRET` is unset — sign-in still works, the browser simply
 * has no direct database access and reads through our API instead. Degrading is correct here:
 * a missing optional secret must not make authentication fail.
 */
export async function mintSupabaseJwt(address: string, expiresAt: Date): Promise<string | null> {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return null;

  const payload = {
    sub: await addressUuid(address),
    aud: "authenticated",
    role: "authenticated",
    // RLS policies key off this, not off `sub`.
    address: address.toLowerCase(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };

  const encode = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)));
  const signing = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signing));
  return `${signing}.${base64url(new Uint8Array(mac))}`;
}

// ------------------------------------------------------------------------------------------
// request binding
// ------------------------------------------------------------------------------------------

/**
 * The host this request actually arrived on.
 *
 * `x-forwarded-host` is trusted only because on Vercel it is set by the platform's own proxy and
 * the function is not reachable except through it. Behind any other proxy this needs revisiting,
 * which is why it is one function rather than inlined at each call site.
 */
export function requestHost(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded) return forwarded.split(",")[0]!.trim().toLowerCase();
  const host = request.headers.get("host");
  if (host) return host.trim().toLowerCase();
  return new URL(request.url).host.toLowerCase();
}

export interface DomainCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Reject cross-site POSTs to the auth endpoints.
 *
 * The CSRF middleware in `src/start.ts` filters on `handlerType === 'serverFn'`, so these plain
 * HTTP routes are not covered by it. The attack it prevents here is login CSRF: a third-party
 * page silently signing a victim's browser into the *attacker's* account, so that everything the
 * victim then does is recorded against it. A missing Origin is allowed through because
 * non-browser clients omit it, and these routes are usable from a script by design.
 */
export function checkOrigin(request: Request, host: string): DomainCheck {
  const origin = request.headers.get("origin");
  if (!origin) return { ok: true };
  try {
    if (new URL(origin).host.toLowerCase() !== host) {
      return { ok: false, reason: `cross-site request from ${origin}` };
    }
  } catch {
    return { ok: false, reason: "malformed Origin header" };
  }
  return { ok: true };
}

/**
 * EIP-4361 binds a signature to a domain and a URI. Both are checked: `domain` is what the user
 * was shown in the signing prompt, and `uri` is where the signed session was meant to be used.
 * Accepting a message whose `uri` points elsewhere would let a signature intended for another
 * deployment be spent here.
 */
export function checkDomain(message: { domain?: string; uri?: string }, host: string): DomainCheck {
  if (!message.domain) return { ok: false, reason: "message has no domain" };
  if (message.domain.toLowerCase() !== host) {
    return { ok: false, reason: `message domain ${message.domain} is not ${host}` };
  }
  if (!message.uri) return { ok: false, reason: "message has no uri" };
  let uriHost: string;
  try {
    uriHost = new URL(message.uri).host.toLowerCase();
  } catch {
    return { ok: false, reason: "message uri is not a url" };
  }
  if (uriHost !== host) return { ok: false, reason: `message uri ${message.uri} is not ${host}` };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------
// the flow
// ------------------------------------------------------------------------------------------

export async function issueNonce(): Promise<{ nonce: string; expiresAt: Date }> {
  const nonce = generateSiweNonce();
  // Fail here, loudly, rather than as an opaque constraint violation one layer down.
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error(
      `generateSiweNonce produced a nonce the schema will not accept: ${nonce.length} chars`,
    );
  }
  const sql = db();
  const rows = await sql<{ issue_nonce: Date }[]>`
    select arclite.issue_nonce(${nonce}, ${NONCE_TTL_SECONDS})
  `;
  return { nonce, expiresAt: rows[0]!.issue_nonce };
}

export type VerifyResult =
  | { ok: true; address: Address; token: string; expiresAt: Date; supabaseJwt: string | null }
  | { ok: false; error: string };

export async function verifyAndOpenSession(
  request: Request,
  message: string,
  signature: `0x${string}`,
): Promise<VerifyResult> {
  const chainId = resolveChainId();

  let parsed: ReturnType<typeof parseSiweMessage>;
  try {
    parsed = parseSiweMessage(message);
  } catch {
    return { ok: false, error: "message is not a valid EIP-4361 message" };
  }

  const domain = checkDomain(parsed, requestHost(request));
  if (!domain.ok) return { ok: false, error: domain.reason! };

  if (parsed.chainId !== chainId) {
    return { ok: false, error: `message is for chain ${parsed.chainId}, not ${chainId}` };
  }
  if (!parsed.address) return { ok: false, error: "message has no address" };
  if (!parsed.nonce) return { ok: false, error: "message has no nonce" };

  // Claim the nonce **before** verifying the signature. Verification can touch the chain for an
  // EIP-1271 wallet, so doing it first would let an attacker hold a nonce open across a slow RPC
  // call and race a second verify through it. Burning the nonce first costs an honest user
  // nothing: a failed signature just means fetching a new one.
  const sql = db();
  const claimed = await sql<{ consume_nonce: boolean | null }[]>`
    select arclite.consume_nonce(${parsed.nonce})
  `;
  if (claimed[0]?.consume_nonce !== true) {
    return { ok: false, error: "nonce is unknown, expired, or already used" };
  }

  const chain = CHAINS[chainId];
  const client = createPublicClient({ chain, transport: http() });

  let valid = false;
  try {
    valid = await verifySiweMessage(client, { message, signature });
  } catch (error) {
    return { ok: false, error: `signature could not be verified: ${(error as Error).message}` };
  }
  if (!valid) return { ok: false, error: "signature does not match the message" };

  const address = parsed.address.toLowerCase() as Address;
  const token = mintSessionToken();
  const rows = await sql<{ open_session: Date }[]>`
    select arclite.open_session(
      ${Buffer.from(await hashToken(token))}, ${address}, ${chainId}, ${SESSION_TTL_SECONDS}
    )
  `;
  const expiresAt = rows[0]!.open_session;

  return {
    ok: true,
    address,
    token,
    expiresAt,
    supabaseJwt: await mintSupabaseJwt(address, expiresAt),
  };
}

/** Resolve the cookie on a request to an account, or null. One round trip. */
export async function resolveSession(request: Request): Promise<SessionAccount | null> {
  const token = readSessionCookie(request.headers.get("cookie"));
  if (!token) return null;
  const sql = db();
  const rows = await sql<{ address: string; chain_id: number; expires_at: Date }[]>`
    select address, chain_id, expires_at from arclite.session_account(${Buffer.from(await hashToken(token))})
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    address: row.address.toLowerCase() as Address,
    chainId: row.chain_id as SupportedChainId,
    expiresAt: row.expires_at,
  };
}

export async function closeSession(request: Request): Promise<void> {
  const token = readSessionCookie(request.headers.get("cookie"));
  if (!token) return;
  const sql = db();
  await sql`select arclite.revoke_session(${Buffer.from(await hashToken(token))})`;
}
