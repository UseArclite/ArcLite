"use client";
import { useEffect, useRef, useState } from "react";
import { useWindow, type WindowStatus } from "./market-provider";
import { useSound } from "./immersion";
import { feature } from "../lib/features";
import { useT } from "../lib/i18n";

/**
 * The auction clock.
 *
 * A batch auction's whole security argument is an *ordering* — the book closes, and only then
 * does the contract read its oracles and fix the prices. That is the one thing about this venue
 * worth understanding, and it happened entirely off-screen: the dashboard rendered a single
 * sentence, and the five stages the server was already computing had nowhere to go.
 *
 * `PHASE_INDEX` in `src/server/windows.ts` collapses the nine lifecycle states onto five and its
 * comment still reads "the five stages the dashboard renders". They stopped being rendered when
 * the simulated batch panel was removed with the rest of the demo, and the server kept computing
 * a display index for a component that no longer existed. This is that component, against the
 * real clock.
 *
 * Nothing here is fetched that was not already being fetched. `useWindow` polls `orderCount`,
 * `fillCount`, `deferredSymbols`, `sealedAt`, `settledAt` and the previous window every five
 * seconds, and the page used four of those fields.
 *
 * ## Why the countdown is not a local timer
 *
 * It is anchored to `serverNow`, measured against the client's own clock at each poll. Two
 * browsers on two machines therefore agree about when this window seals even when one of them is
 * minutes off — which matters, because the point of a batch auction is that everybody is in the
 * same one. A local `setInterval` seeded on mount would drift per tab and quietly make the
 * shared moment un-shared.
 */

interface Stage {
  label: string;
  /** What is happening, in the present tense, for the stage the window is actually in. */
  caption: string;
}

const STAGES: Stage[] = [
  {
    label: "Ready",
    caption: "The book is open. Orders arrive encrypted and nobody — us included — can read them.",
  },
  {
    label: "Sealed",
    caption:
      "The book is frozen. Prices commit next, so the venue cannot see this book and then choose what it trades against.",
  },
  {
    label: "Crossing",
    caption:
      "Matched size is the smaller side in full, split pro-rata. No fill rate is chosen by anyone.",
  },
  {
    label: "Proof",
    caption: "One zero-knowledge proof for the whole batch, generated and verified on chain.",
  },
  { label: "Settled", caption: "Nullifiers published, output notes spliced into the tree." },
];

const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

/**
 * How long ago, said the way a person would say it.
 *
 * Takes the translator rather than formatting English and hoping: "75s ago" sat untranslated in
 * the middle of a Chinese sentence, which is the failure mode of building a phrase out of parts
 * and only translating some of them.
 */
