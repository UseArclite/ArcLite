import {
  commitment,
  deriveNsecret,
  deriveRho,
  ivkForEpoch,
  ownerOf,
  toField,
  viewTag,
  IncrementalTree,
  type Note,
} from "./note";
import { publicKey, sign, SCALAR_MODULUS, type Signature } from "./grumpkin";
import { hash2 } from "./poseidon2";

/**
 * The client's key material, and how a browser turns a signature into a spendable note set.
 *
 * Everything here is pure and synchronous apart from the one HKDF call, so it is testable
 * without a wallet, a worker or a chain — which matters, because a bug in key derivation does
 * not raise an error. It silently produces a different account, and the user's notes simply do
 * not appear.
 *
 * ## Why a signature, and what that costs
 *
 * Keys derive from a `personal_sign` over a fixed, domain-separated message. That works only
 * because ECDSA signing is deterministic (RFC 6979) in MetaMask and in every hardware wallet
 * worth using: sign the same bytes twice and you get the same bytes back, so the same keys.
 * **A wallet that signed with random nonces would hand back a different vault every time**, and
 * the notes would be unreachable rather than merely hidden. That is a real fund-loss mode, so
 * the derivation is versioned and the version is part of the signed message: a change of scheme
 * produces a visibly different vault rather than a silently empty one.
 *
 * ## v2: a real Grumpkin keypair
 *
 * v1 treated `pk_x` and `pk_y` as two secret field elements, because nothing verified a signature
 * against them — `owner` was just a hash of a preimage the holder exhibited. That was fine until
 * it wasn't: a settler that learns the preimage and `nsecret` from a revealed order could replay
 * the spend into a later batch.
 *
 * `batch_cross` now verifies a Schnorr signature per spend, so `pk` has to be a genuine point:
 * `pk = spendSecret · G` on Grumpkin. Knowing `owner` and `nsecret` no longer authorises
 * anything — producing a signature requires the discrete log.
 *
 * The version is part of the signed message, so v1 and v2 derive different vaults. Anyone holding
 * v1 notes keeps reaching them by asking for version 1 explicitly; nothing is migrated in place.
 */

/** Bump on any change to how keys are derived. It is part of the signed message. */
export const VAULT_KEY_VERSION = 2;

export interface VaultKeys {
  version: number;
  /** Nullifier public key component of `owner`. */
  npk: bigint;
  /**
   * The Grumpkin spending secret. Never leaves the vault worker: it is what authorises a spend,
   * and anything that learns it can move the notes.
   */
  spendSecret: bigint;
  /** `spendSecret · G`. Public, and half of what `owner` commits to. */
  pkX: bigint;
  pkY: bigint;
  /** Master incoming viewing key. Per-epoch keys derive from it; an auditor gets one of those. */
  ivk: bigint;
  /** Short, non-secret identifier so the UI can say *which* vault is open without showing it. */
  fingerprint: string;
}

/**
 * The text the person reads in MetaMask before signing.
 *
 * It names the address and the version, so a signature captured for one account or one scheme
 * cannot be replayed into another. It is deliberately explicit that this is not a transaction:
 * the whole purpose of the prompt is that someone reads it.
 */
