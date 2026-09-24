"use client";
import { useEffect, useState } from "react";

/**
 * The contract address, above the title.
 *
 * The value comes from `VITE_ARCLITE_CA` so it can be changed in Vercel without touching code.
 * It is read at build time, which is what a `VITE_` variable means — changing it in the dashboard
 * needs a redeploy before it shows, the same as every other public setting here. The alternative,
 * fetching it at runtime, would trade that for a visible flash of the wrong value on every page
 * load, which is a worse deal for something that changes once.
 *
 * `Soon` is the default rather than an empty string: a placeholder that reads as deliberate is
 * better than a gap that reads as broken, and this sits directly above the title.
 */

const VALUE = (import.meta.env?.VITE_ARCLITE_CA as string | undefined)?.trim() || "Soon";

export function ContractAddress() {
  const [copied, setCopied] = useState(false);

  // Clear the confirmation on its own. Tied to `copied` rather than set inside the handler so a
  // second click restarts the timer instead of leaving an orphaned one to clear it early.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      // `navigator.clipboard` exists only in a secure context, and can still be refused by
      // permissions policy. The fallback is the old selection trick, which works everywhere.
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(VALUE);
      } else {
        const field = document.createElement("textarea");
        field.value = VALUE;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        document.execCommand("copy");
        document.body.removeChild(field);
      }
      setCopied(true);
    } catch {
      // Copying is a convenience; the value is on screen either way. Failing silently is better
      // than an error dialog over the hero.
    }
  }

  return (
    <button
      type="button"
      className="hero-ca"
      onClick={() => void copy()}
      // The label carries the value, so a screen reader announces what will be copied rather
      // than reading "CA colon Soon" and leaving the purpose to be guessed.
      aria-label={`Copy contract address: ${VALUE}`}
    >
      <span>CA:</span>
      <b>{VALUE}</b>
      {/* Announced politely so the confirmation is not read over whatever has focus. */}
      <em aria-live="polite">{copied ? "Copied" : ""}</em>
    </button>
  );
}
