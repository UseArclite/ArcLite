/**
 * US equity market sessions.
 *
 * This matters more than it looks. Chainlink's equity feeds on Robinhood Chain have an 86400s
 * heartbeat and simply stop updating when the market closes — a Sunday probe found NVDA's feed
 * 44 hours old, which is correct behaviour, not a fault. A flat staleness bound would therefore
 * defer every asset all weekend and make the venue look broken for most of the week.
 *
 * So staleness is judged relative to the session, and "the market is shut" is reported as its
 * own state rather than as staleness.
 *
 * Holidays are not handled here — that needs the `market_calendar` table, populated by the
 * calendar cron. Until then a holiday reads as MARKET with a stale feed, which defers the asset.
 * That is the safe direction to be wrong in, but it is wrong, and the calendar closes the gap.
 */

export type SessionKind = "PRE" | "MARKET" | "POST" | "OVERNIGHT" | "CLOSED";

export interface SessionPolicy {
  maxPriceAgeSeconds: number;
  allowCrossing: boolean;
}

/** Mirrors the `arclite.session_policy` seed rows so both sides agree. */
export const SESSION_POLICY: Record<SessionKind, SessionPolicy> = {
  MARKET: { maxPriceAgeSeconds: 3_600, allowCrossing: true },
  PRE: { maxPriceAgeSeconds: 14_400, allowCrossing: true },
  POST: { maxPriceAgeSeconds: 14_400, allowCrossing: true },
  OVERNIGHT: { maxPriceAgeSeconds: 43_200, allowCrossing: true },
  CLOSED: { maxPriceAgeSeconds: 259_200, allowCrossing: false },
};

/** Minutes past midnight in America/New_York, DST-correct via Intl rather than a fixed offset. */
function easternMinutes(at: Date): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = weekdays.indexOf(get("weekday"));
  return { minutes: hour * 60 + minute, weekday };
}

const PRE_OPEN = 4 * 60; //  04:00 ET
const REGULAR_OPEN = 9 * 60 + 30; //  09:30 ET
const REGULAR_CLOSE = 16 * 60; //  16:00 ET
const POST_CLOSE = 20 * 60; //  20:00 ET

/** The session for US equities at `at`, ignoring holidays. */
export function sessionAt(at: Date = new Date()): SessionKind {
  const { minutes, weekday } = easternMinutes(at);
  const isWeekday = weekday >= 1 && weekday <= 5;

  if (!isWeekday) {
    // Robinhood's overnight session runs Sunday evening through Friday evening. Saturday, and
    // Sunday before the reopen, are genuinely shut.
    if (weekday === 0 && minutes >= POST_CLOSE) return "OVERNIGHT";
    return "CLOSED";
  }

  if (minutes >= REGULAR_OPEN && minutes < REGULAR_CLOSE) return "MARKET";
  if (minutes >= PRE_OPEN && minutes < REGULAR_OPEN) return "PRE";
  if (minutes >= REGULAR_CLOSE && minutes < POST_CLOSE) return "POST";
  // Friday after 20:00 ET is the weekend; any other weekday night is the overnight session.
  if (weekday === 5 && minutes >= POST_CLOSE) return "CLOSED";
  return "OVERNIGHT";
}

/**
 * Narrow the session by what the asset is actually permitted to trade in, per the registry's
 * `tradingCapabilities`. An asset with no overnight permission is CLOSED overnight even though
 * the market as a whole is not.
 */
export function assetSessionAt(
  capabilities: Record<string, { whole?: string; fractional?: string }> | undefined,
  at: Date = new Date(),
): SessionKind {
  const session = sessionAt(at);
  if (!capabilities) return session;

  const tradable = (key: string) => {
    const cap = capabilities[key];
    if (!cap) return false;
    return cap.whole === "TRADING_STATUS_TRADABLE" || cap.fractional === "TRADING_STATUS_TRADABLE";
  };

  switch (session) {
    case "MARKET":
      return tradable("market") ? "MARKET" : "CLOSED";
    case "PRE":
    case "POST":
      return tradable("extended") ? session : "CLOSED";
    case "OVERNIGHT":
      return tradable("overnight") ? "OVERNIGHT" : "CLOSED";
    default:
      return "CLOSED";
  }
}
