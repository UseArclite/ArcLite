import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { hasDb } from "@/server/db";
import { currentWindow } from "@/server/windows";

/**
 * The live batch window — the server-side clock that replaces the dashboard's setTimeout chain.
 *
 * Includes `serverNow` so the countdown is anchored to the server rather than to a client clock
 * that may be minutes off; without it two browsers disagree about the same auction.
 */
export const Route = createFileRoute("/api/market/window")({
  server: {
    handlers: {
      GET: async () => {
        if (!hasDb()) {
          return Response.json({ window: null, reason: "no_database" }, { status: 200 });
        }
        try {
          const window = await currentWindow(resolveChainId());
          return new Response(JSON.stringify({ window }), {
            headers: {
              "content-type": "application/json",
              // Short: the countdown is the point. Realtime supersedes this later.
              "cache-control": "public, s-maxage=2, stale-while-revalidate=10",
            },
          });
        } catch (error) {
          return Response.json(
            { window: null, error: (error as Error).message },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
