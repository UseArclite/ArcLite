"use client";
import type { ReactNode } from "react";
import { useT } from "../lib/i18n";

/**
 * The explanation, folded away from the thing it explains.
 *
 * Every feature on this dashboard shipped with a paragraph justifying it, because the house rule
 * is to say the honest thing rather than imply it. Fourteen features later the Portfolio tab was
 * a wall of prose with a withdraw button somewhere inside it, and a trader looking for the button
 * had to read an essay about Web Worker key hygiene to find it. The rule was right; applying it
 * as *inline body copy* was not.
 *
 * So the sentences stay, exactly as written — they move behind a summary. Nothing is deleted and
 * nothing is softened, which matters, because most of this copy exists to disclose a limit rather
 * than to teach a feature, and a limit that got quietly dropped in a redesign would be the worst
 * possible outcome of a redesign.
 *
 * `<details>` rather than a button and a piece of state: it is open-able without JavaScript, it
 * is announced correctly without an `aria-expanded` to maintain, and browser find-in-page reaches
 * inside a closed one. The Privacy Meter's hand-rolled toggle predates this and does the same job
 * — it is the pattern this generalises, not a competitor to it.
 */
export function Detail({
  label,
  children,
  className,
}: {
  /** What the summary says. Defaults to the common case. */
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  const t = useT();
  return (
    <details className={"panel-detail" + (className ? ` ${className}` : "")}>
      <summary>{label ?? t("How this works")}</summary>
      <div className="panel-detail-body">{children}</div>
    </details>
  );
}
