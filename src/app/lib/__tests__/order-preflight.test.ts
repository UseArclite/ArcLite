import { describe, expect, test } from "bun:test";
import { preflight, quoteCost, type PreflightAsset, type PreflightNote } from "../order-preflight";

/**
 * The affordability check, tested at the boundary it exists to defend.
 *
 * It was written after a buy of one NVDA funded by a one-dollar note failed to prove: the
 * shortfall is a negative number, a negative Field range-checks as enormous, and the circuit
 * aborted with `assert_max_bit_size` — taking the whole window down and every other order in it.
 * Ten settle attempts, then a failed window.
 *
 * So the cases that matter are not the happy path. They are: the shortfall by two orders of
 * magnitude is caught, a fill that is merely close still goes through, and the rounding direction
 * matches the circuit's rather than being convenient.
 */

const NVDA: PreflightAsset = { assetId: 3, symbol: "NVDA", decimals: 18, isQuote: false };
const USDG: PreflightAsset = { assetId: 1, symbol: "USDG", decimals: 6, isQuote: true };
const ASSETS = [NVDA, USDG];

const note = (
  assetId: string,
  units: string,
  extra: Partial<PreflightNote> = {},
): PreflightNote => ({
  assetId,
  units,
  leafIndex: 7,
  spent: false,
  epoch: 1,
  counter: 0,
  commitment: "0xc0",
  nullifier: "0xn0",
  ...extra,
});

/** $228.41 a share, 1e18-scaled, which is roughly where NVDA has actually been trading. */
const NVDA_REF = 228_410000000000000000n;
const ONE_SHARE = 10n ** 18n;
const prices = (id: string) => (id === "3" ? NVDA_REF : 0n);

const buy = (units: bigint, notes: PreflightNote[]) =>
  preflight({
    side: "buy",
    assetId: "3",
    units: units.toString(),
    notes,
    poolAssets: ASSETS,
    quoteAssetId: 1,
    priceE18: prices,
  });

describe("quoteCost", () => {
  test("one share at the reference costs the reference, in quote units", () => {
    // 18-decimal base, 6-decimal quote: $228.41 is 228_410000 raw USDG.
    expect(quoteCost(ONE_SHARE, NVDA_REF, 18, 6)).toBe(228_410000n);
  });

  test("rounds up, because the buyer pays the ceiling", () => {
    // One raw unit of an 18-decimal share is a vanishing amount of quote, and the buyer is
    // charged a whole unit for it rather than nothing. Rounding the other way would let a
    // sufficiently small order cross for free, one wei at a time.
    expect(quoteCost(1n, NVDA_REF, 18, 6)).toBe(1n);
  });

  test("an exact multiple is not rounded up", () => {
    const exact = quoteCost(ONE_SHARE, 2_000000000000000000n, 18, 6);
    expect(exact).toBe(2_000000n);
  });
});

