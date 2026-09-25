import type { ProofPhase } from "@/workers/vault.worker";

/**
 * A withdrawal, narrated while it happens.
 *
 * "Your withdrawal is proved on your own machine, from keys that never left it, and the venue
 * cannot stop it" is the strongest claim this product makes and the one that distinguishes it
 * from every custodial venue. It rendered as a button that said "Proving…".
 *
 * The proof genuinely takes a few seconds, so there is real time to fill, and filling it with
 * what is actually happening is better than hiding it behind a spinner. A wait somebody
 * understands is a different experience from the same wait.
 *
 * ## Named after the work, not after a ritual
 *
 * There is no local verification step in the worker — it builds a witness and proves. So there is
 * no stage here claiming one, however well "verifying locally" would have read. A progress
 * display that invents a step is worse than a spinner: it is a spinner that lies, and this is
 * the one screen where the product is asking to be believed about cryptography.
 */

export interface ProofStage {
  phase: ProofPhase;
  title: string;
  /** What is happening, for the stage in hand. */
  detail: string;
}

export const PROOF_STAGES: ProofStage[] = [
  {
    phase: "locating",
    title: "Finding your note",
    detail:
      "Regenerating the note from your key and locating it in the pool's commitment set. Nothing is asked of any server: the tree is public and the search happens here.",
  },
  {
    phase: "witness",
    title: "Building the witness",
    detail:
      "Assembling the private inputs — the note's secrets, its Merkle path, the recipient. Anything that can build this could spend your note, which is why it is built in this browser and never sent anywhere.",
  },
  {
    phase: "proving",
    title: "Generating the proof",
    detail:
      "An UltraHonk proof over roughly 2^14 constraints, in a Web Worker on this machine. This is the part that takes a few seconds.",
  },
  {
    phase: "broadcasting",
    title: "Broadcasting",
    detail:
      "Sending the proof to the pool. It accepts a valid proof from anyone holding it — no operator, no pause, no window check.",
  },
];

export type StageState = "done" | "current" | "todo";

export interface StageView extends ProofStage {
  state: StageState;
}

/**
 * The stage list as it should render for a given phase.
 *
 * `null` means no withdrawal is running, and the caller should show nothing rather than a row of
 * pending steps implying one is.
 */
export function proofStages(phase: ProofPhase | null): StageView[] {
  if (phase === null) return [];
  const at = PROOF_STAGES.findIndex((s) => s.phase === phase);
  // An unrecognised phase is a worker newer than this bundle. Showing every stage as pending is
  // wrong in a harmless direction; claiming completion would not be.
  const index = at === -1 ? 0 : at;
  return PROOF_STAGES.map((s, i) => ({
    ...s,
    state: i < index ? "done" : i === index ? "current" : "todo",
  }));
}

/** Elapsed seconds, to one decimal — the resolution that makes a few seconds feel measured. */
export function elapsed(startedAt: number, now: number): string {
  return `${Math.max(0, (now - startedAt) / 1000).toFixed(1)}s`;
}