export function vaultMessage(address: string, version: number = VAULT_KEY_VERSION): string {
  return [
    "ArcLite private vault key",
    "",
    "Signing this derives the keys that decrypt your shielded balance.",
    "It does not approve a transaction, move funds, or submit an order.",
    "",
    "Only sign this on the ArcLite site. Anyone who obtains this signature can see your balance.",
    "",
    `Address: ${address.toLowerCase()}`,
    `Version: ${version}`,
  ].join("\n");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("signature is not a whole number of bytes");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Stretch the signature into four independent field elements.
 *
 * 64 bytes per subkey rather than 32: reducing 256 bits into a ~254-bit field leaves a modulo
 * bias, small but avoidable, and 512 bits makes it vanish. HKDF's `info` separates the subkeys,
 * so no two are derivable from each other.
 */
export async function deriveVaultKeys(
  signature: string,
  version: number = VAULT_KEY_VERSION,
): Promise<VaultKeys> {
  const bytes = hexToBytes(signature);
  if (bytes.length < 64) throw new Error("signature is too short to derive keys from");

  const key = await crypto.subtle.importKey("raw", bytes as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const salt = new TextEncoder().encode(`arclite/vault/v${version}`);

  const sub = async (label: string) => {
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(label) },
      key,
      512,
    );
    return toField(new Uint8Array(bits));
  };

  const [npk, rawSpend, ivk] = await Promise.all([sub("npk"), sub("spend"), sub("ivk")]);

  // The spending key is a Grumpkin scalar, so it is reduced into that curve's scalar field
  // rather than the note field. Reducing into the wrong one yields a valid point whose
  // signatures the circuit rejects — a failure with no useful diagnostic.
  const spendSecret = rawSpend % SCALAR_MODULUS;
  const pk = publicKey(spendSecret);

  // Derived from ivk by a one-way hash so showing it discloses nothing, and it changes whenever
  // the vault does — which is how a user notices they are looking at the wrong account.
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fingerprint:${ivk}`)),
  );
  const fingerprint = [...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return { version, npk, spendSecret, pkX: pk.x, pkY: pk.y, ivk, fingerprint };
}

/** The `owner` field every note of this vault carries. */
export function ownerField(keys: VaultKeys): bigint {
  return ownerOf(keys.pkX, keys.pkY, keys.npk);
}

/** `batch_cross`'s `DOMAIN_SPEND`. */
const DOMAIN_SPEND = 0x7370656e64n; // "spend"

/**
 * The message `batch_cross` verifies for a spend.
 *
 * Not bound to the slot or sub-batch: both are assigned by the sealer after the order is
 * submitted, and a trader signing offline cannot know them. The nullifier inside it is what
 * stops the signature moving — a nullifier may be published once, so there is nowhere to move to.
 */
export function spendMessage(
  assetId: bigint,
  side: "buy" | "sell",
  quantity: bigint,
  nullifier: bigint,
): bigint {
  return hash2(
    hash2(DOMAIN_SPEND, 0n),
    hash2(hash2(assetId, side === "buy" ? 0n : 1n), hash2(quantity, nullifier)),
  );
}

/** Authorise one spend. The window binds it, so a signature settles in one window only. */
export function signSpend(
  keys: VaultKeys,
  windowId: bigint,
  assetId: bigint,
  side: "buy" | "sell",
  quantity: bigint,
  nullifier: bigint,
): Signature {
  const message = hash2(
    hash2(DOMAIN_SPEND, windowId),
    hash2(hash2(assetId, side === "buy" ? 0n : 1n), hash2(quantity, nullifier)),
  );
  return sign(keys.spendSecret, message);
}

/**
 * Where a note came from, and therefore how to rebuild it.
 *
 * This is not bookkeeping. A deposit note derives from `(epoch, counter)`; a settlement output
 * derives from its **parent's** secret and the window it settled in, and the two derivations
 * produce different notes from the same `(epoch, counter)` pair. An output carries its parent's
 * pair because that is the only handle it has — so anything holding a note and not this marker
 * can rebuild the wrong one and never find out from the numbers.
 *
 * It did exactly that. An order funded by a note a crossing had returned rebuilt the parent
 * instead, and the parent had already been spent settling the order that produced the output, so
 * the venue refused it: "this note has already been offered". The vault could see output notes
 * and could not spend a single one.
 */
export type NoteOrigin =
  | { kind: "deposit" }
  /** `windowId` as a decimal string, so it survives a postMessage and a JSON round trip. */
  | { kind: "output"; windowId: string; slot: 0 | 1 };

export interface Candidate {
  epoch: number;
  counter: number;
  assetId: bigint;
  units: bigint;
  note: Note;
  commitment: bigint;
  /** Published alongside the leaf so an indexer can pre-filter without learning ownership. */
  viewTag: number;
  /** How to rebuild this note. Rebuilding a note the wrong way is silent and produces a stranger. */
  origin: NoteOrigin;
}

/**
 * Rebuild a note this vault would have created for (epoch, counter, asset, units).
 *
 * This is the recovery path: given only the signature, a client can regenerate every note it
 * created without a server, an indexer, or an on-chain ciphertext. It cannot regenerate a note
 * *someone else* created for it — a fill output — because it does not know the units until it
 * has the receipt. That gap is what note ciphertexts close, and it opens with Phase 4 when
 * there is a producer to define the format against.
 */
export function candidateNote(
  keys: VaultKeys,
  epoch: number,
  counter: number,
  assetId: bigint,
  units: bigint,
): Candidate {
  const ivkEpoch = ivkForEpoch(keys.ivk, BigInt(epoch));
  const rho = deriveRho(ivkEpoch, BigInt(counter));
  const nsecret = deriveNsecret(ivkEpoch, rho);
  const note: Note = { assetId, units, owner: ownerField(keys), nsecret };
  return {
    epoch,
    counter,
    assetId,
    units,
    note,
    commitment: commitment(note),
    viewTag: viewTag(ivkEpoch, BigInt(counter)),
    origin: { kind: "deposit" },
  };
}

/**
 * A note settlement produced, derived from the note it replaced.
 *
 * Crossing does not mint fresh notes from a counter. `settleBatch` builds each output from the
 * **spent** note's `nsecret` and the window it settled in:
 *
 *     residual.nsecret = H(spent.nsecret, H(windowId, 0))
 *     received.nsecret = H(spent.nsecret, H(windowId, 1))
 *
 * which is what lets an output be recovered by whoever owned the input, and by nobody else. It
 * also means `candidateNote` cannot reach these: they have no counter of their own, and a vault
 * that only regenerates deposits is blind to every note it has ever traded into. The money sits
 * in the pool, owed, and invisible.
 *
 * `slot` is 0 for the residual — what the order did not spend — and 1 for what it received.
 */
export function outputNote(
  keys: VaultKeys,
  parent: { epoch: number; counter: number },
  windowId: bigint,
  slot: 0 | 1,
  assetId: bigint,
  units: bigint,
): Candidate {
  const ivkEpoch = ivkForEpoch(keys.ivk, BigInt(parent.epoch));
  const rho = deriveRho(ivkEpoch, BigInt(parent.counter));
  const parentNsecret = deriveNsecret(ivkEpoch, rho);
  const nsecret = hash2(parentNsecret, hash2(windowId, BigInt(slot)));
  const note: Note = { assetId, units, owner: ownerField(keys), nsecret };
  return {
    // Carried from the parent so the note can be found again, and so a withdrawal knows which
    // secret to prove with. These are not a counter in the deposit sense — nothing else derives
    // from them — but they are the only handle the output has.
    epoch: parent.epoch,
    counter: parent.counter,
    assetId,
    units,
    note,
    commitment: commitment(note),
    viewTag: viewTag(ivkEpoch, BigInt(parent.counter)),
    origin: { kind: "output", windowId: windowId.toString(), slot },
  };
}

/**
 * Rebuild a note this vault owns, whichever way it was made.
 *
 * The one place that decides between the two derivations. Every caller that holds a note and
 * needs its secrets again — signing a spend, proving a withdrawal — goes through here, because
 * choosing wrong is silent: both derivations accept the same `(epoch, counter)` and both return
 * a perfectly well-formed note. It is simply somebody else's.
 */
export function rebuildNote(
  keys: VaultKeys,
  note: { epoch: number; counter: number; assetId: bigint; units: bigint; origin: NoteOrigin },
): Candidate {
  if (note.origin.kind === "output") {
    return outputNote(
      keys,
      { epoch: note.epoch, counter: note.counter },
      BigInt(note.origin.windowId),
      note.origin.slot,
      note.assetId,
      note.units,
    );
  }
  return candidateNote(keys, note.epoch, note.counter, note.assetId, note.units);
}

export interface ConfirmedNote extends Candidate {
  leafIndex: number;
  /** Authentication path against the tree the leaves were taken from. */
  path: bigint[];
}

export interface ScanResult {
  confirmed: ConfirmedNote[];
  /** Regenerated but not present in the tree — a deposit that never landed, or a wrong guess. */
  unconfirmed: Candidate[];
  root: bigint;
  leafCount: number;
}

/**
 * Locate this vault's notes in the on-chain leaf set and build their Merkle paths.
 *
 * The tree is rebuilt locally from the full leaf list rather than trusting a server's answer for
 * an index or a path. A server that lied about either would produce a proof the contract rejects
 * — wasted gas, not lost funds — but it would also be able to tell which leaves are yours by
 * watching which paths you asked for. Doing it here costs a few hashes and removes the question.
 */
export function scanLeaves(
  candidates: readonly Candidate[],
  leaves: readonly bigint[],
): ScanResult {
  const position = new Map<bigint, number>();
  // Later duplicates cannot displace an earlier leaf: the first occurrence is the one whose
  // nullifier the contract will accept, and a duplicate commitment is otherwise unspendable.
  for (let i = 0; i < leaves.length; i++) {
    if (!position.has(leaves[i]!)) position.set(leaves[i]!, i);
  }

  const tree = new IncrementalTree();
  for (const leaf of leaves) tree.insert(leaf);

  const confirmed: ConfirmedNote[] = [];
  const unconfirmed: Candidate[] = [];
  for (const candidate of candidates) {
    const index = position.get(candidate.commitment);
    if (index === undefined) {
      unconfirmed.push(candidate);
      continue;
    }
    confirmed.push({ ...candidate, leafIndex: index, path: tree.path(index) });
  }

  return { confirmed, unconfirmed, root: tree.root(), leafCount: leaves.length };
}

/**
 * Raw units held per asset, after removing anything already spent.
 *
 * Units, never value. The vault has no prices and must not acquire any: a worker that knows both
 * the note set and what it is worth is one message away from leaking a balance. Pricing happens
 * on the main thread, from public market data.
 */
export function balanceByAsset(
  notes: readonly ConfirmedNote[],
  spentNullifiers: ReadonlySet<bigint> = new Set(),
  nullifierOf: (note: ConfirmedNote) => bigint,
): Map<bigint, bigint> {
  const totals = new Map<bigint, bigint>();
  for (const note of notes) {
    if (spentNullifiers.has(nullifierOf(note))) continue;
    totals.set(note.assetId, (totals.get(note.assetId) ?? 0n) + note.units);
  }
  return totals;
}
