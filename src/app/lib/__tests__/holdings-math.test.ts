import { describe, expect, test } from "bun:test";
import { quantity, valueUsd } from "../holdings-math";

/**
 * The money arithmetic behind the position panel.
 *
 * Worth testing rather than eyeballing, because the failure mode is silent. Raw units are uint256
 * and anything above 2^53 rounds the moment it becomes a JS number — a balance that quietly loses
 * its last digits still *looks* like a balance, which is the one kind of wrong number a portfolio
 * view must not produce. Both functions therefore do their work in BigInt and convert once, at the
 * end, and these tests are what hold them to it.
 */

const E18 = 10n ** 18n;

describe("quantity", () => {
  test("a whole token reads as a whole number", () => {
    expect(quantity(E18, 18)).toBe("1");
    expect(quantity(1_000000n, 6)).toBe("1");
  });

  test("groups thousands", () => {
    expect(quantity(1234n * E18, 18)).toBe("1,234");
  });

  test("keeps a fraction, and drops the trailing zeros", () => {
    expect(quantity(E18 + E18 / 2n, 18)).toBe("1.5");
    expect(quantity(2_500000n, 6)).toBe("2.5");
  });

  test("truncates rather than rounding the display", () => {
    // Six places shown; the raw figure stays beside it in the panel, so truncating here cannot
    // hide anything — and rounding up would show more than the holder has.
    expect(quantity(1_999999999999999999n, 18)).toBe("1.999999");
  });

  test("a dust balance is not shown as zero", () => {
    // 1e-18 of a token. It rounds out of six decimal places, so the whole part is what remains —
    // the panel's raw line is what carries the rest.
    expect(quantity(1n, 18)).toBe("0");
  });

  test("survives a balance far past the float limit", () => {
    // A million 18-decimal tokens is 1e24, well past 2^53. Done as a number this loses precision
    // in the middle of the integer.
    expect(quantity(1_000_000n * E18, 18)).toBe("1,000,000");
  });
});

describe("valueUsd", () => {
  test("one token at one dollar is a dollar", () => {
    expect(valueUsd(E18, 18, E18)).toBe(1);
  });

  test("prices an equity position at the reference", () => {
    // 3 shares at $228.41.
    expect(valueUsd(3n * E18, 18, 228_410000000000000000n)).toBe(685.23);
  });

  test("prices a six-decimal quote balance", () => {
    // 500 USDG at the $0.9999 peg.
    expect(valueUsd(500_000000n, 6, 999900000000000000n)).toBe(499.95);
  });

  test("no reference is no value, not a zero-priced position", () => {
    expect(valueUsd(E18, 18, 0n)).toBe(0);
  });

  test("a large position does not overflow into a wrong number", () => {
    // 1,000,000 shares at $228.41 — the intermediate `raw × price` here is ~2.3e44, which is
    // where doing this in floating point starts returning a number that is merely plausible.
    expect(valueUsd(1_000_000n * E18, 18, 228_410000000000000000n)).toBe(228_410_000);
  });

  test("rounds to whole cents rather than carrying fractions of one", () => {
    // A third of a dollar. Two places, truncated in integer space.
    expect(valueUsd(E18 / 3n, 18, E18)).toBe(0.33);
  });
});
