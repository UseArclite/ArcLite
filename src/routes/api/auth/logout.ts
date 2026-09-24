import { createFileRoute } from "@tanstack/react-router";
import { checkOrigin, clearSessionCookie, closeSession, requestHost } from "@/server/auth";
import { hasDb } from "@/server/db";

/**
 * End the session, server-side as well as in the browser.
 *
 * The cookie is cleared even when the database revoke fails. A logout that appears to succeed
 * but leaves the browser holding a live token is worse than either outcome on its own, and the
 * row expires on its own schedule regardless.
 */
export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const origin = checkOrigin(request, requestHost(request));
        if (!origin.ok) {
          return Response.json(
            { ok: false, error: origin.reason },
            { status: 403, headers: { "cache-control": "no-store" } },
          );
        }
        let revoked = true;
        if (hasDb()) {
          try {
            await closeSession(request);
          } catch {
            revoked = false;
          }
        }
        return Response.json(
          { ok: true, revoked },
          { headers: { "cache-control": "no-store", "set-cookie": clearSessionCookie() } },
        );
      },
    },
  },
});
