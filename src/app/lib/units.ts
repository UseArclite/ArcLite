/**
 * Decimal quantities and the raw integers the venue actually works in.
 *
 * Every amount on this venue is a uint256 of base units: eighteen decimals for the tokenized
 * equities, six for USDG. The forms asked for that integer directly — one share was
 * `1000000000000000000` — which is exact, unambiguous, and an interface only its author can use.
 *
 * ## The rule that makes this safe
 *
 * **The raw integer stays the source of truth.** The decimal string is a way of typing one and a
 * way of reading one back; nothing downstream ever sees the float. `parseFloat` is never used,
 * because a double holds 15–16 significant digits and an 18-decimal quantity has 19 — so
 * `parseFloat("1.000000000000000001")` is `1`, silently, and the order the circuit proves is not
 * the order the person typed.
 *
 * So parsing is done on the string: split on the point, pad or reject the fraction, concatenate,
 * and read the result as a BigInt. No arithmetic happens in floating point at any stage.
 *
 * ## Why excess precision is refused rather than rounded
 *
 * `1.0000000000000000005` of an 18-decimal token is not a quantity that exists. Rounding it would
 * silently trade a different amount than was typed, and rounding *down* on a sell is the venue
 * quietly keeping the remainder. Refusing says so instead.
 */

export interface ParsedAmount {
  /** The value to submit. Present only when the input is a valid quantity. */
  raw?: bigint;
  /** Why it is not, phrased for the person who typed it. */
  error?: string;
}

/**
 * A decimal quantity to base units.
 *
 * Accepts `1`, `1.5`, `.5`, `1.` and thousands separators, because people paste those. Rejects
 * anything else rather than guessing — an unparseable amount is not a zero.
 */
export function parseAmount(input: string, decimals: number): ParsedAmount {
  const text = input.trim().replace(/,/g, "");
  if (text === "") return { error: "Enter an amount." };
  if (!/^\d*\.?\d*$/.test(text) || text === ".") {
    return { error: "Amounts are digits and at most one decimal point." };
  }

  const [whole = "", fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    return {
      error:
        decimals === 0
          ? "This asset has no fractional units."
          : `This asset holds ${decimals} decimal places; that is ${fraction.length}.`,
    };
  }

  // String concatenation, not multiplication: the point moves, nothing is scaled.
  const raw = BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
  if (raw <= 0n) return { error: "Enter an amount greater than zero." };
  return { raw };
}

/**
 * Base units back to a decimal string, exactly.
 *
 * Exact, not rounded: this is what a field is populated with when somebody presses MAX, and a
 * rounded value there would submit a different amount than the note holds — which for a sell is
 * the difference between spending a note whole and leaving dust that can never be swept.
 */
export function formatAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * The same value, grouped for reading rather than for round-tripping.
 *
 * Deliberately separate from `formatAmount`: this one may drop precision, so it must never reach
 * an input a form will submit.
 */
export function displayAmount(raw: bigint, decimals: number, maxFractionDigits = 6): string {
  const exact = formatAmount(raw, decimals);
  const [whole = "0", fraction = ""] = exact.split(".");
  const grouped = BigInt(whole).toLocaleString("en-US");
  const shown = fraction.slice(0, maxFractionDigits).replace(/0+$/, "");
  return shown ? `${grouped}.${shown}` : grouped;
}
