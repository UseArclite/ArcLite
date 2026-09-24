import { describe, expect, test } from "bun:test";
import { readSpent, type SpentReader } from "../spent-check";

/**
 * The regression this file exists for.
 *
 * A note spent in window 223 was offered back to its owner, and the venue refused it with "this
 * note has already been offered" — after the trader had committed to the order. The pool was
 * right: `nullifierSpent(0x29afec…)` was true on chain and had been since settlement.
 *
 * The vault asked through the wallet's public client, and the guard read
 *
 *     if (!pool || !publicClient || nullifiers.length === 0) return nullifiers.map(() => false);
 *
 * so whenever that client had not resolved, every note came back "not spent". The catch eleven
 * lines below did the opposite and explained why. The early return had simply never been read as
 * part of the same decision.
 *
 * Every test here is a way of not being able to ask. That is the whole point: the answerable case
 * is easy and was never wrong.
 */

const N = (n: number) =>
  Array.from({ length: n }, (_, i) => `0x${String(i).padStart(64, "0")}` as `0x${string}`);

const answers =
  (flags: boolean[]): SpentReader =>
  async () =>
    flags;

describe("when the chain cannot be asked", () => {
  test("a missing reader hides every note — the exact case that shipped the bug", () => {
    // `publicClient` undefined while wagmi settles, which is the instant the first scan runs.
    expect(readSpent(N(3), { poolDeployed: true, read: null })).resolves.toEqual({
      flags: [true, true, true],
      conclusive: false,
    });
  });

  test("a throwing reader hides every note", async () => {
    const boom: SpentReader = async () => {
      throw new Error("RPC unreachable");
    };
    const r = await readSpent(N(2), { poolDeployed: true, read: boom });
    expect(r.flags).toEqual([true, true]);
    expect(r.conclusive).toBe(false);
  });

  test("a short answer hides every note", async () => {
    // The caller indexes positionally, so a missing entry would read as undefined and fall
    // through to whatever default the call site used — the same bug in a different shape.
    const r = await readSpent(N(3), { poolDeployed: true, read: answers([true, false]) });
    expect(r.flags).toEqual([true, true, true]);
    expect(r.conclusive).toBe(false);
  });

  test("a long answer hides every note", async () => {
    const r = await readSpent(N(2), { poolDeployed: true, read: answers([true, false, false]) });
    expect(r.conclusive).toBe(false);
  });

  test("a non-boolean answer hides every note", async () => {
    // An RPC answering with something unexpected has not said the note is unspent. It has said
    // nothing, and nothing is not permission to spend.
    const junk = [null, undefined] as unknown as boolean[];
    const r = await readSpent(N(2), { poolDeployed: true, read: answers(junk) });
    expect(r.flags).toEqual([true, true]);
    expect(r.conclusive).toBe(false);
  });

  test("never answers 'unspent' for any unreadable case", async () => {
    // The invariant, stated once over every failure shape, so a future branch that returns
    // `false` from an unknown case fails here rather than on someone's wallet.
    const unreadable: SpentReader[] = [
      async () => {
        throw new Error("network");
      },
      answers([]),
      answers([true]),
      answers([null as unknown as boolean, false]),
    ];
    for (const read of unreadable) {
      const r = await readSpent(N(2), { poolDeployed: true, read });
      expect(r.conclusive).toBe(false);
      expect(r.flags.every((f) => f === true)).toBe(true);
    }
  });
});

describe("when the chain answers", () => {
  test("its answer is used verbatim and reported conclusive", async () => {
    const r = await readSpent(N(3), { poolDeployed: true, read: answers([false, true, false]) });
    expect(r).toEqual({ flags: [false, true, false], conclusive: true });
  });

  test("the reader is given exactly the nullifiers it was asked about", async () => {
    let seen: readonly string[] = [];
    const spy: SpentReader = async (list) => {
      seen = list;
      return list.map(() => false);
    };
    const nullifiers = N(4);
    await readSpent(nullifiers, { poolDeployed: true, read: spy });
    expect(seen).toEqual(nullifiers);
  });
});

describe("the cases that are genuinely knowable without a read", () => {
  test("no notes is not a question", async () => {
    const r = await readSpent([], { poolDeployed: true, read: null });
    expect(r).toEqual({ flags: [], conclusive: true });
  });

  test("no pool means nothing can have been spent, and that is knowledge", async () => {
    // The one place "unspent" is an answer rather than a guess: a network with no pool has never
    // settled anything. Hiding notes here would strand a testnet vault for no reason.
    const r = await readSpent(N(2), { poolDeployed: false, read: null });
    expect(r).toEqual({ flags: [false, false], conclusive: true });
  });
});
