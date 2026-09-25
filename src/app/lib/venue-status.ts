/**
 * The venue's own alarms, in a form a trader can read.
 *
 * ArcLite has quietly accumulated controls that are invisible when they work: the tick advancing
 * windows, the oracle cron writing guards, the supply watcher checking 35 token supplies a
 * minute, a circuit breaker that can black an asset out on chain. All of it is correct
 * behaviour rendered as nothing at all, which is the right default and a bad answer to "is this
 * thing running".
 *
 * There is also one condition a trader cannot distinguish from bad luck. When a window is stuck,
 * `shield` queues the deposit instead of entering it into the tree — the money is safe, the note
 * is coming, and the wait looks exactly like a slow confirmation. Saying so out loud is the
 * single most useful thing on this panel.
 *
 * ## Why an operator's dashboard is not this
 *
 * `/api/health` carries the relayer's address, its balance, its runway in days and whether its
 * key is hot. That is operational intelligence — it tells somebody precisely when the venue
 * stalls and what to watch — and it does not belong to the public even on a venue that prides
 * itself on disclosure. Publishing *whether the venue is working* is a trust signal; publishing
 * *how to time its failure* is not the same thing.
 *
 * So this takes a deliberately narrow input. Anything not in `StatusInput` cannot leak through
 * it, which is a property of the shape rather than of anyone's care.
 */

export type StatusLevel = "ok" | "warn" | "down";

export interface StatusInput {
  /** Chain reachable, and how fast it answered. */
  chainOk: boolean;
  chainLatencyMs: number | null;
  /** Seconds since the oracle cron last completed a pass. */
  oracleLagSeconds: number | null;
  /** A window is open and the clock is advancing. */
  windowsOk: boolean;
  /** Deposits are queueing behind a stuck window rather than entering the tree. */
  depositsQueueing: boolean;
  /** Assets the venue will price at all. */
  eligibleAssets: number | null;
  /** Assets currently halted by the supply guard. */
  driftedAssets: number;
}

export interface StatusRow {
  key: "chain" | "oracle" | "windows" | "deposits" | "supply";
  label: string;
  /** The short reading, e.g. "37ms" or "accepting". */
  value: string;
  level: StatusLevel;
  /** Said only when something is not ok — what it means and what happens next. */
  detail: string | null;
}

export interface VenueStatus {
  rows: StatusRow[];
  /** The worst level present, for the headline. */
  overall: StatusLevel;
}

/**
 * The oracle runs every minute. Two missed passes is a blip worth showing; five is a venue whose
 * prices have stopped moving, and a trader should know before submitting against them.
 */
const ORACLE_WARN_SECONDS = 150;
const ORACLE_DOWN_SECONDS = 420;

const worst = (levels: StatusLevel[]): StatusLevel =>
  levels.includes("down") ? "down" : levels.includes("warn") ? "warn" : "ok";

export function venueStatus(input: StatusInput): VenueStatus {
  const rows: StatusRow[] = [];

  rows.push({
    key: "chain",
    label: "Robinhood Chain",
    value: input.chainOk
      ? input.chainLatencyMs != null
        ? `${input.chainLatencyMs}ms`
        : "up"
      : "unreachable",
    level: input.chainOk ? "ok" : "down",
    detail: input.chainOk
      ? null
      : "The venue cannot read the chain. Prices and guards are stale until it returns. Nothing you own is affected.",
  });

  const lag = input.oracleLagSeconds;
  const oracleLevel: StatusLevel =
    lag == null
      ? "warn"
      : lag > ORACLE_DOWN_SECONDS
        ? "down"
        : lag > ORACLE_WARN_SECONDS
          ? "warn"
          : "ok";
  rows.push({
    key: "oracle",
    label: "Reference prices",
    value:
      lag == null
        ? "unknown"
        : lag < 90
          ? `updated ${lag}s ago`
          : `updated ${Math.round(lag / 60)}m ago`,
    level: oracleLevel,
    detail:
      oracleLevel === "ok"
        ? null
        : "The price poller has not completed recently. Assets whose reference goes stale are deferred automatically rather than crossed at an old price.",
  });

  rows.push({
    key: "windows",
    label: "Auction windows",
    value: input.windowsOk ? "advancing" : "stalled",
    level: input.windowsOk ? "ok" : "down",
    detail: input.windowsOk
      ? null
      : "No window is advancing, so nothing will cross until one opens. Orders already submitted rest until then; nothing is lost.",
  });

  // The one a trader cannot otherwise tell apart from a slow confirmation.
  rows.push({
    key: "deposits",
    label: "Deposits",
    value: input.depositsQueueing ? "queueing" : "accepting",
    level: input.depositsQueueing ? "warn" : "ok",
    detail: input.depositsQueueing
      ? "A stuck window is holding new deposits in a queue instead of entering them into the tree. Your funds are in the pool and your note arrives when the queue drains — this is not a failed deposit, and it is not a slow confirmation."
      : null,
  });

  rows.push({
    key: "supply",
    label: "Issuer supply",
    value:
      input.driftedAssets === 0
        ? `${input.eligibleAssets ?? 0} watched`
        : `${input.driftedAssets} halted`,
    level: input.driftedAssets === 0 ? "ok" : "warn",
    detail:
      input.driftedAssets === 0
        ? null
        : "An issuer minted or burned a token outside an announced corporate action, so that asset is blacked out on chain until it is checked. Every other asset keeps crossing, and withdrawals are unaffected.",
  });

  return { rows, overall: worst(rows.map((r) => r.level)) };
}
