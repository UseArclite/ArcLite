"use client";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { clientChainId } from "@/lib/chain/chains";
import { venueRecordView, type RecordInput } from "../lib/venue-record";
import { useT } from "../lib/i18n";

/**
 * Everything this venue has done, published.
 *
 * It gives somebody a reason to open the dashboard when they are not trading, and it is the
 * surface a reader checks after finding the repositories. That only works if the record is
 * complete: the figure people are hunting for is how many orders actually crossed, and today the
 * answer is none. Showing windows run and assets listed while omitting that would be worse than
 * publishing nothing, because the omission is exactly what a sceptical reader is looking for.
 *
 * So the crossing row is always rendered, and when it is zero the summary says why — a batch
 * auction crosses when two sides arrive in the same window, and with four orders in the venue's
 * life nothing crossing is arithmetic rather than a fault. The reliability figure sits beside it
 * saying the machinery works and is waiting. Either sentence alone misleads.
 */
export function VenueRecord() {
  const t = useT();

  const { data, isPending } = useQuery({
    queryKey: ["venue-record", clientChainId()],
    queryFn: async (): Promise<RecordInput | null> => {
      const res = await fetch("/api/market/record", { credentials: "omit" });
      const body = (await res.json()) as { record?: RecordInput | null };
      return body.record ?? null;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (isPending || !data) return null;
  const view = venueRecordView(data);

  return (
    <section className={"venue-record" + (view.neverCrossed ? " is-quiet" : "")}>
      <div className="panel-top">
        <h2>{t("The record")}</h2>
        <ScrollText size={17} />
      </div>

      <ul className="venue-record-rows">
        {view.rows.map((r) => (
          <li key={r.key}>
            <span className="venue-record-value">{r.value}</span>
            <span className="venue-record-label">
              <b>{t(r.label)}</b>
              {r.note && <small>{r.note}</small>}
            </span>
          </li>
        ))}
      </ul>

      <p className="ticket-note">{view.summary}</p>
    </section>
  );
}
