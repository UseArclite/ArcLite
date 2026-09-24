import { describe, expect, test } from "bun:test";
import { assessPrivacy, effectiveSet, LEVEL_LABEL } from "../privacy";

/**
 * The honesty of the privacy claim, tested as a claim.
 *
 * The temptation in a panel like this is a score that goes up and to the right, because a green
 * badge is what a product wants. The tests below exist to stop that: the cases they pin are the
 * ones where the truthful answer is bad, and a change that quietly softened any of them would be
 * a change to what the venue is telling people about their own exposure.
 */

const at = (commitments: number, yours = 1, hasPosition = true) =>
  assessPrivacy({ commitments, yours, hasPosition });

describe("the size of the crowd", () => {
  test("your own notes do not hide you", () => {
    // A pool holding four notes of which three are yours is a pool with a crowd of one.
    expect(effectiveSet({ commitments: 4, yours: 3, hasPosition: true })).toBe(1);
  });

  test("an empty pool is a crowd of nobody, not a negative one", () => {
    expect(effectiveSet({ commitments: 0, yours: 0, hasPosition: false })).toBe(0);
    expect(effectiveSet({ commitments: 1, yours: 3, hasPosition: true })).toBe(0);
  });
});

describe("what it refuses to claim", () => {
  test("a set of one is reported as no anonymity at all", () => {
    // The case the venue is actually in today. A panel that called this "low" would be dressing
    // up "anyone reading the chain can follow your notes exactly".
    const a = at(1, 1);
    expect(a.level).toBe("none");
    expect(LEVEL_LABEL[a.level]).toBe("No anonymity");
    expect(a.headline).toContain("no crowd");
  });

  test("the public deposit is never counted as good, at any size", () => {
    for (const n of [1, 10, 100, 10_000, 1_000_000]) {
      const deposit = at(n).factors.find((f) => f.title === "Your deposit is public")!;
      expect(deposit.good).toBe(false);
    }
  });

  test("the operator's view of a sealed book is never counted as good either", () => {
    // No amount of scale changes it. Threshold decryption would; it is not built.
    for (const n of [1, 1_000, 1_000_000]) {
      expect(at(n).factors.find((f) => f.title.includes("operator"))!.good).toBe(false);
    }
  });

  test("there is no level above 'meaningful'", () => {
    // A venue whose funding link is unbroken and whose operator reads sealed books has no
    // business rating itself strong.
    expect(at(10_000_000).level).toBe("meaningful");
    expect(Object.keys(LEVEL_LABEL)).not.toContain("strong");
  });
});

describe("the scale it does report", () => {
  test("rises with the crowd, and only with the crowd", () => {
    expect(at(1).level).toBe("none");
    expect(at(5).level).toBe("minimal");
    expect(at(50).level).toBe("weak");
    expect(at(500).level).toBe("moderate");
    expect(at(5000).level).toBe("meaningful");
  });

  test("counts the others, not the total", () => {
    // The same eleven commitments rate completely differently depending on how many are yours.
    // Ten of them being yours leaves a crowd of one, which is not a crowd.
    expect(at(11, 10).level).toBe("none");
    expect(at(11, 1).level).toBe("weak");
    // And a pool you are most of does not improve by growing, only by others arriving.
    expect(at(60, 55).level).toBe("minimal");
    expect(at(60, 1).level).toBe("weak");
  });

  test("timing stops being flagged only once the pool is genuinely busy", () => {
    const flagged = (n: number) => at(n).factors.find((f) => f.title === "Timing")!.good;
    expect(flagged(50)).toBe(false);
    expect(flagged(500)).toBe(true);
  });
});

describe("before there is anything to protect", () => {
  test("it describes what a deposit would join rather than scoring a position that does not exist", () => {
    const a = assessPrivacy({ commitments: 0, yours: 0, hasPosition: false });
    expect(a.headline).toContain("nothing to link");
    expect(a.setSize).toBe(0);
  });
});

describe("the one thing that is genuinely good", () => {
  test("no session ties an order to a wallet, and the residual leak is named", () => {
    const f = at(100).factors.find((f) => f.title.includes("Nothing links an order"))!;
    expect(f.good).toBe(true);
    // Overclaiming here would be the easiest thing in the panel to do, so the IP is named.
    expect(f.detail).toContain("IP");
  });
});
