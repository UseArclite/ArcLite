import { createFileRoute } from "@tanstack/react-router";
import { hasDb } from "@/server/db";
import { mintSupabaseJwt, resolveSession } from "@/server/auth";

/**
 * Who, if anyone, this browser is signed in as.
 *
 * Always 200. "Nobody" is a normal answer for a site whose market data is public, and returning
 * 401 for it would make every page load look like a failure in the logs.
 */
export const Route = createFileRoute("/api/auth/session")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const none = Response.json({ address: null }, { headers: { "cache-control": "no-store" } });
        if (!hasDb()) return none;
        try {
          const session = await resolveSession(request);
          if (!session) return none;
          return Response.json(
            {
              address: session.address,
              chainId: session.chainId,
              expiresAt: session.expiresAt.toISOString(),
              // Re-minted on read rather than stored: the JWT is short-lived and the session is
              // the authority, so a revoked session cannot keep handing out database access.
              supabaseJwt: await mintSupabaseJwt(session.address, session.expiresAt),
            },
            { headers: { "cache-control": "no-store" } },
          );
        } catch {
          return none;
        }
      },
    },
  },
});
