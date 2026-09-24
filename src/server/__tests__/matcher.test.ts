import { describe, expect, test } from "bun:test";
import {
  checkInvariants,
  matchWindow,
  proRata,
  quoteValue,
  type AssetReference,
  type MatchOrder,
  type QuoteReference,
} from "../matcher";

/**
 * The matcher's invariants.
 *
 * These are the same six properties `scripts/demo-market.test.mjs` asserted against the
 * simulation — conservation, residuals, per-asset deferral, rejection, zero-match, replay safety
 * — restated in raw integer units against the real matcher. The difference that matters: the
 * demo compared floats with a 1e-7 tolerance. Here every equality is exact, because the circuit
 * enforces them in field arithmetic where "close enough" does not exist.
 */

// Stock tokens are 18 decimals on Robinhood Chain; USDG is 6. Prices are 1e18-scaled USD.
const QUOTE: QuoteReference = { price1e18: 999_991_430_000_000_000n, decimals: 6 };
const UNIT = 10n ** 18n;

const asset = (
  assetId: number,
  dollars: number,
  over: Partial<AssetReference> = {},
): AssetReference => ({
  assetId,
  price1e18: BigInt(Math.round(dollars * 1e6)) * 10n ** 12n,
  decimals: 18,
  deferred: false,
  ...over,
});

const NVDA = asset(1, 222.45);
const AAPL = asset(2, 335.38);

let seq = 0;
const order = (assetId: number, side: "buy" | "sell", units: bigint): MatchOrder => ({
  seq: seq++,
  assetId,
  side,
  quantity: units,
});
const reset = () => (seq = 0);

describe("pro-rata allocation", () => {
  test("shares sum to the total exactly, with no drift", () => {
    // Three equal orders over a total that does not divide by three is the case that breaks a
    // naive floor-each-share implementation: it would allocate 99 and lose one unit.
    const shares = proRata(
      [
        { seq: 0, weight: 100n },
        { seq: 1, weight: 100n },
        { seq: 2, weight: 100n },
      ],
      100n,
    );
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n);
    // The odd unit goes to the lowest seq, deterministically.
    expect(shares).toEqual([34n, 33n, 33n]);
  });

  test("is proportional to weight", () => {
    const shares = proRata(
      [
        { seq: 0, weight: 100n },
        { seq: 1, weight: 300n },
      ],
      200n,
    );
    expect(shares).toEqual([50n, 150n]);
  });

  test("ties break on seq, so the result never depends on iteration order", () => {
    const a = proRata(
      [
        { seq: 5, weight: 1n },
        { seq: 2, weight: 1n },
      ],
      1n,
    );
    // The lower seq takes the odd unit regardless of the order the entries arrive in.
    expect(a).toEqual([0n, 1n]);
  });

  test("allocating the whole weight fills everyone completely", () => {
    const weights = [
      { seq: 0, weight: 7n },
      { seq: 1, weight: 13n },
    ];
    expect(proRata(weights, 20n)).toEqual([7n, 13n]);
  });

  test("allocating zero gives everyone zero", () => {
    expect(proRata([{ seq: 0, weight: 5n }], 0n)).toEqual([0n]);
  });

  test("refuses to allocate more than exists", () => {
    expect(() => proRata([{ seq: 0, weight: 5n }], 6n)).toThrow(/more than the total/);
  });

  test("no share exceeds its own weight", () => {
    // Otherwise an order could be filled for more than it asked — a mint.
    const weights = [
      { seq: 0, weight: 1n },
      { seq: 1, weight: 1n },
      { seq: 2, weight: 97n },
    ];
    const shares = proRata(weights, 3n);
    shares.forEach((s, i) => expect(s <= weights[i]!.weight).toBe(true));
  });
});

