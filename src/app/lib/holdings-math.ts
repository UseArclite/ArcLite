/**
 * Turning raw note units into something a person reads.
 *
 * Its own module rather than living beside the panel, for two reasons. Pure integer arithmetic is
 * worth testing directly, and a component file that also exports helpers loses fast refresh for
 * everything in it.
 *
 * The rule both functions follow: work in BigInt, convert once, at the end. Raw units are uint256
 * and anything past 2^53 rounds the moment it becomes a JS number — and a balance that quietly
 * drops its last digits still looks like a balance, which is the one kind of wrong number a
 * portfolio view must never produce.
 */

/** Raw units to a readable quantity at the token's own scale. Exported for its tests. */
export function quantity(raw: bigint, decimals: number): string {
  const whole = raw / 10n ** BigInt(decimals);
  const frac = raw % 10n ** BigInt(decimals);
  if (frac === 0n) return whole.toLocaleString("en-US");
  const shown = frac.toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${shown ? `.${shown}` : ""}`;
}

/**
 * USD value of a raw balance at a 1e18-scaled reference.
 *
 * `raw × price1e18` is up to ~2^176 for an 18-decimal token, so the multiply happens in BigInt
 * and only the scaled-down result becomes a number. Doing it the other way round is a silent
 * overflow on any position of consequence.
 */
export function valueUsd(raw: bigint, decimals: number, price1e18: bigint): number {
  if (price1e18 <= 0n) return 0;
  // Scale to cents in integer space, then divide once. Keeps two decimal places exact without
  // ever handing a number larger than 2^53 to the float.
  const cents = (raw * price1e18 * 100n) / (10n ** BigInt(decimals) * 10n ** 18n);
  return Number(cents) / 100;
}
