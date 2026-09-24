/**
 * Who is allowed to drive the venue's clock.
 *
 * The cron routes are not read-only. `/api/cron/tick` reveals sealed books, matches them, and
 * drives proving and settlement; `/api/cron/oracle` writes the price observations those windows
 * are matched against. They are the venue's lifecycle, exposed on the public internet because
 * that is how a scheduler reaches a serverless function.
 *
 * ## The bug this replaces
 *
 * Both routes authenticated like this:
 *
 *     const secret = process.env.CRON_SECRET;
 *     if (secret && auth !== `Bearer ${secret}`) return 401;
 *
 * which is only a check when the secret is set. With `CRON_SECRET` absent — a fresh preview, a
 * renamed variable, a deploy that dropped it — the condition short-circuits and **every
 * unauthenticated caller is allowed through**. The failure is silent in the direction that
 * matters: the venue keeps running, the crons keep working, and nothing looks wrong.
 *
 * A missing secret is therefore treated as a configuration failure and refused, not as an
 * absence of policy. Fail closed: the venue stops advancing, which is loud, recoverable, and
 * spends nothing.
 */

/** Long enough that guessing is hopeless. Vercel's generated secret is far longer. */
const MIN_SECRET_LENGTH = 16;

export type CronAuth = { ok: true } | { ok: false; response: Response };

/**
 * Compare without leaking where two strings first differ.
 *
 * `a !== b` returns as soon as it finds a mismatched byte, so the time it takes is a function of
 * the shared prefix. Remote timing attacks over HTTP are noisy and this is not the weakest link
 * here, but a constant-time compare costs nothing and removes the question.
 *
 * Length is compared first and deliberately not hidden — it is not the secret.
 */
function equals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Authorise a scheduled invocation.
 *
 * Returns the response to send rather than throwing, so a route reads as a straight line and a
 * caller cannot accidentally swallow the rejection in a `catch`.
 */
export function authorizeCron(request: Request, env: NodeJS.ProcessEnv = process.env): CronAuth {
  const secret = env.CRON_SECRET;

  // 503, not 401. The caller may be perfectly legitimate; it is the deployment that is wrong,
  // and an operator reading a 401 would go looking for a bad scheduler instead of a missing
  // variable. It also cannot be mistaken for a rejected guess in the logs.
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: "cron_not_configured",
          message: !secret
            ? "CRON_SECRET is not set, so scheduled work is refused rather than run unauthenticated."
            : `CRON_SECRET is shorter than ${MIN_SECRET_LENGTH} characters.`,
        }),
        {
          status: 503,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        },
      ),
    };
  }

  const auth = request.headers.get("authorization");
  if (!auth || !equals(auth, `Bearer ${secret}`)) {
    return {
      ok: false,
      response: new Response("unauthorized", {
        status: 401,
        headers: { "cache-control": "no-store" },
      }),
    };
  }

  return { ok: true };
}

/** Whether the deployment is configured to run scheduled work at all. For `/api/health`. */
export function cronConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = env.CRON_SECRET;
  return Boolean(secret && secret.length >= MIN_SECRET_LENGTH);
}
