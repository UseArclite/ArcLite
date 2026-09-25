"use client";
import { useEffect, useState } from "react";
import { Check, Loader2, Circle } from "lucide-react";
import { useVault } from "./vault-provider";
import { elapsed, proofStages } from "../lib/proof-stages";
import { useT } from "../lib/i18n";

/**
 * A withdrawal, narrated while it happens.
 *
 * The proof is generated in a Web Worker on the holder's own machine, from keys that never leave
 * it, and the pool accepts it from anyone holding it — no operator, no pause, no window check.
 * That is the strongest claim this venue makes, and it rendered as a button reading "Proving…".
 *
 * The work genuinely takes a few seconds, so there is real time to fill, and filling it with what
 * is actually happening beats hiding it. Each stage says *where* the work happens, because that
 * is the part worth noticing.
 *
 * Only the stage in hand explains itself — the same discipline the rest of the dashboard uses.
 * The timer ticks locally and is not authoritative; the figure reported at the end is the
 * worker's own `provingMs`, which measures the proof rather than the round trip.
 */
export function ProofTheatre() {
  const t = useT();
  const vault = useVault();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const phase = vault.proofPhase;

  // Start the clock when a withdrawal begins, and stop it when one ends. Anchored to the first
  // phase rather than to mount, so the reading is the work rather than the panel's lifetime.
  useEffect(() => {
    if (phase && startedAt === null) setStartedAt(Date.now());
    if (!phase) setStartedAt(null);
  }, [phase, startedAt]);

  useEffect(() => {
    if (!phase) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [phase]);

  const stages = proofStages(phase);
  if (stages.length === 0) return null;

  return (
    <div className="proof-theatre" role="status" aria-live="polite">
      <div className="proof-theatre-top">
        <span className="eyebrow">{t("PROVING ON THIS MACHINE")}</span>
        {startedAt !== null && <b>{elapsed(startedAt, now)}</b>}
      </div>

      <ol>
        {stages.map((s) => (
          <li key={s.phase} className={`is-${s.state}`}>
            <span className="proof-mark" aria-hidden="true">
              {s.state === "done" ? (
                <Check size={13} />
              ) : s.state === "current" ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <Circle size={13} />
              )}
            </span>
            <span className="proof-body">
              <b>{t(s.title)}</b>
              {s.state === "current" && <small>{t(s.detail)}</small>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