describe("preflight — buys", () => {
  test("catches the shortfall that killed a window", () => {
    // The original: one share ordered against a note holding one dollar.
    const result = buy(ONE_SHARE, [note("1", "1000000")]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("A note is spent whole");
  });

  test("says what would fix it, in both directions", () => {
    const result = buy(ONE_SHARE, [note("1", "1000000")]);
    // Deposit more, or order less — the arithmetic the reader would otherwise have to do.
    expect(result.reason).toContain("deposit about");
    expect(result.reason).toContain("or order at most");
  });

  test("a comfortable note passes", () => {
    const result = buy(ONE_SHARE, [note("1", "500000000")]);
    expect(result.ok).toBe(true);
    expect(result.costRaw).toBe(228_410000n);
    // A note is spent whole, so the rest returns as a fresh note.
    expect(result.residualRaw).toBe(500_000000n - 228_410000n);
  });

  test("a note covering the cost but not the headroom is refused", () => {
    // Exactly the cost, no margin. The reference committed at seal is not the one showing now,
    // so this is the case the 2% exists for.
    const result = buy(ONE_SHARE, [note("1", "228410000")]);
    expect(result.ok).toBe(false);
  });

  test("a note just past the headroom is allowed", () => {
    const result = buy(ONE_SHARE, [note("1", "233000000")]);
    expect(result.ok).toBe(true);
  });

  test("spends the largest quote note, since a note is spent whole", () => {
    const result = buy(ONE_SHARE, [
      note("1", "300000000", { leafIndex: 1 }),
      note("1", "900000000", { leafIndex: 2 }),
    ]);
    expect(result.ok).toBe(true);
    expect(result.note?.leafIndex).toBe(2);
  });

  test("ignores a spent note", () => {
    // The tree is append-only, so a spent note scans exactly like a live one. Funding an order
    // from one seals, prices, matches and then fails to prove.
    const result = buy(ONE_SHARE, [note("1", "900000000", { spent: true })]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("holds no USDG note");
  });

  test("a buy is funded from quote, never from the traded asset", () => {
    // Funding both legs from a note of the traded asset is an order that proves and settles
    // while moving nothing — which is what a buy did once.
    const result = buy(ONE_SHARE, [note("3", "9000000000000000000")]);
    expect(result.ok).toBe(false);
  });

  test("passes without a reference rather than blocking, and says it is an estimate", () => {
    const result = preflight({
      side: "buy",
      assetId: "3",
      units: ONE_SHARE.toString(),
      notes: [note("1", "500000000")],
      poolAssets: ASSETS,
      quoteAssetId: 1,
      priceE18: () => 0n,
    });
    // A market endpoint that is briefly unavailable is not evidence the order is unaffordable,
    // and the circuit still has the last word.
    expect(result.ok).toBe(true);
    expect(result.estimated).toBe(true);
    expect(result.costRaw).toBeUndefined();
  });

  test("refuses when the network has no quote asset", () => {
    const result = preflight({
      side: "buy",
      assetId: "3",
      units: ONE_SHARE.toString(),
      notes: [note("1", "500000000")],
      poolAssets: ASSETS,
      quoteAssetId: null,
      priceE18: prices,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no quote asset");
  });
});

describe("preflight — sells", () => {
  test("needs one note covering the whole quantity", () => {
    const result = preflight({
      side: "sell",
      assetId: "3",
      units: ONE_SHARE.toString(),
      // Two half-share notes do not add up: a note is spent whole and only one funds an order.
      notes: [note("3", (ONE_SHARE / 2n).toString()), note("3", (ONE_SHARE / 2n).toString())],
      poolAssets: ASSETS,
      quoteAssetId: 1,
      priceE18: prices,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("No single note");
  });

  test("returns the residual when the note is larger than the order", () => {
    const result = preflight({
      side: "sell",
      assetId: "3",
      units: ONE_SHARE.toString(),
      notes: [note("3", (ONE_SHARE * 3n).toString())],
      poolAssets: ASSETS,
      quoteAssetId: 1,
      priceE18: prices,
    });
    expect(result.ok).toBe(true);
    expect(result.residualRaw).toBe(ONE_SHARE * 2n);
  });

  test("a sell needs no reference at all", () => {
    // The seller hands over base units; what they receive is decided at the committed reference,
    // so nothing here depends on the price showing now.
    const result = preflight({
      side: "sell",
      assetId: "3",
      units: ONE_SHARE.toString(),
      notes: [note("3", ONE_SHARE.toString())],
      poolAssets: ASSETS,
      quoteAssetId: 1,
      priceE18: () => 0n,
    });
    expect(result.ok).toBe(true);
  });
});

describe("preflight — input handling", () => {
  test("an empty quantity is not an error message about notes", () => {
    const result = buy(0n, [note("1", "500000000")]);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("greater than zero");
  });

  test("a huge quantity does not overflow into a pass", () => {
    // BigInt throughout: `units × price` for a million shares is ~2^100, which a JS number
    // would round silently and a rounded cost is a cost that can be wrong in the cheap
    // direction.
    const million = ONE_SHARE * 1_000_000n;
    const result = buy(million, [note("1", "500000000")]);
    expect(result.ok).toBe(false);
  });
});

/**
 * The suggestions have to be takeable.
 *
 * A pre-flight that says "deposit $232.98" and then refuses the order after somebody deposits
 * exactly $232.98 is worse than one that says nothing: it spends the user's money and their trust
 * to deliver the same refusal. The two figures round in opposite directions — the shortfall up,
 * the affordable quantity down — and the cost they are checked against rounds up again, so the
 * boundary is precisely where a click lands.
 */
describe("the suggestions on an unaffordable buy", () => {
  const short = () => buy(ONE_SHARE, [note("1", "1000000")]);

  test("both figures are returned, not only described in prose", () => {
    const r = short();
    expect(r.ok).toBe(false);
    expect(r.shortfallRaw).toBeGreaterThan(0n);
    expect(r.affordableRaw).toBeGreaterThanOrEqual(0n);
  });

  test("depositing exactly the shortfall makes the same order pass", () => {
    const r = short();
    const funded = 1_000000n + r.shortfallRaw!;
    expect(buy(ONE_SHARE, [note("1", funded.toString())]).ok).toBe(true);
  });

  test("one unit less than the shortfall still fails", () => {
    // Pins the ceiling. If the shortfall rounded down this would pass and the figure would be
    // arbitrary rather than minimal.
    const r = short();
    const under = 1_000000n + r.shortfallRaw! - 1n;
    expect(buy(ONE_SHARE, [note("1", under.toString())]).ok).toBe(false);
  });

  test("ordering exactly the affordable quantity passes with the note already held", () => {
    const r = short();
    expect(buy(r.affordableRaw!, [note("1", "1000000")]).ok).toBe(true);
  });

  test("one unit more than the affordable quantity fails", () => {
    const r = short();
    expect(buy(r.affordableRaw! + 1n, [note("1", "1000000")]).ok).toBe(false);
  });

  test("holds across a spread of note sizes and order sizes", () => {
    // The off-by-one only shows at particular ratios, so sweep rather than trust one case.
    for (const held of [1_000000n, 7_777777n, 250_000000n, 999_999999n]) {
      for (const want of [ONE_SHARE / 10n, ONE_SHARE, 13n * ONE_SHARE]) {
        const r = buy(want, [note("1", held.toString())]);
        if (r.ok) continue;
        if (r.affordableRaw! > 0n) {
          expect(buy(r.affordableRaw!, [note("1", held.toString())]).ok).toBe(true);
        }
        const funded = held + r.shortfallRaw!;
        expect(buy(want, [note("1", funded.toString())]).ok).toBe(true);
      }
    }
  });
});
