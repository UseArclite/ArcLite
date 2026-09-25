"use client";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, History } from "lucide-react";
import { CHAINS, clientChainId } from "@/lib/chain/chains";
import { describeWindow, windowTime, type WindowRow } from "../lib/window-outcome";
import { useT } from "../lib/i18n";

/**
 * What became of the last twenty-five windows.
 *
 * "Did the last window settle?" is the first thing anyone asks after submitting an order, and the
 * venue could not answer it. The live clock shows the window in front of you and the one before
 * it, then discards everything.
 *
 * The rows worth getting right are `VOID` and `FAILED`. They look like loss and are not —
 * nullifiers publish only at settlement, so a window that never settled left every note valid and
 * every order resting. That is stated on the row rather than left to a status colour, because a
 * bare red label is the scary half of a true story.
 */
export function WindowHistory() {
  const t = useT();
  const chainId = clientChainId();
  const explorer = CHAINS[chainId].blockExplorers.default.url;

  const { data, isPending } = useQuery({
    queryKey: ["window-history", chainId],
    queryFn: async (): Promise<WindowRow[]> => {
      const res = await fetch("/api/market/windows?limit=25", { credentials: "omit" });
      const body = (await res.json()) as { windows?: WindowRow[] };
      return body.windows ?? [];
    },
    // A window is five minutes. Matching the live clock's cadence would be noise.
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });

  if (isPending) return null;
  const rows = data ?? [];

  return (
    <section className="window-history">
      <div className="panel-top">
        <h2>{t("Recent windows")}</h2>
        <History size={17} />
      </div>

      {rows.length === 0 ? (
        <p className="ticket-note">{t("No windows have run on this network yet.")}</p>
      ) : (
        <div className="window-history-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Window")}</th>
                <th>{t("Opened")}</th>
                <th>{t("Orders")}</th>
                <th>{t("Outcome")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => {
                const outcome = describeWindow(w);
                return (
                  <tr key={w.seq} className={`is-${outcome.tone}`}>
                    <td>
                      {w.settledTx ? (
                        <a
                          href={`${explorer}/tx/${w.settledTx}`}
                          target="_blank"
                          rel="noreferrer"
                          title={t("Settlement transaction")}
                        >
                          {w.seq} <ExternalLink size={10} />
                        </a>
                      ) : (
                        w.seq
                      )}
                    </td>
                    <td>{windowTime(w.opensAt)}</td>
                    <td>{w.orderCount}</td>
                    <td>
                      <b>{outcome.label}</b>
                      {outcome.note && <small>{outcome.note}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="ticket-note">
        {t(
          "A window that voided or failed spent nothing: nullifiers are published only at settlement, so the orders rested and the notes stayed valid.",
        )}
      </p>
    </section>
  );
}
