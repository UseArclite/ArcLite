/**
 * The four steps between arriving and having traded.
 *
 * The dashboard's empty states are honest — *"No shielded notes found for this vault"* — and
 * honesty is not orientation. Nothing on the page said that the sequence is connect, unlock,
 * deposit, submit, or that the vault being empty is the expected state on arrival rather than a
 * failure. A first-time visitor with an open, empty vault was told a true fact about their
 * balance and nothing about what to do with it.
 *
 * This got more necessary after the terminal redesign, not less: folding the explanations behind
 * summaries removed the accidental teaching that the long paragraphs were doing, which is a fair
 * trade only if something deliberate replaces it.
 *
 * ## Why it can also say "not here"
 *
 * On a network where the pool is not deployed the four steps are not a path, they are a list of
 * things that will not work. A checklist that instructed somebody to deposit into a pool that
 * does not exist would be worse than the bare empty state it replaced — it would be confidently
 * wrong rather than merely unhelpful. So the undeployed case is a state of its own.
 */

export type StepState = "done" | "current" | "todo";

export interface OnboardingStep {
  key: "connect" | "unlock" | "deposit" | "order";
  title: string;
  /** What this step is for, in one line. Shown only for the step in hand. */
  detail: string;
  state: StepState;
}

export interface OnboardingInput {
  /** A wallet is connected to the site. */
  connected: boolean;
  /** The vault worker holds keys — the signature has been given. */
  unlocked: boolean;
  /** This vault owns at least one unspent note. */
  hasNotes: boolean;
  /** At least one order has been submitted from this vault, ever. */
  hasOrdered: boolean;
  /** Whether there is a pool on this network at all. */
  deployed: boolean;
}

export interface Onboarding {
  steps: OnboardingStep[];
  /** Nothing left to guide: the whole path has been walked once. */
  complete: boolean;
  /** No pool on this network, so the path does not exist here. */
  unavailable: boolean;
  /** The step the visitor is on, or null when complete or unavailable. */
  current: OnboardingStep | null;
}

const COPY: Record<OnboardingStep["key"], { title: string; detail: string }> = {
  connect: {
    title: "Connect MetaMask",
    detail: "Nothing is signed and no transaction is approved by connecting.",
  },
  unlock: {
    title: "Open your vault",
    detail:
      "One signature derives your viewing keys. They stay in this browser and move no funds — the vault finds your notes locally, so no server learns which are yours.",
  },
  deposit: {
    title: "Deposit into the pool",
    detail:
      "An approval and a deposit. What reaches the chain is a commitment: the pool learns the asset and the amount, and nothing about who owns it afterwards.",
  },
  order: {
    title: "Submit a sealed order",
    detail:
      "Encrypted in your vault before it is sent, and unreadable by anyone — us included — until the window's book closes.",
  },
};

export function onboarding(input: OnboardingInput): Onboarding {
  const { connected, unlocked, hasNotes, hasOrdered, deployed } = input;

  // The order is the order, and a step counts as done only when it *and everything before it* is
  // satisfied. Checking each against its immediate predecessor is not enough: local storage
  // outlives a disconnect, so "has notes, has ordered, not connected" is a real state, and it
  // would otherwise render the last step done while the first was still current.
  const reached = [connected, unlocked, hasNotes, hasOrdered];
  const done = reached.map((_, i) => reached.slice(0, i + 1).every(Boolean));
  const firstUndone = done.findIndex((d) => !d);
  const complete = firstUndone === -1;

  const keys: OnboardingStep["key"][] = ["connect", "unlock", "deposit", "order"];
  const steps = keys.map((key, i) => ({
    key,
    ...COPY[key],
    state: (done[i] ? "done" : i === firstUndone ? "current" : "todo") as StepState,
  }));

  // Checked after the steps are built rather than before: the caller may still want to render
  // how far somebody got, and "connected" is true on an undeployed network too.
  if (!deployed) {
    return { steps, complete: false, unavailable: true, current: null };
  }

  return {
    steps,
    complete,
    unavailable: false,
    current: complete ? null : (steps[firstUndone] ?? null),
  };
}
