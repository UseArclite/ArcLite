import { createFileRoute } from "@tanstack/react-router";
import { resolveChainId } from "@/lib/chain/chains";
import { getSeries, type Range } from "@/lib/chain/series";

/**
 * Reference-price history for the 1D/1W/1M chart.
 *
 * Reads historical Chainlink rounds directly, so the chart is real without a database. Returns a
 * pre-rendered `polyline` in the existing SVG's coordinate space, which keeps the chart markup
 * and its gradient untouched.
 */

const RANGES = new Set<Range>(["1D", "1W", "1M"]);

export const Route = createFileRoute("/api/market/series")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        // Not upper-cased. Symbols were assumed to be, which is true of every mainnet ticker
        // and false of the testnet stand-ins — `tNVDA` became `TNVDA` and matched nothing, so
        // the chart came back "not an eligible asset" for an asset the market snapshot lists.
        const symbol = (url.searchParams.get("symbol") ?? "").trim();
        const range = (url.searchParams.get("range") ?? "1D") as Range;

        if (!/^[A-Za-z0-9.]{1,12}$/.test(symbol)) {
          return Response.json({ error: "bad_symbol" }, { status: 400 });
        }
        if (!RANGES.has(range)) {
          return Response.json({ error: "bad_range" }, { status: 400 });
        }

        try {
          const series = await getSeries(resolveChainId(), symbol, range);
          return new Response(JSON.stringify(series), {
            headers: {
              "content-type": "application/json",
              // 1D moves with the feed; the longer ranges barely move within a minute.
              "cache-control":
                range === "1D"
                  ? "public, s-maxage=30, stale-while-revalidate=120"
                  : "public, s-maxage=300, stale-while-revalidate=900",
            },
          });
        } catch (error) {
          return Response.json(
            { error: "series_unavailable", message: (error as Error).message },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
