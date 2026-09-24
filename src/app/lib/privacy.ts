/**
 * How private a position on this venue actually is, right now.
 *
 * Every shielded pool's privacy is a function of how many other notes yours is indistinguishable
 * from, and at launch that number is small. `plan.md` says so directly — *"do not oversell this
 * in the UI"* — and the dashboard neither oversold it nor explained it: the anonymity set was a
 * bare integer beside the word "Anonymity set", which tells somebody nothing about whether 47 is
 * a lot.
 *
 * So this says. Including, and especially, when the answer is that there is no anonymity at all.
 *
 * ## Why the ceiling is not "strong"
 *
 * Two of these limits are structural and do not improve with scale:
 *
 * - **`shield` is a public transfer.** The link between a funding address and a shielded position
 *   is not broken by this design and never will be; it is broken by the *set*, statistically, and
 *   only for someone who does not also watch the timing.
 * - **The operator sees a window's book after it seals.** No amount of zero-knowledge changes
 *   that in a single-operator batch auction. Threshold decryption would; it is not built.
 *
 * A venue that rated itself "strong" while both of those held would be lying by omission, so the
 * best available verdict is `meaningful`, and even that keeps saying what it does not cover.
 */

export type PrivacyLevel = "none" | "minimal" | "weak" | "moderate" | "meaningful";

export interface PrivacyFactor {
  /** True when this is currently working in the holder's favour. */
  good: boolean;
  title: string;
  detail: string;
}

export interface PrivacyAssessment {
  level: PrivacyLevel;
  /** The size of the crowd, as the holder should read it. */
  setSize: number;
  headline: string;
  factors: PrivacyFactor[];
}

export interface PrivacyInput {
  /**
   * Distinct commitments in this pool's tree.
   *
   * Not `nextLeafIndex`: a settlement splices a span-aligned block of 32 and the zero leaves
   * alignment skips over are counted by that number while hiding nobody. Counting the non-zero
   * leaves is the only figure that describes an actual crowd.
   */
  commitments: number;
  /** How many of them are this vault's. A crowd you are most of is not a crowd. */
  yours: number;
  /** False before the holder has anything to protect, which changes what is worth saying. */
  hasPosition: boolean;
}

/**
 * The size of the crowd a note actually hides in.
 *
 * Your own notes do not hide you from anybody, so they come out. A pool holding four notes of
 * which three are yours is a pool with a crowd of one.
 */
export function effectiveSet({ commitments, yours }: PrivacyInput): number {
  return Math.max(0, commitments - yours);
}

export function assessPrivacy(input: PrivacyInput): PrivacyAssessment {
  const others = effectiveSet(input);
  // Two is the first number that is a crowd at all, and barely. Being one of two — where the
  // other note belongs to a stranger — is a coin toss for anyone watching, and the timing of a
  // deposit settles it. So the honest boundary for "none" is below two, not below one.
  const level: PrivacyLevel =
    others < 2
      ? "none"
      : others < 10
        ? "minimal"
        : others < 100
          ? "weak"
          : others < 1000
            ? "moderate"
            : "meaningful";

  const headline = !input.hasPosition
    ? "You hold nothing here yet, so there is nothing to link. This is what a deposit would be joining."
    : others < 1
      ? "There is no crowd to hide in. Your notes are the only ones in this pool, so anyone reading the chain can follow them exactly."
      : others < 2
        ? "One other note is in this pool. Being one of two is a coin toss for anyone watching, and the timing of your deposit decides it."
        : others < 10
          ? `Your notes are among ${others} other${others === 1 ? "" : "s"}. That is a crowd small enough to enumerate, and timing alone would likely pick you out of it.`
          : others < 100
            ? `Your notes are among ${others} others. Enough that a guess is a guess, not enough that it is a bad one.`
            : // The crowd stops being the weak link here, so the sentence stops being about it.
              // Saying only "you are among 4,997 others" at this size would be the one place the
              // panel let somebody walk away with a better impression than the design supports.
              `Your notes are among ${others.toLocaleString("en-US")} others — the pool is doing its work. Your deposit is still a public transfer from your address, and that does not change with size.`;

  const factors: PrivacyFactor[] = [
    {
      good: others >= 10,
      title: "Anonymity set",
      detail:
        others < 1
          ? "Nothing else is in this pool. A set of one is not a set."
          : others < 2
            ? "One other commitment. A set of two is a coin toss."
            : `${others.toLocaleString("en-US")} commitments that are not yours. Your note is indistinguishable from those and no others.`,
    },
    {
      // Never good. Stated as a limit rather than scored, because scale does not fix it.
      good: false,
      title: "Your deposit is public",
      detail:
        "Shielding is an ordinary transfer from your address, visible to anyone. What the pool hides is which note inside it is yours — not that you put something in.",
    },
    {
      good: others >= 100,
      title: "Timing",
      detail:
        others < 100
          ? "Deposit and withdraw close together and the two are matchable by time alone, whatever the set size. Waiting helps; a larger pool helps more."
          : "The pool is busy enough that a deposit and a withdrawal are not obviously the same person by their timing alone.",
    },
    {
      good: false,
      title: "The operator sees a sealed book",
      detail:
        "Orders are encrypted until their window closes, and then this venue decrypts them to match. Other traders never see them and the chain never sees them. We do, for that one window.",
    },
    {
      good: true,
      title: "Nothing links an order to your wallet here",
      detail:
        "Orders are authenticated by a signature inside the payload, not a session. No cookie is sent and your address is never attached. Our server still sees the request's IP — no design that runs on somebody else's infrastructure changes that.",
    },
  ];

  return { level, setSize: others, headline, factors };
}

/** What the badge says. Deliberately blunt at the low end. */
export const LEVEL_LABEL: Record<PrivacyLevel, string> = {
  none: "No anonymity",
  minimal: "Minimal",
  weak: "Weak",
  moderate: "Moderate",
  meaningful: "Meaningful",
};
