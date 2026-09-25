import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { venueRecord } from "@/server/venue-record";

/**
 * The venue's cumulative record, for anyone.
 *
 * Aggregate only — counts over `windows`, `fills` and `window_assets_matched`, none of which is
 * per-account. A public record that leaked which account did what would be the one kind of
 * transparency this product cannot offer, so the shape of the response is the guarantee: there is
 * no field here that could carry it.
 *
 * Cached for five minutes. These figures move on the order of windows, and a page somebody opens
 * when they are *not* trading does not need fresher.
 */
export const Route = createFileRoute("/api/market/record")({
  server: {
    handlers: {
      GET: async () => {
        const chainId = resolveChainId();
        try {
          const record = await venueRecord(chainId);
          return new Response(JSON.stringify({ chainId, record }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "public, s-maxage=300, stale-while-revalidate=900",
            },
          });
        } catch (error) {
          return Response.json(
            { chainId, record: null, error: (error as Error).message },
            { status: 200, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
