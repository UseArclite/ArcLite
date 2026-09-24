import { describe, expect, test } from "bun:test";
import { authorizeCron, cronConfigured } from "../cron-auth";

/**
 * The regression this file exists for.
 *
 * Both cron routes authenticated with `if (secret && auth !== ...) return 401`, which is only a
 * check when the secret is set. With `CRON_SECRET` absent the condition short-circuits and every
 * anonymous caller is allowed through — to `/api/cron/tick`, which reveals sealed books, matches
 * them, and drives proving and settlement.
 *
 * So the case that matters is not the wrong password. It is the missing one, and it is the case
 * the old code got backwards.
 */

const SECRET = "a-long-enough-cron-secret-value";
const req = (auth?: string) =>
  new Request(
    "https://example.test/api/cron/tick",
    auth ? { headers: { authorization: auth } } : undefined,
  );

describe("when the deployment has no usable secret", () => {
  test("an unauthenticated call is refused rather than run — the bug, stated directly", () => {
    const r = authorizeCron(req(), {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
  });

  test("and so is one that supplies any header at all", () => {
    // There is nothing to compare against, so no header can be right. The old code let *both*
    // of these through.
    expect(authorizeCron(req("Bearer anything"), {} as NodeJS.ProcessEnv).ok).toBe(false);
    expect(authorizeCron(req("Bearer "), {} as NodeJS.ProcessEnv).ok).toBe(false);
  });

  test("it answers 503, not 401 — the caller may be fine, the deployment is not", async () => {
    const r = authorizeCron(req(), {} as NodeJS.ProcessEnv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(503);
    // An operator reading a 401 would go looking for a broken scheduler instead of a missing
    // variable, so the body names the variable.
    expect(await r.response.text()).toContain("CRON_SECRET");
  });

  test("an empty secret is a missing one", () => {
    expect(authorizeCron(req("Bearer "), { CRON_SECRET: "" } as NodeJS.ProcessEnv).ok).toBe(false);
  });

  test("a short secret is refused rather than guarded against", () => {
    const weak = { CRON_SECRET: "short" } as NodeJS.ProcessEnv;
    expect(authorizeCron(req("Bearer short"), weak).ok).toBe(false);
    expect(cronConfigured(weak)).toBe(false);
  });
});

describe("when the secret is set", () => {
  const env = { CRON_SECRET: SECRET } as NodeJS.ProcessEnv;

  test("the scheduler's own header is accepted", () => {
    expect(authorizeCron(req(`Bearer ${SECRET}`), env).ok).toBe(true);
  });

  test("a missing header is refused", async () => {
    const r = authorizeCron(req(), env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  test("a wrong secret is refused", () => {
    expect(authorizeCron(req(`Bearer ${SECRET}x`), env).ok).toBe(false);
    expect(authorizeCron(req("Bearer " + "b".repeat(SECRET.length)), env).ok).toBe(false);
  });

  test("the scheme is part of the comparison", () => {
    // `Bearer <secret>` is compared whole, so the bare value is not a credential.
    expect(authorizeCron(req(SECRET), env).ok).toBe(false);
    expect(authorizeCron(req(`bearer ${SECRET}`), env).ok).toBe(false);
  });

  test("a prefix of the secret is refused", () => {
    // The constant-time compare returns false on a length mismatch before comparing content,
    // which is the case a naive early-exit would answer fastest.
    expect(authorizeCron(req(`Bearer ${SECRET.slice(0, -1)}`), env).ok).toBe(false);
  });

  test("cronConfigured agrees with what the routes will do", () => {
    expect(cronConfigured(env)).toBe(true);
  });
});
