import { describe, expect, test } from "bun:test";
import { onboarding } from "../onboarding";

/**
 * The property worth protecting is that exactly one step is ever current, and that it is the
 * right one. A checklist that highlights two steps, or highlights "deposit" to somebody with no
 * wallet connected, is worse than no checklist: it sends people to a control that will not work
 * and teaches them the venue is broken.
 */

const at = (over: Partial<Parameters<typeof onboarding>[0]> = {}) =>
  onboarding({
    connected: false,
    unlocked: false,
    hasNotes: false,
    hasOrdered: false,
    deployed: true,
    ...over,
  });

const states = (o: ReturnType<typeof onboarding>) => o.steps.map((s) => s.state).join(",");

describe("walking the path", () => {
  test("a stranger starts at connect", () => {
    expect(states(at())).toBe("current,todo,todo,todo");
    expect(at().current?.key).toBe("connect");
  });

  test("connected, not unlocked", () => {
    expect(states(at({ connected: true }))).toBe("done,current,todo,todo");
  });

  test("unlocked and empty — the state the dashboard explained worst", () => {
    const o = at({ connected: true, unlocked: true });
    expect(states(o)).toBe("done,done,current,todo");
    expect(o.current?.key).toBe("deposit");
  });

  test("deposited, ready to trade", () => {
    const o = at({ connected: true, unlocked: true, hasNotes: true });
    expect(states(o)).toBe("done,done,done,current");
    expect(o.current?.key).toBe("order");
  });

  test("the whole path walked once leaves nothing to guide", () => {
    const o = at({ connected: true, unlocked: true, hasNotes: true, hasOrdered: true });
    expect(o.complete).toBe(true);
    expect(o.current).toBeNull();
    expect(states(o)).toBe("done,done,done,done");
  });
});

describe("exactly one step is current", () => {
  test("across every reachable combination", () => {
    for (const connected of [false, true])
      for (const unlocked of [false, true])
        for (const hasNotes of [false, true])
          for (const hasOrdered of [false, true]) {
            const o = at({ connected, unlocked, hasNotes, hasOrdered });
            const currents = o.steps.filter((s) => s.state === "current").length;
            expect(currents).toBe(o.complete ? 0 : 1);
          }
  });

  test("a later step cannot be done while an earlier one is not", () => {
    // Local storage can outlive a disconnect, so notes without a connection is a real state.
    // It must not mark "deposit" done and point at "order" — the deposit control needs a wallet.
    const o = at({ hasNotes: true, hasOrdered: true });
    expect(o.current?.key).toBe("connect");
    expect(states(o)).toBe("current,todo,todo,todo");
  });
});

describe("a network with no pool", () => {
  test("is a state of its own, not a list of instructions that will fail", () => {
    const o = at({ connected: true, unlocked: true, deployed: false });
    expect(o.unavailable).toBe(true);
    expect(o.current).toBeNull();
    expect(o.complete).toBe(false);
  });

  test("still reports how far somebody got", () => {
    // The caller may want to show it; what it must not do is tell them to deposit.
    expect(states(at({ connected: true, deployed: false }))).toBe("done,current,todo,todo");
  });
});
