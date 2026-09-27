import { describe, expect, test } from "bun:test";
import {
  assessOrdering,
  summariseOrdering,
  type ChainStep,
  type WindowOrdering,
} from "../ordering";

/**
 * This module makes the venue's strongest claim, so the tests are mostly about it refusing to.
 *
 * A panel that can only report good news is decoration. The failure that matters is not a missed
 * proof — it is a verdict of "proven" produced by something weaker than a proof: two transactions
 * in one block, a missing seal, or an ordering that actually ran backwards and got averaged away
 * inside a percentage.
 */

const step = (blockNumber: number, timestamp: number, hash = "0xabc"): ChainStep => ({
  hash,
  blockNumber,
  timestamp,
});

const w = (over: Partial<WindowOrdering> = {}): WindowOrdering => ({
  seq: 292,
  seal: step(70887620, 1790204171),
  price: step(70887675, 1790204177),
  settle: step(70887969, 1790204207),
  ...over,
});

describe("the verdict is block order", () => {
  test("a later price block proves the ordering", () => {
    const r = assessOrdering(w());
    expect(r.verdict).toBe("proven");
    expect(r.blockGap).toBe(55);
    expect(r.seconds).toBe(6);
    expect(r.statement).toContain("cannot have informed the seal");
  });

  test("the same block is not a proof", () => {
    // Order within a block is transaction index, and both transactions are ours to submit — so
    // citing it would be citing our own ordering.
    const r = assessOrdering(w({ price: step(70887620, 1790204171) }));
    expect(r.verdict).toBe("same-block");
    expect(r.statement).toContain("does not by itself demonstrate it");
  });

  test("a price before the seal is reported as wrong, not hidden", () => {
    const r = assessOrdering(w({ price: step(70887600, 1790204160) }));
    expect(r.verdict).toBe("inverted");
    expect(r.statement).toContain("wrong order");
  });

  test("timestamps never decide it", () => {
    // A sequencer writes the timestamp; the chain decides the block order. A later block with an
    // equal or earlier timestamp is still proof.
    const r = assessOrdering(w({ price: step(70887675, 1790204171) }));
    expect(r.verdict).toBe("proven");
    expect(r.seconds).toBe(0);
  });

  test("a missing seal or price is incomplete, not passing", () => {
    expect(assessOrdering(w({ seal: null })).verdict).toBe("incomplete");
    expect(assessOrdering(w({ price: null })).verdict).toBe("incomplete");
  });

  test("settlement is not required for the claim", () => {
    // The guarantee is about seal versus price. A window still proving is already decided.
    expect(assessOrdering(w({ settle: null })).verdict).toBe("proven");
  });
});

describe("the summary is the worst case", () => {
  const proven = assessOrdering(w());
  const same = assessOrdering(w({ seq: 1, price: step(70887620, 1790204171) }));
  const bad = assessOrdering(w({ seq: 2, price: step(70887600, 1790204160) }));
  const none = assessOrdering(w({ seq: 3, seal: null }));

  test("one inverted window outranks any number of good ones", () => {
    // The regression that makes this decoration: a failure averaged into a percentage.
    const s = summariseOrdering([proven, proven, proven, bad]);
    expect(s.verdict).toBe("inverted");
    expect(s.headline).toContain("1 of 4");
  });

  test("a same-block window stops the headline claiming all", () => {
    const s = summariseOrdering([proven, same]);
    expect(s.verdict).toBe("same-block");
    expect(s.headline).toContain("1 of 2");
  });

  test("all proven says so, and counts only usable windows", () => {
    const s = summariseOrdering([proven, proven, none]);
    expect(s.verdict).toBe("proven");
    expect(s.checked).toBe(2);
    expect(s.headline).toContain("All 2 windows checked");
  });

  test("the headline says checked, not settled", () => {
    // Windows that sealed and priced but never settled are counted, because the guarantee is about
    // seal versus price — so claiming they settled would contradict the row beneath saying so.
    expect(summariseOrdering([proven, proven]).headline).not.toContain("settled");
  });

  test("one window is singular", () => {
    expect(summariseOrdering([proven]).headline).toContain("The one window checked");
  });

  test("nothing to check says nothing was checked", () => {
    const s = summariseOrdering([none]);
    expect(s.verdict).toBe("incomplete");
    expect(s.checked).toBe(0);
  });
});
