"use client";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { clientChainId } from "@/lib/chain/chains";
import { useT } from "../lib/i18n";

/**
 * Why this asset stopped, when the reason is its own supply.
 *
 * A blackout reaches the trader as `EVENT_WINDOW` — the contract's calendar flag — and that
 * reads as a corporate action, because until now it only ever was one. A supply drift wearing a
 * corporate action's label would be the worst kind of wrong: reassuring, and about the one event
 * class where reassurance is misplaced. So the reason is fetched and said plainly.
 *
 * The wording lives in the database rather than on chain because `EventCalendar`'s reason codes
 * predate this guard and the contract is immutable. The chain knows the asset is blacked out;
 * this says what the venue observed.
 *
 * Renders nothing when nothing is wrong, which is almost always.
 */
export function SupplyNotice({ symbol }: { symbol: string }) {
  const t = useT();
  const chainId = clientChainId();

  // The registry id-to-symbol map, under the key the vault and the crossing line already use, so
  // all three share one response rather than fetching it three times.
  const { data: poolAssets } = useQuery({
    queryKey: ["pool-assets", chainId],
    queryFn: async () => {
      const res = await fetch("/api/pool/assets", { credentials: "omit" });
      const body = (await res.json()) as { assets?: { assetId: number; symbol: string }[] };
      return body.assets ?? [];
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const { data } = useQuery({
    queryKey: ["supply-drift", chainId],
    queryFn: async () => {
      const res = await fetch("/api/market/supply", { credentials: "omit" });
      const body = (await res.json()) as {
        drifted?: { assetId: number; driftBps: number; reason: string | null; since: string }[];
      };
      return body.drifted ?? [];
    },
    // A safety signal. Short enough that a trader looking at a paused asset is not reading a
    // minute-old verdict, long enough that it costs nothing.
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  const assetId = (poolAssets ?? []).find((a) => a.symbol === symbol)?.assetId;
  if (assetId === undefined) return null;
  const hit = (data ?? []).find((d) => d.assetId === assetId);
  if (!hit) return null;

  return (
    <div className="guard-result deferred supply-notice" role="alert">
      <AlertTriangle size={16} />
      <span>
        <b>{t("Supply changed")}</b>
        {hit.reason ? ` ${hit.reason}` : ""}{" "}
        {t(
          "This asset is blacked out on chain until it is checked. Withdrawals are unaffected — they always are.",
        )}
      </span>
    </div>
  );
}
