import { describe, expect, test } from "bun:test";
import { displayAmount, formatAmount, parseAmount } from "../units";

/**
 * The conversion between what a person types and what the circuit proves.
 *
 * Worth testing at the boundary rather than the middle, because every failure here is silent:
 * a quantity that parses to the wrong integer submits, seals, matches and settles. Nothing
 * rejects it, and the order that crossed is simply not the order that was typed.
 *
 * The one that would have got through any casual implementation is `parseFloat`. A double holds
 * about 16 significant digits; an 18-decimal quantity has 19.
 */

const E18 = 18;
const USDG = 6;

describe("parseAmount", () => {
  test("a whole share is the token's base unit", () => {
    expect(parseAmount("1", E18).raw).toBe(10n ** 18n);
    expect(parseAmount("1", USDG).raw).toBe(1_000000n);
  });

  test("the point moves, nothing is scaled", () => {
    expect(parseAmount("1.5", E18).raw).toBe(1_500000000000000000n);
    expect(parseAmount("0.05", E18).raw).toBe(50000000000000000n);
    expect(parseAmount("228.41", USDG).raw).toBe(228_410000n);
  });

  test("holds precision a double would destroy", () => {
    // 19 significant digits. parseFloat("1.000000000000000001") === 1, silently.
    const r = parseAmount("1.000000000000000001", E18).raw!;
    expect(r).toBe(10n ** 18n + 1n);
    expect(r).not.toBe(10n ** 18n);
  });

  test("survives quantities far past the float limit", () => {
    // A million 18-decimal tokens is 1e24; a double loses digits in the middle of the integer.
    expect(parseAmount("1000000", E18).raw).toBe(1_000_000n * 10n ** 18n);
  });

  test("accepts the shapes people actually type", () => {
    expect(parseAmount(".5", E18).raw).toBe(500000000000000000n);
    expect(parseAmount("1.", E18).raw).toBe(10n ** 18n);
    expect(parseAmount("  2  ", E18).raw).toBe(2n * 10n ** 18n);
    expect(parseAmount("1,000", USDG).raw).toBe(1000_000000n);
  });

  test("refuses more precision than the asset has, rather than rounding it away", () => {
    // Rounding would trade a different amount than was typed, and rounding down on a sell is
    // the venue quietly keeping the remainder.
    const r = parseAmount("1.0000001", USDG);
    expect(r.raw).toBeUndefined();
    expect(r.error).toContain("6 decimal places");
  });

  test("an unparseable amount is not a zero", () => {
    for (const bad of ["", "abc", "1.2.3", "-1", "1e18", ".", "0x10"]) {
      expect(parseAmount(bad, E18).raw).toBeUndefined();
    }
  });

  test("zero is refused with its own reason", () => {
    expect(parseAmount("0", E18).error).toContain("greater than zero");
    expect(parseAmount("0.000", E18).error).toContain("greater than zero");
  });
});

describe("formatAmount", () => {
  test("round-trips exactly, which is what MAX depends on", () => {
    // Populating a field with a rounded value would submit a different amount than the note
    // holds — for a sell, the difference between spending a note whole and stranding dust.
    for (const raw of [
      1n,
      10n ** 18n,
      1_500000000000000000n,
      999_999999999999999999n,
      10n ** 18n + 1n,
    ]) {
      expect(parseAmount(formatAmount(raw, E18), E18).raw).toBe(raw);
    }
  });

  test("drops trailing zeros but not significance", () => {
    expect(formatAmount(10n ** 18n, E18)).toBe("1");
    expect(formatAmount(1_500000000000000000n, E18)).toBe("1.5");
    expect(formatAmount(1n, E18)).toBe("0.000000000000000001");
  });

  test("a six-decimal balance reads as money", () => {
    expect(formatAmount(228_410000n, USDG)).toBe("228.41");
    expect(formatAmount(2_000000n, USDG)).toBe("2");
  });
});

describe("displayAmount", () => {
  test("groups for reading and may lose precision, so it never feeds an input", () => {
    expect(displayAmount(1_000_000n * 10n ** 18n, E18)).toBe("1,000,000");
    expect(displayAmount(1_999999999999999999n, E18)).toBe("1.999999");
  });

  test("dust is visible as a whole part rather than as a false zero", () => {
    // Below the shown precision the fraction disappears, which is why the raw value stays on
    // screen beside it everywhere this is used.
    expect(displayAmount(1n, E18)).toBe("0");
  });
});
