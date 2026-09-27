/**
 * Getting somebody from arriving to holding a private position, without asking them to decide
 * anything.
 *
 * The four steps already exist as a checklist in `onboarding.ts` — connect, unlock, deposit,
 * order — and a checklist is a large improvement on an honest empty state. It is still a list of
 * instructions: it tells somebody to deposit, and leaves them to open the deposit panel, work out
 * what a sensible amount is at eighteen decimals, and then work out an order size that the
 * resulting note can actually fund.
 *
 * That last part is where first attempts die. A note is spent whole, the quote asset has six
 * decimals and the equities eighteen, and a buy of one whole share of NVDA costs over two hundred
 * dollars — so the obvious first order is both enormous and unfundable, and the pre-flight
 * correctly refuses it. Somebody meeting that on their first try reasonably concludes the venue is
 * broken.
 *
 * So this computes both amounts from the live reference price and hands them over as fixed
 * quantities: deposit *this*, then order *that*. Nothing is typed and nothing can disagree,
 * because the order size is derived from the deposit rather than chosen next to it.
 *
 * ## Why the numbers are this small
 *
 * A dollar, and a first order of a quarter of it. Small enough that trying the venue is not a
 * financial decision, large enough to be a real trade on mainnet against a real tokenized equity —
 * which is the entire claim. The four-times headroom over the order is deliberate: `preflight`
 * requires the funding note to cover the cost with room to spare, and a first attempt that fails
 * its own pre-flight check is worse than no guidance at all.
 */

/** What we ask somebody to bring, in cents. Integers throughout: money is not a float. */
export const DEPOSIT_CENTS = 100n;

/** What the first order spends, in cents. A quarter of the deposit — see the headroom note above. */
export const ORDER_CENTS = 25n;

export interface QuickstartInput {
  /** Reference price of the asset being bought, 1e18-scaled USD per whole token. */
  priceE18: bigint;
  /** Decimals of the asset being bought. */
  baseDecimals: number;
  /** Decimals of the quote asset. */
  quoteDecimals: number;
}

export interface QuickstartPlan {
  ok: boolean;
  /** Why not, when not. */
  reason?: string;
  /** Raw quote units to deposit. */
  depositRaw: bigint;
  /** Raw base units the first order buys. */
  orderRaw: bigint;
}

/**
 * The two amounts.
 *
 * `orderRaw` is a closed form rather than a search. One cent is `1e16` at 1e18 scale, so the cost
 * of `q` raw base units is `q * priceE18 / 10^baseDecimals`, and inverting it gives
 * `q = cents * 1e16 * 10^baseDecimals / priceE18`. Floor division is the right direction: rounding
 * up would produce an order that costs marginally more than the budget it was derived from, which
 * is exactly the kind of one-unit overshoot that made the pre-flight refuse a whole window.
 */
export function quickstartPlan({
  priceE18,
  baseDecimals,
  quoteDecimals,
}: QuickstartInput): QuickstartPlan {
  const depositRaw = (DEPOSIT_CENTS * 10n ** BigInt(quoteDecimals)) / 100n;

  // No price, no plan. Guessing a size here would put a number on screen that the order panel's
  // own pre-flight would then reject, and the visitor would have no way to tell which was wrong.
  if (priceE18 <= 0n) {
    return {
      ok: false,
      reason: "The reference price for this asset has not loaded yet.",
      depositRaw,
      orderRaw: 0n,
    };
  }

  const orderRaw = (ORDER_CENTS * 10n ** 16n * 10n ** BigInt(baseDecimals)) / priceE18;

  // A price high enough to make a quarter round to nothing. Not reachable with real equities at
  // eighteen decimals, and the check costs one comparison — an order of zero units submits, seals
  // and crosses for nothing, which looks like a venue that does not work.
  if (orderRaw <= 0n) {
    return {
      ok: false,
      reason: "This asset is priced too high to buy a meaningful fraction of at this size.",
      depositRaw,
      orderRaw: 0n,
    };
  }

  return { ok: true, depositRaw, orderRaw };
}

export type QuickstartStep = "connect" | "unlock" | "deposit" | "order" | "settling" | "done";

export interface QuickstartState {
  connected: boolean;
  unlocked: boolean;
  /** This vault holds a note that could fund the first order. */
  funded: boolean;
  /** An order has been submitted in this session. */
  ordered: boolean;
  /** That order has an outcome. */
  resolved: boolean;
}

/**
 * Which step is in hand.
 *
 * Derived from state rather than advanced by the buttons, so a visitor who deposited in the
 * ordinary panel — or in a previous session — is not asked to do it again. The flow follows what
 * is true, not what it remembers telling somebody.
 */
export function quickstartStep(s: QuickstartState): QuickstartStep {
  if (!s.connected) return "connect";
  if (!s.unlocked) return "unlock";
  if (s.resolved) return "done";
  if (s.ordered) return "settling";
  if (!s.funded) return "deposit";
  return "order";
}

/** How far along, for a progress indicator. `done` is 5 of 5. */
export function quickstartProgress(step: QuickstartStep): number {
  return { connect: 0, unlock: 1, deposit: 2, order: 3, settling: 4, done: 5 }[step];
}
