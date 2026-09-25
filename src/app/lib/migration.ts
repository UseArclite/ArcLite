/**
 * Moving notes from a retired pool into the live one.
 *
 * `RwaDarkPool` is immutable, so every fix is a new address and the old pool keeps honouring
 * withdrawals forever. There is deliberately **no migration function**: nothing in the new pool
 * can accept a note from the old one, because an entry point that could mint a commitment from
 * another contract's word is an entry point that could mint one from anything.
 *
 * So migration is `unshield` from the old pool followed by `shield` into the new one — two public
 * transactions from the same address. That is not an implementation detail to hide behind a
 * button. It is the whole cost, and it is severe:
 *
 * - `unshield` sends tokens to a known address in public.
 * - `shield` sends the same tokens back from that address, minutes later.
 * - The amount is usually **identical**, because people move what they have.
 *
 * Timing and amount together are the two links the withdrawal guard exists to warn about, and
 * migration produces both at once, in their purest form. Anyone reading the chain can follow it.
 *
 * ## The part that is genuinely worth saying
 *
 * The live pool currently holds nothing. A note moved into it today hides among zero others, so
 * migrating *now* buys no privacy at all — it buys the ability to trade, and it leaves a
 * commitment for the next person to hide among. Those are different reasons and somebody
 * deciding deserves to be told which one applies to them.
 */

export interface MigrationInput {
  /** Notes stranded in retired pools, unspent. */
  legacy: { pool: string; assetId: string; units: string }[];
  /** Non-zero commitments in the live pool, excluding this vault's own. */
  liveCrowd: number;
  /** Whether the live pool is deployed at all. */
  deployed: boolean;
}

export type MigrationPrivacy = "none" | "weak" | "linkable";

export interface MigrationPlan {
  /** Nothing to move. */
  idle: boolean;
  /** How many notes are stranded. */
  noteCount: number;
  /** The retired pools involved. */
  pools: string[];
  /** What migrating costs, said plainly. */
  privacy: MigrationPrivacy;
  headline: string;
  /** Why somebody would do it anyway, or why they might not. */
  reason: string;
  /** What reduces the linkage, when anything does. */
  advice: string | null;
}

export function migrationPlan({ legacy, liveCrowd, deployed }: MigrationInput): MigrationPlan {
  const pools = [...new Set(legacy.map((n) => n.pool))];
  const base = { noteCount: legacy.length, pools };

  if (legacy.length === 0) {
    return {
      ...base,
      idle: true,
      privacy: "none",
      headline: "",
      reason: "",
      advice: null,
    };
  }

  if (!deployed) {
    return {
      ...base,
      idle: false,
      privacy: "none",
      headline: "There is no live pool on this network to move these into.",
      reason:
        "Your notes stay withdrawable from the pool that holds them. Nothing needs doing and nothing is at risk.",
      advice: null,
    };
  }

  // The honest headline, and the one a "Migrate" button would bury.
  const headline =
    "Moving a note means withdrawing it in public and depositing it again from the same address.";

  // Being first is a real state with real consequences in both directions, and it is the state
  // this venue is actually in. Saying "your privacy is weak" without saying "because you would be
  // the first" would leave somebody unable to judge whether that changes.
  if (liveCrowd < 1) {
    return {
      ...base,
      idle: false,
      privacy: "none",
      headline,
      reason:
        "The live pool holds no other commitments, so a note moved into it today hides among none. Migrating now buys the ability to trade, not privacy — and it leaves a commitment for whoever comes next to hide among.",
      advice:
        "If you are not trading yet, leaving the note where it is costs nothing: a retired pool still honours withdrawals, with no pause and no operator.",
    };
  }

  return {
    ...base,
    idle: false,
    privacy: liveCrowd < 10 ? "weak" : "linkable",
    headline,
    reason:
      liveCrowd < 10
        ? `The live pool holds ${liveCrowd} other commitment${liveCrowd === 1 ? "" : "s"}. That is a small crowd, and the withdrawal and deposit either side of this move are both public.`
        : `The live pool holds ${liveCrowd} other commitments. The move itself is still two public transactions from one address.`,
    advice:
      "Waiting between the withdrawal and the deposit helps, and depositing a different amount helps more — an exact match is the link that waiting does not erase.",
  };
}

export type MigrationStepKey = "withdraw" | "deposit";

export interface MigrationStep {
  key: MigrationStepKey;
  title: string;
  detail: string;
}

/**
 * The two steps, named after what they actually are.
 *
 * Not "migrate" as one action: it is two transactions, on two contracts, with a public gap in
 * between that is the entire privacy cost. Collapsing them into a single button would hide the
 * one thing somebody needs to see.
 */
export const MIGRATION_STEPS: MigrationStep[] = [
  {
    key: "withdraw",
    title: "Withdraw from the retired pool",
    detail:
      "Proved in your browser, as any withdrawal is. The retired pool honours it with no pause, no role and no window check — that does not change because it was replaced.",
  },
  {
    key: "deposit",
    title: "Deposit into the live pool",
    detail:
      "An approval and a deposit, creating a fresh commitment. Its secrets are new; nothing links it to the old note except the public transactions either side.",
  },
];
