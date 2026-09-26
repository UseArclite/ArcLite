/**
 * Dashboard features that are built but not yet switched on.
 *
 * Work lands on `main` continuously, which means a half-reviewed panel would otherwise appear on
 * a live venue the moment it was pushed. A flag decouples the two: the code ships, the panel does
 * not, and turning it on is a decision made deliberately rather than as a side effect of a commit.
 *
 * `VITE_ARCLITE_FEATURES` is a comma-separated list read at build time, the same way
 * `VITE_ARCLITE_CA` is. Build time is the trade being made here: switching a feature on needs a
 * redeploy rather than taking effect immediately. The alternative — fetching flags at runtime —
 * would buy instant toggling at the cost of a request on every page load and a visible flash as
 * panels appear after first paint, which is a bad deal for something changed a handful of times.
 *
 * Unset means every flag is off. That is the safe default and the one a fresh preview deployment
 * gets: a feature is visible only where somebody has said so by name.
 *
 * ## Why not render the panel and hide it with CSS
 *
 * Because several of these read the vault, and a hidden panel still runs its hooks, still issues
 * its queries and still holds its data. Off has to mean "did not render", not "rendered
 * invisibly" — otherwise flagging a feature off stops protecting anything.
 */

export type Feature =
  /** #4 — Holdings priced in USD on the Portfolio tab. */
  | "positions"
  /** #6 — Issuer logos and ISIN in the asset picker and market header. */
  | "logos"
  /** #7 — The seven named guard reasons instead of two booleans. */
  | "guard-reasons"
  /** #8 — How old the reference price is, judged against the session. */
  | "price-age"
  /** #9 — Transaction hashes, confirmation state and explorer links. */
  | "tx-receipts"
  /** #12 — What an order will cost, before it is submitted. */
  | "preflight"
  /** #1 — The five-stage auction clock, replacing the one-line window status. */
  | "window-ritual"
  /** #3 — Decimal amounts in the forms, with the raw integer shown beneath. */
  | "human-units"
  /** #21 — Say what became of an order, even with the tab in the background. */
  | "settlement-alerts"
  /** #24 — How private this position actually is, including when the answer is "not". */
  | "privacy-meter"
  /** #16 — A price scale and a hover readout on the reference chart. */
  | "chart-scale"
  /** #25 — Seal one epoch's viewing key to an auditor. */
  | "disclosure"
  /** #26 — Idle auto-lock, and saying what locking actually does. */
  | "vault-lock"
  /** #27 — How linkable a withdrawal would be to the deposit that funded it. */
  | "withdraw-timing"
  /** #36 — The dashboard as a terminal: dense, monospace, explanation folded away. */
  | "terminal"
  /** #22 — The venue's heartbeat: is anyone else here, and when were they last. */
  | "order-pulse"
  /** #13 — Whether this asset has ever actually crossed, as observed history. */
  | "crossing-history"
  /** #11 — The four steps to a first trade, with the current one marked. */
  | "first-run"
  /** Lit liquidity per asset, read from the public DEX on this chain. */
  | "lit-depth"
  /** #15 — The venue publishing its own alarms. */
  | "venue-status"
  /** #17 — Recent windows and what became of each. */
  | "window-history"
  /** #19 — Everything this vault has done, rebuilt from its own keys. */
  | "activity-ledger"
  /** #14 — Make the pre-flight's suggested size one click. */
  | "sizing-actions"
  /** #5 — Watch a withdrawal being proved, stage by stage. */
  | "proof-theatre"
  /** #28 — The venue's cumulative record, including the unflattering rows. */
  | "venue-record"
  /** Notes stranded in a retired pool, and what moving them costs. */
  | "pool-migration"
  /** #30 — Be told when a guard clears or a window is about to seal, from this browser only. */
  | "reminders";

/**
 * Parsed once. `import.meta.env` is inlined at build time, so re-reading it per call would be
 * free but re-splitting the string would not, and this is called inside render.
 */
const ENABLED: ReadonlySet<string> = new Set(
  ((import.meta.env?.VITE_ARCLITE_FEATURES as string | undefined) ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
);

/**
 * Whether a feature is switched on for this build.
 *
 * `all` turns on everything, which is for local development and preview deployments. It is
 * deliberately not the default: a preview that silently enabled everything would be testing a
 * different site from the one production runs.
 */
export function feature(name: Feature): boolean {
  return ENABLED.has("all") || ENABLED.has(name);
}

/** Every flag currently on, for the health endpoint and for debugging a deployment. */
export function enabledFeatures(): string[] {
  return [...ENABLED].sort();
}
