import { describe, expect, test, afterEach } from "bun:test";
import { generateSiweNonce } from "viem/siwe";
import {
  addressUuid,
  checkDomain,
  checkOrigin,
  clearSessionCookie,
  hashToken,
  mintSessionToken,
  mintSupabaseJwt,
  readSessionCookie,
  requestHost,
  serializeSessionCookie,
  NONCE_PATTERN,
  SESSION_COOKIE,
} from "../auth";

/**
 * The pure half of SIWE — everything that does not need a database or a chain.
 *
 * These are the parts where a mistake is silent: a cookie that works but is readable from JS, a
 * domain check that passes a substring, a JWT whose `sub` breaks Supabase's `auth.uid()`. The
 * signature verification itself is viem's and is not re-tested here.
 */

const restore: Array<() => void> = [];
function setEnv(key: string, value: string | undefined) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  });
}
afterEach(() => {
  while (restore.length) restore.pop()!();
});

describe("session cookie", () => {
  test("carries the flags that make it a session cookie rather than a bearer string", () => {
    const cookie = serializeSessionCookie("abc", 3600);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=3600");
  });

  test("is Secure in production and not on plain-http localhost", () => {
    setEnv("NODE_ENV", "production");
    expect(serializeSessionCookie("abc", 60)).toContain("Secure");
    setEnv("NODE_ENV", "development");
    expect(serializeSessionCookie("abc", 60)).not.toContain("Secure");
  });

  test("clearing sets an immediate expiry rather than a blank cookie with a live Max-Age", () => {
    expect(clearSessionCookie()).toContain("Max-Age=0");
  });

  test("reads its own cookie out of a header holding several", () => {
    const header = `other=1; ${SESSION_COOKIE}=tok3n; another=2`;
    expect(readSessionCookie(header)).toBe("tok3n");
  });

  test("a cookie of a different name is never mistaken for ours", () => {
    // The prefix match is the bug worth guarding: `arclite_session_id` must not read as
    // `arclite_session`.
    expect(readSessionCookie(`${SESSION_COOKIE}_id=nope`)).toBeNull();
    expect(readSessionCookie("x_arclite_session=nope")).toBeNull();
  });

  test("an empty or absent cookie is null, not an empty-string token", () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie("")).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });
});

describe("tokens", () => {
  test("are unpredictable and url-safe", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = mintSessionToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
  });

  test("hash to 32 bytes, deterministically, and differ for different tokens", async () => {
    const a = await hashToken("token-a");
    const b = await hashToken("token-a");
    const c = await hashToken("token-b");
    expect(a.length).toBe(32);
    expect([...a]).toEqual([...b]);
    expect([...a]).not.toEqual([...c]);
  });
});