describe("quote conversion", () => {
  test("crosses the 18/8/6 decimal boundary without losing scale", () => {
    // One whole NVDA token at $222.45, quoted in 6-decimal USDG at a peg just under $1.
    const value = quoteValue(UNIT, NVDA, QUOTE, "floor");
    expect(value).toBeGreaterThan(222_000_000n);
    expect(value).toBeLessThan(223_000_000n);
  });

  test("ceil is never below floor, and never more than one unit above", () => {
    for (const units of [1n, 7n, UNIT / 3n, UNIT, 12345n * UNIT]) {
      const floor = quoteValue(units, NVDA, QUOTE, "floor");
      const ceil = quoteValue(units, NVDA, QUOTE, "ceil");
      expect(ceil >= floor).toBe(true);
      expect(ceil - floor <= 1n).toBe(true);
    }
  });

  test("zero units is zero value in both directions", () => {
    expect(quoteValue(0n, NVDA, QUOTE, "ceil")).toBe(0n);
    expect(quoteValue(0n, NVDA, QUOTE, "floor")).toBe(0n);
  });

  test("multiplies before dividing, so a small order is not truncated to nothing", () => {
    // A naive (units / 1e18) * price would make every sub-token order worth zero.
    expect(quoteValue(UNIT / 1000n, NVDA, QUOTE, "floor")).toBeGreaterThan(0n);
  });

  test("a zero quote reference is an error, not a division by zero", () => {
    expect(() => quoteValue(UNIT, NVDA, { price1e18: 0n, decimals: 6 }, "floor")).toThrow(/zero/);
  });
});

describe("crossing", () => {
  test("matched size is the smaller side, and both sides fill to it", () => {
    reset();
    const orders = [order(1, "buy", 10n * UNIT), order(1, "sell", 4n * UNIT)];
    const result = matchWindow(orders, [NVDA], QUOTE);

    expect(result.assets[0]!.matched).toBe(4n * UNIT);
    const buy = result.fills.find((f) => f.side === "buy")!;
    const sell = result.fills.find((f) => f.side === "sell")!;
    expect(buy.filled).toBe(4n * UNIT);
    expect(buy.residual).toBe(6n * UNIT);
    expect(buy.reason).toBe("partial");
    expect(sell.filled).toBe(4n * UNIT);
    expect(sell.reason).toBe("matched");
    expect(checkInvariants(result)).toEqual([]);
  });

  test("a one-sided book crosses nothing and everyone rests", () => {
    reset();
    const result = matchWindow([order(1, "buy", 5n * UNIT)], [NVDA], QUOTE);
    expect(result.assets[0]!.matched).toBe(0n);
    expect(result.fills[0]!.reason).toBe("unmatched");
    expect(result.fills[0]!.residual).toBe(5n * UNIT);
    expect(result.paid).toBe(0n);
    expect(checkInvariants(result)).toEqual([]);
  });

  test("the long side shares pro-rata rather than first-come", () => {
    reset();
    const orders = [
      order(1, "buy", 10n * UNIT),
      order(1, "buy", 30n * UNIT),
      order(1, "sell", 20n * UNIT),
    ];
    const result = matchWindow(orders, [NVDA], QUOTE);
    const buys = result.fills.filter((f) => f.side === "buy");
    // 1:3 of 20, not 10-then-10: arriving first must buy nothing.
    expect(buys[0]!.filled).toBe(5n * UNIT);
    expect(buys[1]!.filled).toBe(15n * UNIT);
    expect(checkInvariants(result)).toEqual([]);
  });

  test("a deferred asset rests entirely while every other asset crosses", () => {
    // Acceptance criterion 3, in matcher form.
    reset();
    const orders = [
      order(1, "buy", 5n * UNIT),
      order(1, "sell", 5n * UNIT),
      order(2, "buy", 5n * UNIT),
      order(2, "sell", 5n * UNIT),
    ];
    const deferred: AssetReference = { ...NVDA, deferred: true, deferReason: "event" };
    const result = matchWindow(orders, [deferred, AAPL], QUOTE);

    const nvda = result.fills.filter((f) => f.assetId === 1);
    const aapl = result.fills.filter((f) => f.assetId === 2);
    expect(nvda.every((f) => f.filled === 0n && f.reason === "event")).toBe(true);
    expect(nvda.every((f) => f.residual === f.quantity)).toBe(true);
    expect(aapl.every((f) => f.filled === 5n * UNIT && f.reason === "matched")).toBe(true);
    expect(checkInvariants(result)).toEqual([]);
  });

  test("a stale asset reports stale, not merely unmatched", () => {
    // The dashboard renders these as different states, and the circuit constrains the reason to
    // agree with the defer bit — so an honest label here is a proven claim later.
    reset();
    const orders = [order(1, "buy", UNIT), order(1, "sell", UNIT)];
    const result = matchWindow(orders, [{ ...NVDA, deferred: true, deferReason: "stale" }], QUOTE);
    expect(result.fills.every((f) => f.reason === "stale")).toBe(true);
  });

  test("an order for an asset with no committed reference is an error, not a silent skip", () => {
    reset();
    expect(() => matchWindow([order(9, "buy", UNIT)], [NVDA], QUOTE)).toThrow(
      /no committed reference/,
    );
  });

  test("an empty window is a clean no-op", () => {
    const result = matchWindow([], [NVDA], QUOTE);
    expect(result.fills).toEqual([]);
    expect(result.dust).toBe(0n);
    expect(checkInvariants(result)).toEqual([]);
  });
});

