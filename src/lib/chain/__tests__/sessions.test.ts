import { describe, expect, test } from "bun:test";
import { assetSessionAt, SESSION_POLICY, sessionAt } from "../sessions";

/**
 * The session logic is load-bearing and easy to get subtly wrong.
 *
 * Chainlink's equity feeds on RHC have an 86400s heartbeat and stop updating when the market
 * shuts — a Sunday probe found NVDA 44 hours stale, which is correct. If the session is
 * misclassified, either the venue defers everything all weekend (looks broken) or it crosses
 * against a genuinely stale reference (loses money). Both directions are pinned here.
 *
 * Times are given as UTC instants with the intended Eastern wall-clock in the name, so the
 * DST handling is exercised rather than assumed.
 */

const utc = (iso: string) => new Date(iso);

describe("sessionAt", () => {
  test("weekday mid-morning EDT is MARKET", () => {
    // 2026-09-16 is a Wednesday. 14:00Z = 10:00 EDT.
    expect(sessionAt(utc("2026-09-16T14:00:00Z"))).toBe("MARKET");
  });

  test("weekday just before the open is PRE", () => {
    // 13:00Z = 09:00 EDT, half an hour before the 09:30 open.
    expect(sessionAt(utc("2026-09-16T13:00:00Z"))).toBe("PRE");
  });

  test("weekday just after the close is POST", () => {
    // 20:30Z = 16:30 EDT.
    expect(sessionAt(utc("2026-09-16T20:30:00Z"))).toBe("POST");
  });

  test("weekday late night is OVERNIGHT", () => {
    // 02:00Z Thursday = 22:00 EDT Wednesday, past the 20:00 post close.
    expect(sessionAt(utc("2026-09-17T02:00:00Z"))).toBe("OVERNIGHT");
  });

  test("Saturday is CLOSED", () => {
    expect(sessionAt(utc("2026-09-19T16:00:00Z"))).toBe("CLOSED");
  });

  test("Sunday midday is CLOSED — the case that produced the 44h-stale probe", () => {
    expect(sessionAt(utc("2026-09-20T16:00:00Z"))).toBe("CLOSED");
  });

  test("Sunday evening reopens into OVERNIGHT", () => {
    // 2026-09-21T01:00Z = Sunday 21:00 EDT, after the 20:00 reopen.
    expect(sessionAt(utc("2026-09-21T01:00:00Z"))).toBe("OVERNIGHT");
  });

  test("Friday night is CLOSED, not OVERNIGHT — the weekend starts here", () => {
    // 2026-09-19T01:00Z = Friday 21:00 EDT.
    expect(sessionAt(utc("2026-09-19T01:00:00Z"))).toBe("CLOSED");
  });

  test("respects DST: January 14:00Z is 09:00 EST, so PRE not MARKET", () => {
    // In winter ET is UTC-5, so 14:00Z is 09:00 — still before the open. A fixed -4 offset
    // would wrongly report MARKET here.
    expect(sessionAt(utc("2026-01-14T14:00:00Z"))).toBe("PRE");
    expect(sessionAt(utc("2026-01-14T15:00:00Z"))).toBe("MARKET");
  });
});

describe("assetSessionAt", () => {
  const tradable = { whole: "TRADING_STATUS_TRADABLE" };
  const notTradable = { whole: "TRADING_STATUS_NOT_TRADABLE" };

  test("an asset without overnight permission is CLOSED overnight", () => {
    const caps = { market: tradable, extended: tradable, overnight: notTradable };
    expect(sessionAt(utc("2026-09-17T02:00:00Z"))).toBe("OVERNIGHT");
    expect(assetSessionAt(caps, utc("2026-09-17T02:00:00Z"))).toBe("CLOSED");
  });

  test("an asset with overnight permission keeps trading overnight", () => {
    const caps = { market: tradable, extended: tradable, overnight: tradable };
    expect(assetSessionAt(caps, utc("2026-09-17T02:00:00Z"))).toBe("OVERNIGHT");
  });

  test("missing capabilities fall back to the market session rather than failing closed", () => {
    expect(assetSessionAt(undefined, utc("2026-09-16T14:00:00Z"))).toBe("MARKET");
  });

  test("fractional-only permission still counts as tradable", () => {
    const caps = { market: { fractional: "TRADING_STATUS_TRADABLE" } };
    expect(assetSessionAt(caps, utc("2026-09-16T14:00:00Z"))).toBe("MARKET");
  });
});

describe("SESSION_POLICY", () => {
  test("CLOSED is wide and does not cross", () => {
    // A tight bound here would report every asset stale all weekend.
    expect(SESSION_POLICY.CLOSED.maxPriceAgeSeconds).toBeGreaterThanOrEqual(172_800);
    expect(SESSION_POLICY.CLOSED.allowCrossing).toBe(false);
  });

  test("MARKET is tight — a stale feed during regular hours is a real fault", () => {
    expect(SESSION_POLICY.MARKET.maxPriceAgeSeconds).toBeLessThanOrEqual(3_600);
    expect(SESSION_POLICY.MARKET.allowCrossing).toBe(true);
  });

  test("bounds widen monotonically as liquidity thins", () => {
    expect(SESSION_POLICY.MARKET.maxPriceAgeSeconds).toBeLessThan(
      SESSION_POLICY.PRE.maxPriceAgeSeconds,
    );
    expect(SESSION_POLICY.PRE.maxPriceAgeSeconds).toBeLessThan(
      SESSION_POLICY.OVERNIGHT.maxPriceAgeSeconds,
    );
    expect(SESSION_POLICY.OVERNIGHT.maxPriceAgeSeconds).toBeLessThan(
      SESSION_POLICY.CLOSED.maxPriceAgeSeconds,
    );
  });
});
