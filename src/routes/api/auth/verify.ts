import { createFileRoute } from "@tanstack/react-router";
import { hasDb } from "@/server/db";
import {
  checkOrigin,
  requestHost,
  serializeSessionCookie,
  SESSION_TTL_SECONDS,
  verifyAndOpenSession,
} from "@/server/auth";

/**
 * Exchange a signed EIP-4361 message for a session.
 *
 * Every rejection returns the same shape and a 401, and the reason is specific because none of
 * these reasons help an attacker: they already know whether they hold a valid signature. Vague
 * errors here would cost a real user an afternoon.
 */
export const Route = createFileRoute("/api/auth/verify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const deny = (error: string, status = 401) =>
          Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });

        if (!hasDb()) return deny("sign-in is unavailable: no database is configured", 503);

        const origin = checkOrigin(request, requestHost(request));
        if (!origin.ok) return deny(origin.reason!, 403);

        let body: { message?: unknown; signature?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return deny("body is not json", 400);
        }
        if (typeof body.message !== "string" || typeof body.signature !== "string") {
          return deny("expected { message, signature }", 400);
        }
        // A signature is 65 bytes; an EIP-1271 one can be longer but not unboundedly so. This is
        // a cheap guard against a body that exists only to be expensive to parse.
        if (body.message.length > 4096 || body.signature.length > 8192) {
          return deny("message or signature is implausibly large", 413);
        }
        if (!/^0x[0-9a-fA-F]*$/.test(body.signature)) return deny("signature is not hex", 400);

        try {
          const result = await verifyAndOpenSession(
            request,
            body.message,
            body.signature as `0x${string}`,
          );
          if (!result.ok) return deny(result.error);

          return Response.json(
            {
              ok: true,
              address: result.address,
              expiresAt: result.expiresAt.toISOString(),
              supabaseJwt: result.supabaseJwt,
            },
            {
              headers: {
                "cache-control": "no-store",
                "set-cookie": serializeSessionCookie(result.token, SESSION_TTL_SECONDS),
              },
            },
          );
        } catch (error) {
          return deny((error as Error).message, 500);
        }
      },
    },
  },
});
