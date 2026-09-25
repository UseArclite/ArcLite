"use client";
import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { venueStatus, type StatusInput } from "../lib/venue-status";
import { useT } from "../lib/i18n";

/**
 * The venue's own alarms, published.
 *
 * Several controls here are invisible when they work — the tick advancing windows, the oracle
 * writing guards, the supply watcher checking 35 token supplies a minute, a breaker that can
 * black an asset out on chain. Correct behaviour renders as nothing, which is right and is also
 * a bad answer to "is this running".
 *
 * The row that earns the panel is **Deposits**. When a window is stuck, `shield` queues a deposit
 * instead of entering it into the tree: the funds are in the pool, the note is coming, and from
 * the outside it is indistinguishable from a slow confirmation. Nobody could tell those apart
 * before this.
 *
 * Reads `/api/status`, never `/api/health` — the latter is the operator's view and carries
 * things that would tell a reader when this venue stalls. Details are shown only for rows that
 * are not ok, so a healthy venue is five short readings rather than five paragraphs.
 */
export function VenueStatus() {
  const t = useT();

  const { data, isPending } = useQuery({
    queryKey: ["venue-status"],
    queryFn: async (): Promise<StatusInput | null> => {
      const res = await fetch("/api/status", { credentials: "omit" });
      if (!res.ok) return null;
      return (await res.json()) as StatusInput;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: false,
  });

  // An unreachable status endpoint is itself a degraded venue, so it says so rather than
  // vanishing — a status panel that disappears when things break is worse than none.
  if (isPending) return null;
  const status = venueStatus(
    data ?? {
      chainOk: false,
      chainLatencyMs: null,
      oracleLagSeconds: null,
      windowsOk: false,
      depositsQueueing: false,
      eligibleAssets: null,
      driftedAssets: 0,
    },
  );

  return (
    <section className={`venue-status is-${status.overall}`}>
      <div className="panel-top">
        <h2>{t("Venue status")}</h2>
        <Activity size={17} />
      </div>

      <ul className="venue-status-rows">
        {status.rows.map((row) => (
          <li key={row.key} className={`is-${row.level}`}>
            <span className="venue-status-label">{t(row.label)}</span>
            <span className="venue-status-value">
              <i aria-hidden="true" />
              {row.value}
            </span>
            {/* Only the rows that are not fine explain themselves. */}
            {row.detail && <small>{row.detail}</small>}
          </li>
        ))}
      </ul>

      <p className="ticket-note">
        {t(
          "Read live from this venue's own checks, the same ones its operators watch. Withdrawals do not depend on any of it — the pool accepts a valid proof from anyone, with no pause, no role and no window check.",
        )}
      </p>
    </section>
  );
}
