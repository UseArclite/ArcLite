import { describe, expect, test } from "bun:test";
import { buildUnshieldWitness } from "../unshield";
import { candidateNote, deriveVaultKeys, ownerField, type ConfirmedNote } from "../vault";
import { commitment, nullifier, IncrementalTree } from "../note";

/**
 * Withdrawal is the one path that must work when everything else does not — paused venue,
 * delisted asset, hostile or absent operator. So the witness is built where the secrets are,
 * and these check the two properties that make a change note real rather than notional: it is
 * derived exactly as the vault derives every other note, so it can be found again; and it
 * accounts for every unit the spent note held.
 */
describe("the unshield witness", () => {
  const SIGNATURE = `0x${"ab".repeat(65)}`;

  async function fixture(noteUnits: bigint) {
    const keys = await deriveVaultKeys(SIGNATURE);
    const candidate = candidateNote(keys, 1, 7, 1n, noteUnits);
    const tree = new IncrementalTree();
    tree.insert(candidate.commitment);
    const note: ConfirmedNote = { ...candidate, leafIndex: 0, path: tree.path(0) };
    return { keys, note, root: tree.root() };
  }

  test("a partial withdrawal returns the remainder as a note the vault can regenerate", async () => {
    const { keys, note, root } = await fixture(100n);
    const w = buildUnshieldWitness(keys, root, {
      note,
      units: 30n,
      recipient: "0x000000000000000000000000000000000000aaaa",
      changeCounter: 8,
    });

    expect(w.change).not.toBeNull();
    expect(w.change!.units).toBe(70n);
    // The decisive check: regenerating the note from (epoch, counter) alone — which is all a
    // recovering client has — reproduces the commitment the circuit committed to.
    const regenerated = candidateNote(keys, note.epoch, 8, 1n, 70n);
    expect(regenerated.commitment).toBe(w.change!.commitment);
    expect(w.publicInputs.changeCommitment).toBe(regenerated.commitment);
  });

  test("a full withdrawal publishes no change note at all", async () => {
    const { keys, note, root } = await fixture(100n);
    const w = buildUnshieldWitness(keys, root, {
      note,
      units: 100n,
      recipient: "0x000000000000000000000000000000000000aaaa",
      changeCounter: 8,
    });
    // Commitment zero is what the contract reads as "insert nothing". A change note here would
    // be units minted out of a fully-spent note.
    expect(w.publicInputs.changeCommitment).toBe(0n);
    expect(w.change).toBeNull();
  });

  test("the nullifier is bound to the note's position in the tree", async () => {
    const { keys, note, root } = await fixture(100n);
    const w = buildUnshieldWitness(keys, root, {
      note,
      units: 100n,
      recipient: "0x000000000000000000000000000000000000aaaa",
      changeCounter: 8,
    });
    expect(w.publicInputs.nullifier).toBe(
      nullifier(commitment(note.note), note.note.nsecret, BigInt(note.leafIndex)),
    );
  });

  test("refuses to withdraw more than the note holds", async () => {
    const { keys, note, root } = await fixture(100n);
    expect(() =>
      buildUnshieldWitness(keys, root, {
        note,
        units: 101n,
        recipient: "0x000000000000000000000000000000000000aaaa",
        changeCounter: 8,
      }),
    ).toThrow(/less than/);
  });

  test("refuses a relayer fee larger than the withdrawal", async () => {
    const { keys, note, root } = await fixture(100n);
    expect(() =>
      buildUnshieldWitness(keys, root, {
        note,
        units: 10n,
        relayerFeeUnits: 11n,
        recipient: "0x000000000000000000000000000000000000aaaa",
        changeCounter: 8,
      }),
    ).toThrow(/relayer fee/);
  });

  test("owner is the vault's, so the change note is spendable by the same keys", async () => {
    const { keys, note, root } = await fixture(100n);
    const w = buildUnshieldWitness(keys, root, {
      note,
      units: 40n,
      recipient: "0x000000000000000000000000000000000000aaaa",
      changeCounter: 8,
    });
    expect(BigInt(w.inputs.owner_npk as string)).toBe(keys.npk);
    expect(ownerField(keys)).toBe(note.note.owner);
    void w;
  });
});