describe("supabase jwt", () => {
  const SECRET = "test-secret-not-a-real-one";

  test("sub is a syntactically valid uuid", async () => {
    // Not cosmetic: `auth.uid()` casts sub to uuid, and a failed cast raises while evaluating
    // every RLS policy on the request — not just ours.
    const uuid = await addressUuid("0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333");
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("sub is stable per account and independent of address casing", async () => {
    const lower = await addressUuid("0xaaaabbbbccccddddeeeeffff0000111122223333");
    const upper = await addressUuid("0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333");
    const other = await addressUuid("0x1111111111111111111111111111111111111111");
    expect(lower).toBe(upper);
    expect(lower).not.toBe(other);
  });

  test("verifies under the secret, and carries the claims Supabase and our policies read", async () => {
    setEnv("SUPABASE_JWT_SECRET", SECRET);
    const expires = new Date(Date.now() + 3600_000);
    const jwt = (await mintSupabaseJwt("0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333", expires))!;
    expect(jwt).not.toBeNull();

    const [header, payload, signature] = jwt.split(".");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = Uint8Array.from(atob(signature!.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);

    const claims = JSON.parse(atob(payload!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.role).toBe("authenticated");
    expect(claims.aud).toBe("authenticated");
    // Lowercased: RLS policies compare against citext columns already normalised on write.
    expect(claims.address).toBe("0xaaaabbbbccccddddeeeeffff0000111122223333");
    expect(claims.exp).toBe(Math.floor(expires.getTime() / 1000));
  });

  test("a different secret does not verify", async () => {
    setEnv("SUPABASE_JWT_SECRET", SECRET);
    const jwt = (await mintSupabaseJwt(
      "0x1111111111111111111111111111111111111111",
      new Date(Date.now() + 1000),
    ))!;
    const [header, payload, signature] = jwt.split(".");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("a-different-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = Uint8Array.from(atob(signature!.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    expect(
      await crypto.subtle.verify(
        "HMAC",
        key,
        sigBytes,
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).toBe(false);
  });

  test("is absent rather than fatal when the secret is not configured", async () => {
    setEnv("SUPABASE_JWT_SECRET", undefined);
    expect(
      await mintSupabaseJwt("0x1111111111111111111111111111111111111111", new Date()),
    ).toBeNull();
  });
});

describe("domain binding", () => {
  test("accepts a message signed for the host it was sent to", () => {
    expect(
      checkDomain({ domain: "arclite.xyz", uri: "https://arclite.xyz/dashboard" }, "arclite.xyz")
        .ok,
    ).toBe(true);
  });

  test("rejects a signature relayed from a phishing domain", () => {
    // The whole point: the victim signed for evil.com, the attacker posts it here.
    const check = checkDomain({ domain: "evil.com", uri: "https://evil.com/" }, "arclite.xyz");
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("evil.com");
  });

  test("rejects a matching domain whose uri points somewhere else", () => {
    expect(checkDomain({ domain: "arclite.xyz", uri: "https://evil.com/" }, "arclite.xyz").ok).toBe(
      false,
    );
  });

  test("rejects a domain that merely contains ours", () => {
    expect(
      checkDomain(
        { domain: "arclite.xyz.evil.com", uri: "https://arclite.xyz.evil.com/" },
        "arclite.xyz",
      ).ok,
    ).toBe(false);
  });

  test("is case-insensitive about the host, as DNS is", () => {
    expect(
      checkDomain({ domain: "ArcLite.XYZ", uri: "https://ArcLite.XYZ/" }, "arclite.xyz").ok,
    ).toBe(true);
  });

  test("rejects a message missing either field, or with an unparseable uri", () => {
    expect(checkDomain({ uri: "https://arclite.xyz/" }, "arclite.xyz").ok).toBe(false);
    expect(checkDomain({ domain: "arclite.xyz" }, "arclite.xyz").ok).toBe(false);
    expect(checkDomain({ domain: "arclite.xyz", uri: "not a url" }, "arclite.xyz").ok).toBe(false);
  });

  test("distinguishes a port, because a different port is a different origin", () => {
    expect(
      checkDomain({ domain: "localhost:3000", uri: "http://localhost:3000/" }, "localhost:3000").ok,
    ).toBe(true);
    expect(
      checkDomain({ domain: "localhost:3000", uri: "http://localhost:3000/" }, "localhost:8080").ok,
    ).toBe(false);
  });
});

describe("request host", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://fallback.example/api/auth/verify", { headers });

  test("prefers the proxy's forwarded host", () => {
    expect(requestHost(req({ "x-forwarded-host": "arclite.xyz", host: "internal" }))).toBe(
      "arclite.xyz",
    );
  });

  test("takes the first entry of a forwarded chain", () => {
    expect(requestHost(req({ "x-forwarded-host": "arclite.xyz, internal.vercel" }))).toBe(
      "arclite.xyz",
    );
  });

  test("falls back to Host, then to the url", () => {
    expect(requestHost(req({ host: "arclite.xyz" }))).toBe("arclite.xyz");
    expect(requestHost(req({}))).toBe("fallback.example");
  });
});

describe("origin check", () => {
  const post = (origin?: string) =>
    new Request("https://arclite.xyz/api/auth/verify", {
      method: "POST",
      headers: origin ? { origin } : {},
    });

  test("allows same-origin", () => {
    expect(checkOrigin(post("https://arclite.xyz"), "arclite.xyz").ok).toBe(true);
  });

  test("blocks login CSRF from another site", () => {
    expect(checkOrigin(post("https://evil.com"), "arclite.xyz").ok).toBe(false);
  });

  test("allows a request with no Origin, so non-browser clients still work", () => {
    expect(checkOrigin(post(), "arclite.xyz").ok).toBe(true);
  });

  test("blocks a malformed Origin rather than parsing past it", () => {
    expect(checkOrigin(post("://::"), "arclite.xyz").ok).toBe(false);
  });
});

describe("nonce format", () => {
  test("what viem generates is what the schema accepts", () => {
    // These two live in different languages and different files, so nothing but this test keeps
    // them in step. The first version of the CHECK allowed 64 characters; viem emits 96, and
    // every sign-in failed on a constraint violation until a real request proved it.
    for (let i = 0; i < 50; i++) {
      const nonce = generateSiweNonce();
      expect(NONCE_PATTERN.test(nonce)).toBe(true);
    }
  });

  test("the pattern rejects what would break an EIP-4361 message", () => {
    // Whitespace or a newline in the nonce would corrupt the signed message's field structure.
    expect(NONCE_PATTERN.test("short")).toBe(false);
    expect(NONCE_PATTERN.test("has space0")).toBe(false);
    expect(NONCE_PATTERN.test("has\nnewline")).toBe(false);
    expect(NONCE_PATTERN.test("a".repeat(129))).toBe(false);
  });
});
