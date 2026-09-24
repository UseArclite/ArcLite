"use client";
import { useQuery } from "@tanstack/react-query";
import { Repeat2 } from "lucide-react";
import { clientChainId } from "@/lib/chain/chains";
import { describeCrossing } from "../lib/crossing-history";
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

  return (
    <p
      className={"crossing-line" + (line.hasCrossed ? " has-crossed" : "")}
      title={t("Observed history, not a forecast.")}
    >
      <Repeat2 size={13} aria-hidden="true" />
      {line.text}
    </p>
  );
}