describe("value conservation", () => {
  test("what buyers pay equals what sellers receive, plus dust — exactly", () => {
    reset();
    const orders = [
      order(1, "buy", 7n * UNIT),
      order(1, "buy", 3n * UNIT),
      order(1, "sell", 4n * UNIT),
      order(1, "sell", 6n * UNIT),
      order(2, "buy", 11n * UNIT),
      order(2, "sell", 5n * UNIT),
    ];
    const result = matchWindow(orders, [NVDA, AAPL], QUOTE);
    expect(result.paid).toBe(result.received + result.dust);
    expect(checkInvariants(result)).toEqual([]);
  });

  test("dust is bounded by one unit per filled order, and never negative", () => {
    // Each buyer's ceiling exceeds the matching floor by at most 1, so the residue cannot grow
    // with notional — only with the number of fills.
    reset();
    const orders = [
      ...Array.from({ length: 8 }, () => order(1, "buy", 3n * UNIT + 7n)),
      ...Array.from({ length: 5 }, () => order(1, "sell", 5n * UNIT + 11n)),
    ];
    const result = matchWindow(orders, [NVDA], QUOTE);
    const filledOrders = result.fills.filter((f) => f.filled > 0n).length;
    expect(result.dust >= 0n).toBe(true);
    expect(result.dust <= BigInt(filledOrders)).toBe(true);
    expect(checkInvariants(result)).toEqual([]);
  });

  test("buyers are never charged less than the reference value of what they got", () => {
    reset();
    const orders = [order(1, "buy", 3n * UNIT + 1n), order(1, "sell", 3n * UNIT + 1n)];
    const result = matchWindow(orders, [NVDA], QUOTE);
    const buy = result.fills.find((f) => f.side === "buy")!;
    expect(buy.quote).toBe(quoteValue(buy.filled, NVDA, QUOTE, "ceil"));
  });

  test("sellers are never paid more than the reference value of what they gave up", () => {
    reset();
    const orders = [order(1, "buy", 3n * UNIT + 1n), order(1, "sell", 3n * UNIT + 1n)];
    const result = matchWindow(orders, [NVDA], QUOTE);
    const sell = result.fills.find((f) => f.side === "sell")!;
    expect(sell.quote).toBe(quoteValue(sell.filled, NVDA, QUOTE, "floor"));
  });
});

