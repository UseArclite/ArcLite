"use client";
import { useEffect, useState } from "react";
import { LockKeyhole, Unlock } from "lucide-react";
import { useVault } from "./vault-provider";
import { useT } from "../lib/i18n";

/**
 * What "locked" means here, and when it happens by itself.
 *
 * The vault's keys live in a Web Worker, and `lock()` terminates it — destroying the heap is the
 * one thing that reliably removes key material from the process, rather than hiding a number
 * behind a boolean. That is a genuinely good property and nobody was ever told it.
 *
 * It was also attached to a vault that stayed open indefinitely. On a shared machine that is the
 * entire exposure: the balance, the note set and the ability to sign a spend, sitting behind a
 * tab somebody walked away from.
 *
 * So the state is shown, the countdown is shown, and the sentence explaining what locking
 * actually does is shown next to both — because a person deciding whether to leave a laptop open
 * is deciding on the strength of that sentence.
 */

const OPTIONS = [5, 15, 60, 0];

function label(minutes: number, t: (s: string) => string): string {
  if (minutes === 0) return t("Never");
  if (minutes < 60) return `${minutes}m`;
  return `${minutes / 60}h`;
}

export function VaultLock() {
  const t = useT();
  const vault = useVault();
  const [now, setNow] = useState(() => Date.now());

  // Ticks only while there is something to count down to, so a locked vault costs nothing.
  useEffect(() => {
    if (!vault.locksAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [vault.locksAt]);

  if (vault.status !== "unlocked") return null;

  const left = vault.locksAt ? Math.max(0, Math.round((vault.locksAt - now) / 1000)) : null;
  const mmss = left != null ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "";
  // Under a minute is worth looking different: it is the point at which somebody about to be
  // logged out would want to have noticed.
  const soon = left != null && left <= 60;

  return (
    <div className={"vault-lock" + (soon ? " is-soon" : "")}>
      <span className="vault-lock-state">
        <Unlock size={14} />
        <b>{t("Vault open")}</b>
        {left != null ? (
          <small>
            {t("locks in")} <b>{mmss}</b>
          </small>
        ) : (
          <small>{t("no automatic lock")}</small>
        )}
      </span>

      <span className="vault-lock-controls">
        <label>
          <span className="sr-only">{t("Lock after")}</span>
          <select
            value={vault.idleMinutes}
            onChange={(e) => vault.setIdleMinutes(Number(e.target.value))}
            aria-label={t("Lock after")}
          >
            {OPTIONS.map((m) => (
              <option key={m} value={m}>
                {label(m, t)}
              </option>
            ))}
          </select>
        </label>
        <button className="reset-demo" onClick={vault.lock}>
          <LockKeyhole size={13} /> {t("Lock now")}
        </button>
      </span>

      <p className="ticket-note">
        {t(
          "Locking destroys the worker that holds your keys rather than hiding a balance — they are gone from this page until you sign again. The timer counts what you do, not what the page does: polling the venue does not keep it open.",
        )}
      </p>
    </div>
  );
}
