import { commitment, deriveNsecret, deriveRho, ivkForEpoch, nullifier, type Note } from "./note";
import type { ConfirmedNote } from "./vault";
import type { VaultKeys } from "./vault";

/**
 * The witness for a withdrawal, built where the secrets already are.
 *
 * This runs in the vault worker and nowhere else. The circuit spends a note on knowledge of its
 * `nsecret` and the `owner` preimage, so a server that could build this witness could also spend
 * the note — which is the whole reason withdrawal proving belongs in the browser. It is also
 * what makes "unshield is always open" true rather than promised: a holder can leave while the
 * venue is paused, the asset is delisted, and the operator is hostile or simply gone.
 *
 * `recipient`, `relayer` and `relayer_fee` are public inputs precisely so a relayer can neither
 * redirect the withdrawal nor inflate its fee. It can broadcast the statement the owner signed,
 * or nothing.
 */

export interface UnshieldRequest {
  /** The note being spent, as the vault found it in the tree. */
  note: ConfirmedNote;
  /** Raw units to withdraw. The remainder comes back as a change note. */
  units: bigint;
  /** Who receives the tokens on chain. */
  recipient: `0x${string}`;
  /** Zero when the holder broadcasts it themselves, which is always available. */
  relayer?: `0x${string}`;
  relayerFeeUnits?: bigint;
  /** Where the change note's counter comes from. Must not collide with an existing note. */
  changeCounter: number;
}

export interface UnshieldWitness {
  /** Public inputs, in `unshield::main`'s order — the array `RwaDarkPool.unshield` builds. */
  publicInputs: {
    root: bigint;
    nullifier: bigint;
    changeCommitment: bigint;
    assetId: bigint;
    units: bigint;
    recipient: bigint;
    relayer: bigint;
    relayerFee: bigint;
  };
  /** The circuit's parameters, by name, as decimal strings. */
  inputs: Record<string, unknown>;
  /** The change note, so the vault can remember it and find it again after settlement. */
  change: { counter: number; units: bigint; commitment: bigint } | null;
}

export function buildUnshieldWitness(
  keys: VaultKeys,
  root: bigint,
  request: UnshieldRequest,
): UnshieldWitness {
  const { note, units, changeCounter } = request;
  const relayer = BigInt(request.relayer ?? "0x0000000000000000000000000000000000000000");
  const relayerFee = request.relayerFeeUnits ?? 0n;

  if (units === 0n) throw new Error("withdrawing nothing");
  if (units > note.units) {
    throw new Error(`the note holds ${note.units} units, less than the ${units} requested`);
  }
  if (relayerFee > units) throw new Error("the relayer fee exceeds the withdrawal");

  const spent = note.note;
  const c = commitment(spent);
  const nul = nullifier(c, spent.nsecret, BigInt(note.leafIndex));

  // A note is spent whole: the nullifier is published, so whatever is not withdrawn has to come
  // back as a fresh note. A fully-spent note publishes commitment 0, which the contract reads as
  // "insert nothing" — and the circuit binds that, so a spender cannot quietly mint change.
  const changeUnits = note.units - units;
  // Exactly `candidateNote`'s derivation — rho from (ivk_epoch, counter), then nsecret from
  // (ivk_epoch, rho). A change note derived any other way is a note the vault can never
  // regenerate, which is the same as one that was never created.
  const ivkEpoch = ivkForEpoch(keys.ivk, BigInt(note.epoch));
  const changeNsecret = deriveNsecret(ivkEpoch, deriveRho(ivkEpoch, BigInt(changeCounter)));
  const changeNote: Note = {
    assetId: spent.assetId,
    units: changeUnits,
    owner: spent.owner,
    nsecret: changeNsecret,
  };
  const changeCommitment = changeUnits === 0n ? 0n : commitment(changeNote);

  const dec = (v: bigint) => v.toString();
  return {
    publicInputs: {
      root,
      nullifier: nul,
      changeCommitment,
      assetId: spent.assetId,
      units,
      recipient: BigInt(request.recipient),
      relayer,
      relayerFee,
    },
    inputs: {
      root: dec(root),
      nullifier_out: dec(nul),
      change_commitment: dec(changeCommitment),
      asset_id: dec(spent.assetId),
      units_out: dec(units),
      recipient: dec(BigInt(request.recipient)),
      relayer: dec(relayer),
      relayer_fee: dec(relayerFee),
      in_units: dec(note.units),
      owner_npk: dec(keys.npk),
      pk_x: dec(keys.pkX),
      pk_y: dec(keys.pkY),
      nsecret: dec(spent.nsecret),
      leaf_index: dec(BigInt(note.leafIndex)),
      path: note.path.map(dec),
      change_nsecret: dec(changeNsecret),
    },
    change:
      changeUnits === 0n
        ? null
        : { counter: changeCounter, units: changeUnits, commitment: changeCommitment },
  };
}
