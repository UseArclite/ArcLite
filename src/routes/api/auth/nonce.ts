import { createFileRoute } from "@tanstack/react-router";
import { hasDb } from "@/server/db";
import { issueNonce, NONCE_TTL_SECONDS, SIWE_STATEMENT } from "@/server/auth";

/**
 * Issue a single-use SIWE nonce.
 *
 * The statement travels with it so the browser never composes the words shown in MetaMask's
 * signing prompt. The text a person reads before signing is the last line of defence against a
 * relayed signature, and it belongs on the server where it can be changed without a redeploy of
 * the client bundle.
 */
export const Route = createFileRoute("/api/auth/nonce")({
  server: {
    handlers: {
      GET: async () => {
        if (!hasDb()) {
          return Response.json(
            { error: "sign-in is unavailable: no database is configured" },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
        try {
          const { nonce, expiresAt } = await issueNonce();
          return Response.json(
            {
              nonce,
              statement: SIWE_STATEMENT,
              expiresAt: expiresAt.toISOString(),
              ttlSeconds: NONCE_TTL_SECONDS,
            },
            // A cached nonce is not a nonce.
            { headers: { "cache-control": "no-store" } },
          );
        } catch (error) {
          return Response.json(
            { error: (error as Error).message },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
