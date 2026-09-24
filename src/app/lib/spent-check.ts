/**
 * Which notes the pool has already seen spent.
 *
 * ## The failure this exists to prevent
 *
 * The commitment tree is append-only, so a note consumed by a settlement keeps its leaf forever
 * and a scan finds it exactly as it finds a live one. Nothing about a note distinguishes money
 * you have from money you already moved — only the pool's `nullifierSpent` mapping does.
 *
 * So every answer here has a consequence. Say "spent" wrongly and a note is hidden until the next
 * scan, which is a visible inconvenience that corrects itself. Say "unspent" wrongly and the app
 * offers somebody money that is not there: a withdrawal that reverts with `NullifierAlreadySpent`
 * and costs them gas, or an order the venue refuses with "this note has already been offered"
 * after they have committed to it.
 *
 * **The two outcomes are not symmetrical, so the unknown case is not a coin flip.** When the chain
 * cannot be asked, this reports every note as spent.
 *
 * That rule was already written in the catch block of the code this replaces. What it was missing
 * was that a missing reader is exactly as unknown as a failed read — the old guard returned all
 * *false* when the wallet's client had not resolved yet, which is the most likely moment of all,
 * because the first scan runs the instant the vault unlocks. A spent note was offered, the venue
 * refused it, and the trader was told their own note had already been offered.
 *
 * Kept as a pure function with the reader injected so the unknown cases are testable without a
 * chain, a wallet or a browser. They are the cases that matter and they are the hardest to
 * reproduce by hand.
 */

export type SpentReader = (nullifiers: `0x${string}`[]) => Promise<boolean[]>;

export interface SpentResult {
  /** One flag per nullifier, always the same length as the input. */
  flags: boolean[];
  /**
   * False when the chain could not be consulted, so `flags` is the safe assumption rather than an
   * answer. The caller is expected to ask again — every note is hidden while this is false, and
   * hiding a live balance is only acceptable if it is temporary.
   */
  conclusive: boolean;
}

export interface SpentOptions {
  /** False when no pool exists on this network, so nothing can have been spent in one. */
  poolDeployed: boolean;
  /** Null when there is no way to ask the chain right now. */
  read: SpentReader | null;
}

/** Every note assumed spent: the safe answer whenever the chain could not be consulted. */
const unknown = (count: number): SpentResult => ({
  flags: new Array<boolean>(count).fill(true),
  conclusive: false,
});

export async function readSpent(
  nullifiers: `0x${string}`[],
  { poolDeployed, read }: SpentOptions,
): Promise<SpentResult> {
  if (nullifiers.length === 0) return { flags: [], conclusive: true };

  // No pool on this network means no settlement has ever happened on it. This is the one case
  // where "unspent" is knowledge rather than a guess.
  if (!poolDeployed) {
    return { flags: new Array<boolean>(nullifiers.length).fill(false), conclusive: true };
  }

  if (!read) return unknown(nullifiers.length);

  try {
    const flags = await read(nullifiers);
    // A short answer is the same bug wearing a different hat: the caller indexes this array
    // positionally, so a missing entry would read as `undefined` and fall through to "not spent"
    // at whatever default the call site happens to use. Length is part of the answer.
    if (flags.length !== nullifiers.length) return unknown(nullifiers.length);
    // Likewise a non-boolean: an RPC that answers with something unexpected has not told us the
    // note is unspent, it has told us nothing.
    if (flags.some((f) => typeof f !== "boolean")) return unknown(nullifiers.length);
    return { flags, conclusive: true };
  } catch {
    return unknown(nullifiers.length);
  }
}
