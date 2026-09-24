/**
 * How linkable this withdrawal would be to the deposit that funded it.
 *
 * The privacy meter already says timing correlation is the weak link at small set sizes. It says
 * it on the Portfolio tab, in the abstract, to somebody who is not currently withdrawing — which
 * is the one moment the warning could change a decision. This is the same fact, delivered where
 * it is actionable.
 *
 * ## The two links, and why amount is the one people forget
 *
 * `shield` is a public transfer, so an observer sees *someone at this address put 2.00 USDG in at
 * 14:02*. `unshield` is public too: *someone took 2.00 USDG out at 14:06*. Neither reveals which
 * note was whose. The pair does, if nothing else in the pool looks like it.
 *
 * - **Timing.** Four minutes apart, in a pool where nothing else moved, is one candidate.
 * - **Amount.** Withdrawing exactly what was deposited is a fingerprint that never expires. A
 *   month of waiting does not break an exact match if no other note holds that number.
 *
 * Timing is the one people expect and amount is the one they do not, so both are reported and
 * the exact-match case is called out even when the wait has been long.
 *
 * Nothing here blocks a withdrawal. `unshield` is the path that must always work — the point is
 * that somebody choosing to take a linkability hit should be choosing it.
 */

export type Linkability = "high" | "moderate" | "low" | "unknown";

export interface WithdrawPrivacyInput {
  /** When this vault's deposits landed, epoch ms. Empty when none are known. */
  depositTimes: number[];
  /** Raw units of each deposit, to spot an exact match. */
  depositUnits: string[];
  /** Raw units being withdrawn now. */
  units: string;
  /** Commitments in the pool that are not this vault's. */
  othersInPool: number;
  now?: number;
}

export interface WithdrawPrivacyNote {
  level: Linkability;
  headline: string;
  /** What would reduce it, when anything would. */
  advice: string | null;
  /** Minutes since the most recent deposit, or null when unknown. */
  sinceMinutes: number | null;
  exactMatch: boolean;
}

const MINUTE = 60_000;

export function assessWithdrawal({
  depositTimes,
  depositUnits,
  units,
  othersInPool,
  now = Date.now(),
}: WithdrawPrivacyInput): WithdrawPrivacyNote {
  const exactMatch = depositUnits.some((u) => u === units && u !== "");

  if (depositTimes.length === 0) {
    return {
      level: "unknown",
      headline:
        "This browser does not know when your deposits landed, so it cannot say how linkable this withdrawal would be.",
      advice: null,
      sinceMinutes: null,
      exactMatch,
    };
  }

  const latest = Math.max(...depositTimes);
  const since = Math.max(0, Math.round((now - latest) / MINUTE));

  // An empty pool makes every other consideration academic: with nothing else in it, the deposit
  // and the withdrawal are the only two events there are.
  if (othersInPool < 1) {
    return {
      level: "high",
      headline:
        "Your notes are the only ones in this pool, so this withdrawal is linkable to your deposit whatever the timing or the amount.",
      advice: "Nothing you can do here changes that. It changes when other people deposit.",
      sinceMinutes: since,
      exactMatch,
    };
  }

  // Under an hour is the case somebody can actually act on, and the one they will hit: deposit,
  // look around, withdraw.
  if (since < 60) {
    return {
      level: "high",
      headline: `Your most recent deposit was ${since === 0 ? "less than a minute" : `${since} minute${since === 1 ? "" : "s"}`} ago. On a public chain those two events sit next to each other.`,
      advice: exactMatch
        ? "Waiting would help. Withdrawing a different amount than you deposited would help more — an exact match is a fingerprint that waiting does not erase."
        : "Waiting helps, and a busier pool helps more.",
      sinceMinutes: since,
      exactMatch,
    };
  }

  if (since < 60 * 24) {
    const hours = Math.round(since / 60);
    return {
      level: "moderate",
      headline: `Your most recent deposit was about ${hours} hour${hours === 1 ? "" : "s"} ago.`,
      advice: exactMatch
        ? "The amount is exactly what you deposited, which is a match an observer can make regardless of the gap."
        : "The gap and the amount both differ from your deposit, which is what makes the pair harder to pick out.",
      sinceMinutes: since,
      exactMatch,
    };
  }

  const days = Math.round(since / (60 * 24));
  return {
    level: exactMatch ? "moderate" : "low",
    headline: `Your most recent deposit was about ${days} day${days === 1 ? "" : "s"} ago.`,
    advice: exactMatch
      ? "Long enough that timing says little — but the amount is exactly what you deposited, and that match does not fade."
      : null,
    sinceMinutes: since,
    exactMatch,
  };
}
