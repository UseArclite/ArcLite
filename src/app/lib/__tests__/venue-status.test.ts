import { describe, expect, test } from "bun:test";
import { venueStatus, type StatusInput } from "../venue-status";

/**
 * Two properties matter here.
 *
 * The first is that a degraded venue cannot render as a healthy one. A status panel that goes
 * green while the clock is stopped is worse than no panel, because somebody is now relying on it.
 *
 * The second is what is *absent*. The input type carries no relayer address, no balance, no
 * runway and no key policy, and the last test pins that: everything this module can emit is
 * derived from the six fields below, so operator intelligence cannot leak through it by anyone
 * later adding a field in a hurry.
 */

const healthy: StatusInput = {
  chainOk: true,
  chainLatencyMs: 37,
  oracleLagSeconds: 8,
  windowsOk: true,
  depositsQueueing: false,
  eligibleAssets: 36,
  driftedAssets: 0,
};

const at = (over: Partial<StatusInput> = {}) => venueStatus({ ...healthy, ...over });
const row = (s: ReturnType<typeof venueStatus>, key: string) => s.rows.find((r) => r.key === key)!;

describe("a working venue", () => {
  test("is all green and explains nothing", () => {
    const s = at();
    expect(s.overall).toBe("ok");
    expect(s.rows.every((r) => r.detail === null)).toBe(true);
    expect(row(s, "chain").value).toBe("37ms");
  });
});

describe("degraded states surface", () => {
  test("an unreachable chain is down, not a warning", () => {
    const s = at({ chainOk: false, chainLatencyMs: null });
    expect(row(s, "chain").level).toBe("down");
    expect(s.overall).toBe("down");
  });

  test("a stalled clock is down", () => {
    expect(at({ windowsOk: false }).overall).toBe("down");
  });

  test("a stale oracle warns, then fails", () => {
    expect(row(at({ oracleLagSeconds: 60 }), "oracle").level).toBe("ok");
    expect(row(at({ oracleLagSeconds: 200 }), "oracle").level).toBe("warn");
    expect(row(at({ oracleLagSeconds: 900 }), "oracle").level).toBe("down");
  });

  test("an unknown oracle lag is never reported as fine", () => {
    // "We could not check" and "it is fine" must not render the same — the same rule the supply
    // guard fails closed on.
    expect(row(at({ oracleLagSeconds: null }), "oracle").level).toBe("warn");
  });

  test("the overall level is the worst present, not an average", () => {
    const s = at({ depositsQueueing: true, windowsOk: false });
    expect(s.overall).toBe("down");
  });
});

describe("the condition a trader cannot otherwise diagnose", () => {
  test("queueing deposits are named and explained", () => {
    const s = at({ depositsQueueing: true });
    const d = row(s, "deposits");
    expect(d.value).toBe("queueing");
    expect(d.level).toBe("warn");
    // The whole point: it must say this is not a slow confirmation.
    expect(d.detail).toContain("not a slow confirmation");
    expect(d.detail).toContain("funds are in the pool");
  });
});

describe("the supply guard", () => {
  test("reports how many assets it watches when nothing is wrong", () => {
    expect(row(at(), "supply").value).toBe("36 watched");
  });

  test("reports halted assets, and says the rest keep trading", () => {
    const s = at({ driftedAssets: 2 });
    expect(row(s, "supply").value).toBe("2 halted");
    expect(row(s, "supply").detail).toContain("Every other asset keeps crossing");
    expect(row(s, "supply").detail).toContain("withdrawals are unaffected");
  });
});

describe("what cannot leak", () => {
  test("no output mentions an address, a balance, runway or a key", () => {
    // The input shape is the guarantee; this is the tripwire for someone widening it later.
    for (const over of [
      {},
      { chainOk: false },
      { depositsQueueing: true },
      { driftedAssets: 3 },
      { windowsOk: false, oracleLagSeconds: null },
    ]) {
      const text = JSON.stringify(at(over));
      expect(text).not.toMatch(/0x[0-9a-f]{6,}/i);
      expect(text).not.toMatch(/balance|runway|private key|hot key|keyPolicy|relayer/i);
    }
  });
});
