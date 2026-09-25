"use client";
import { useQuery } from "@tanstack/react-query";
import { Droplets, Repeat2 } from "lucide-react";
import { clientChainId } from "@/lib/chain/chains";
import { describeCrossing } from "../lib/crossing-history";
import { describeLitMarket } from "../lib/lit-market";
import { feature } from "../lib/features";
import { useT } from "../lib/i18n";

/**
 * Whether this asset has ever actually crossed.
 *
 * `unmatched` is the expected outcome on a young venue and the dashboard only ever said so
 * afterwards, in the receipts panel, apologising for a fill that never came. This is the same
 * fact before the order is submitted, which is the only point at which it can change anything.
 *
 * Two fetches, both already paid for elsewhere. `/api/pool/assets` is the registry id-to-symbol
 * map the vault loads under this exact query key, so mounting this does not fetch it twice;
 * `/api/market/crossing` is a database aggregate cached for a minute, which is well inside a
 * five-minute window.
 *
 * Renders nothing rather than something vague when either is unavailable. A market panel with no
 * crossing line is a panel missing a line; a market panel guessing at one is worse.
 */
export function CrossingLine({ symbol }: { symbol: string }) {
  const t = useT();
  const chainId = clientChainId();

  const { data: poolAssets } = useQuery({
    // Deliberately the same key the vault uses, so the two share one response.
    queryKey: ["pool-assets", chainId],
    queryFn: async () => {
      const res = await fetch("/api/pool/assets", { credentials: "omit" });
      const body = (await res.json()) as { assets?: { assetId: number; symbol: string }[] };
      return body.assets ?? [];
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Lit depth on the public DEX. Fetched alongside the crossing record because the two only
  // mean something together: "never crossed here" and "$3.6M of liquidity next door" is a
  // different message from either half on its own.
  const showLit = feature("lit-depth");
  const { data: depth } = useQuery({
    queryKey: ["lit-depth", chainId],
    enabled: showLit,
    queryFn: async () => {
      const res = await fetch("/api/market/depth", { credentials: "omit" });
      return (await res.json()) as {
        quote?: { symbol?: string; decimals?: number };
        depth?: { symbol: string; quoteRaw: string; feeTier: number }[];
      };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const { data: history } = useQuery({
    queryKey: ["crossing-history", chainId],
    queryFn: async () => {
      const res = await fetch("/api/market/crossing", { credentials: "omit" });
      const body = (await res.json()) as {
        assets?: { assetId: number; booked: number; crossed: number; lastCrossAt: string | null }[];
      };
      return body.assets ?? [];
    },
    staleTime: 60_000,
    retry: false,
  });

  if (!poolAssets || !history) return null;

  const assetId = poolAssets.find((a) => a.symbol === symbol)?.assetId;
  // Not registered in this pool is not the same as never crossed, and saying the latter would be
  // wrong rather than merely unhelpful.
  if (assetId === undefined) return null;

  const row = history.find((h) => h.assetId === assetId);
  const line = describeCrossing({
    symbol,
    booked: row?.booked ?? 0,
    crossed: row?.crossed ?? 0,
    lastCrossAt: row?.lastCrossAt ?? null,
  });

  // Only claim the absence of a lit market once the endpoint has actually answered — a pending
  // fetch and a genuinely unlisted asset must not produce the same sentence.
  const pool = depth?.depth?.find((d) => d.symbol === symbol);
  const lit = showLit && depth
    ? describeLitMarket({
        symbol,
        quoteRaw: pool?.quoteRaw ?? null,
        quoteDecimals: depth.quote?.decimals ?? 6,
        feeTier: pool?.feeTier ?? null,
      })
    : null;

  return (
    <>
      <p
        className={"crossing-line" + (line.hasCrossed ? " has-crossed" : "")}
        title={t("Observed history, not a forecast.")}
      >
        <Repeat2 size={13} aria-hidden="true" />
        {line.text}
      </p>
      {lit?.text && (
        <p
          className={"crossing-line lit-line" + (lit.hasMarket ? " has-market" : "")}
          title={t("Read from the public DEX on this chain, not from any third-party feed.")}
        >
          <Droplets size={13} aria-hidden="true" />
          {lit.text}
        </p>
      )}
    </>
  );
}