function ago(iso: string | null, t: (s: string) => string): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}${t("s ago")}`;
  if (s < 5400) return `${Math.round(s / 60)}${t("m ago")}`;
  return `${Math.round(s / 3600)}${t("h ago")}`;
}

/** A window that ended without settling is worth saying plainly rather than colouring red. */
const ENDED: Record<string, string> = {
  SETTLED: "settled",
  VOID: "was voided — nothing crossed and no note was spent",
  FAILED: "failed — nothing crossed and no note was spent",
};

export function WindowRitual() {
  const t = useT();
  const { window: live, secondsToSeal, loading } = useWindow();
  const { cue } = useSound();

  // Fire the settle tone once per window, on the transition rather than on every poll — the
  // window endpoint answers every five seconds and a cue on each of those would be an alarm.
  const lastSettled = useRef<number | null>(null);
  useEffect(() => {
    if (!live || live.phase !== 4) return;
    if (lastSettled.current === live.seq) return;
    lastSettled.current = live.seq;
    cue("settle");
  }, [live, cue]);

  // Flash the count when it moves. The venue's heartbeat, and the only evidence on the page that
  // anyone else is in this window — which is decision-relevant on a batch auction, where an
  // order with nobody on the other side simply rests.
  const [pulse, setPulse] = useState(false);
  const lastCount = useRef<number | null>(null);
  useEffect(() => {
    if (!live) return;
    if (lastCount.current !== null && live.orderCount !== lastCount.current) {
      setPulse(true);
      const timer = setTimeout(() => setPulse(false), 900);
      lastCount.current = live.orderCount;
      return () => clearTimeout(timer);
    }
    lastCount.current = live.orderCount;
  }, [live]);

  if (loading && !live) {
    return (
      <section className="window-ritual is-waiting" aria-busy="true">
        <p>{t("Reading the venue clock…")}</p>
      </section>
    );
  }
  if (!live) {
    return (
      <section className="window-ritual is-waiting" role="status">
        <p>{t("No window is open. The venue opens the next one on its own.")}</p>
      </section>
    );
  }

  const phase = Math.min(4, Math.max(0, live.phase));
  const open = live.status === "OPEN";
  // The book's time is up but the venue has not moved it on yet.
  //
  // A window seals because `seals_at <= now()`, not because a tick fired, and the tick runs once
  // a minute — so there is a gap of up to that long where the countdown reads 0:00 and the stage
  // is still Ready. An empty book never seals at all: `sealWindow` on one pays gas to say
  // nothing, so the venue skips straight past it. Left unsaid, both look like a stuck clock.
  const waiting = open && secondsToSeal === 0;
  // Progress across the open phase only. Once the book is frozen the clock has stopped being the
  // thing to watch, so the bar holds rather than implying the later stages are timed.
  const total = Math.max(
    1,
    Math.round((new Date(live.sealsAt).getTime() - new Date(live.opensAt).getTime()) / 1000),
  );
  const elapsed = Math.min(total, Math.max(0, total - secondsToSeal));
  const pct = open ? (elapsed / total) * 100 : 100;

  const prev = live.previous;

  return (
    <section className="window-ritual" aria-label="Batch window">
      <header>
        <span className="eyebrow">
          {t("WINDOW")} {live.seq} · {t("EPOCH")} {String(live.epochSeq).padStart(3, "0")}
        </span>
        <strong aria-live="off">
          {waiting ? (
            t("BOOK CLOSED")
          ) : open ? (
            <>
              {t("SEALING IN")} <b>{mmss(secondsToSeal)}</b>
            </>
          ) : (
            (STAGES[phase]?.label ?? live.status).toUpperCase()
          )}
        </strong>
      </header>

      <div className="ritual-rail" role="list">
        {STAGES.map((s, i) => (
          <div
            key={s.label}
            role="listitem"
            className={`ritual-stage${i < phase ? " is-done" : ""}${i === phase ? " is-now" : ""}`}
            aria-current={i === phase ? "step" : undefined}
          >
            <span aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
            <b>{t(s.label)}</b>
          </div>
        ))}
        <div className="ritual-progress" aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="ritual-now" role="status">
        <p className="ritual-caption">
          {waiting
            ? live.orderCount === 0
              ? t(
                  "Nothing was submitted, so there is nothing to seal — sealing an empty book pays gas to say nothing. The venue moves to the next window.",
                )
              : t("The book's time is up. The venue seals it on its next pass, within a minute.")
            : t(STAGES[phase]?.caption ?? "")}
        </p>
        <p className={"ritual-count" + (pulse ? " is-pulsing" : "")}>
          <b>{live.orderCount}</b>{" "}
          {live.orderCount === 1 ? t("order in this window") : t("orders in this window")}
          {live.fillCount > 0 ? ` · ${live.fillCount} filled` : ""}
          {live.deferredSymbols.length > 0
            ? ` · ${live.deferredSymbols.length} asset${live.deferredSymbols.length === 1 ? "" : "s"} deferred`
            : ""}
        </p>
      </div>

      {prev && (
        <p className="ritual-previous">
          {t("Previous")} · {t("window")} {prev.seq}{" "}
          {t(ENDED[prev.status] ?? prev.status.toLowerCase())}
          {prev.settledAt ? ` ${ago(prev.settledAt, t)}` : ""}
          {prev.status === "SETTLED"
            ? prev.fillCount > 0
              ? ` · ${prev.fillCount} ${t("filled")}`
              : ` · ${t("no counterparty")}`
            : ""}
        </p>
      )}
    </section>
  );
}

/** Whether the ritual replaces the old one-line status. Kept here so the dashboard reads plainly. */
export const windowRitualEnabled = () => feature("window-ritual");

export type { WindowStatus };