describe("determinism", () => {
  test("replaying a window produces an identical result", () => {
    // The property the whole proving pipeline rests on: a window that crashed mid-prove must be
    // re-provable, which means the matcher must return the same answer on the same book.
    reset();
    const orders = [
      order(1, "buy", 13n * UNIT),
      order(2, "sell", 7n * UNIT),
      order(1, "sell", 9n * UNIT),
      order(2, "buy", 4n * UNIT),
      order(1, "buy", 2n * UNIT),
    ];
    const a = matchWindow(orders, [NVDA, AAPL], QUOTE);
    const b = matchWindow(orders, [NVDA, AAPL], QUOTE);
    const show = (x: unknown) =>
      JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(show(a)).toBe(show(b));
  });

  test("the order the book is read in does not change the outcome", () => {
    // Orders arrive from Postgres in whatever order the planner chose. `seq` is the authority.
    reset();
    const orders = [
      order(1, "buy", 5n * UNIT),
      order(1, "buy", 3n * UNIT),
      order(1, "sell", 6n * UNIT),
      order(1, "buy", 1n * UNIT),
    ];
    const show = (x: unknown) =>
      JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const forward = matchWindow(orders, [NVDA], QUOTE);
    const reversed = matchWindow([...orders].reverse(), [NVDA], QUOTE);
    const shuffled = matchWindow([orders[2]!, orders[0]!, orders[3]!, orders[1]!], [NVDA], QUOTE);
    expect(show(reversed)).toBe(show(forward));
    expect(show(shuffled)).toBe(show(forward));
  });

  test("the asset the book is listed in does not change the outcome", () => {
    reset();
    const orders = [
      order(2, "buy", 5n * UNIT),
      order(1, "sell", 5n * UNIT),
      order(1, "buy", 5n * UNIT),
      order(2, "sell", 5n * UNIT),
    ];
    const show = (x: unknown) =>
      JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(show(matchWindow(orders, [NVDA, AAPL], QUOTE))).toBe(
      show(matchWindow(orders, [AAPL, NVDA], QUOTE)),
    );
  });
});

describe("fuzzed books", () => {
  // Deterministic PRNG: a failure must be reproducible from the test file alone.
  function lcg(seed: number) {
    let state = seed >>> 0;
    return () => (state = (state * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000;
  }

  test("invariants hold across 400 random books", () => {
    for (let round = 0; round < 400; round++) {
      const rand = lcg(round + 1);
      reset();
      const orders: MatchOrder[] = [];
      const count = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < count; i++) {
        const assetId = rand() < 0.5 ? 1 : 2;
        const side = rand() < 0.5 ? "buy" : "sell";
        // Spans sub-unit dust through institutional size, including awkward remainders.
        const magnitude = BigInt(Math.floor(rand() * 1e9) + 1);
        const scale = [1n, 10n ** 6n, 10n ** 12n, UNIT][Math.floor(rand() * 4)]!;
        orders.push({ seq: i, assetId, side, quantity: magnitude * scale + 1n });
      }
      const refs = [
        { ...NVDA, deferred: rand() < 0.15, deferReason: "stale" as const },
        { ...AAPL, deferred: rand() < 0.15, deferReason: "event" as const },
      ];
      const result = matchWindow(orders, refs, QUOTE);
      const problems = checkInvariants(result);
      expect(problems).toEqual([]);
    }
  });

  test("no book ever fills more than was ordered, in aggregate or individually", () => {
    for (let round = 0; round < 200; round++) {
      const rand = lcg(round + 9001);
      reset();
      const orders = Array.from({ length: 1 + Math.floor(rand() * 10) }, (_, i) => ({
        seq: i,
        assetId: 1,
        side: (rand() < 0.5 ? "buy" : "sell") as "buy" | "sell",
        quantity: BigInt(Math.floor(rand() * 1e12) + 1),
      }));
      const result = matchWindow(orders, [NVDA], QUOTE);
      const orderedTotal = orders.reduce((a, o) => a + o.quantity, 0n);
      const filledTotal = result.fills.reduce((a, f) => a + f.filled, 0n);
      expect(filledTotal <= orderedTotal).toBe(true);
      for (const fill of result.fills) expect(fill.filled <= fill.quantity).toBe(true);
    }
  });
});
