// Build a signed, quote-funded order book for the end-to-end scripts.
//
// Three things the intake now insists on that a literal object cannot supply:
//
//   * `owner` is *derived* from the key that signs the spend, so a payload whose `auth` does not
//     reproduce its `owner` is refused. A hand-written owner is a note nobody holds the key to.
//   * `noteUnits` is not the order's quantity. A note is spent whole and the unspent remainder
//     comes back, so the two are different numbers — and for a buy they are not even the same
//     unit, since a buy is funded with six-decimal quote against eighteen-decimal equities.
//   * the spend is signed, and the signature is bound to the window and to the nullifier.
//
// Real decimals throughout. At the single-digit unit counts these scripts used to trade,
// `filled x ref / 10^30` floors to zero and the entire quote leg is arithmetic on nothing —
// which is exactly how a buy side that moved no value at all went unnoticed.
import { publicKey, sign } from "../../src/lib/notes/grumpkin.ts";
import { commitment, nullifier, ownerOf } from "../../src/lib/notes/note.ts";
import { hash2 } from "../../src/lib/notes/poseidon2.ts";

/** One whole tokenised share. */
export const UNIT = 10n ** 18n;
/** tUSDG's registry id. A buy is funded from a note of this; a sell is paid in it. */
export const QUOTE_ASSET_ID = 4n;
const DOMAIN_SPEND = 0x7370656e64n; // "spend"

/** The three traders every script uses: two buyers against one seller, so pro-rata bites. */
export const TRADERS = [
  {
    secret: 111n,
    npk: 7n,
    nsecret: 333n,
    side: "buy",
    quantity: 30n * UNIT,
    noteUnits: 10_000_000000n,
    salt: 555n,
  },
  {
    secret: 222n,
    npk: 9n,
    nsecret: 444n,
    side: "sell",
    quantity: 20n * UNIT,
    noteUnits: 20n * UNIT,
    salt: 556n,
  },
  {
    secret: 777n,
    npk: 11n,
    nsecret: 888n,
    side: "buy",
    quantity: 10n * UNIT,
    noteUnits: 5_000_000000n,
    salt: 557n,
  },
];

/**
 * The note a trader funds their order with, and where it sits.
 *
 * A seller hands over the asset, so the note holds the asset; a buyer pays in quote, so it holds
 * tUSDG. Getting this backwards is not a rejected order — it is an order that proves and settles
 * while moving nothing.
 */
export function noteFor(trader, assetId) {
  const pk = publicKey(trader.secret);
  const owner = ownerOf(pk.x, pk.y, trader.npk);
  return {
    pk,
    owner,
    note: {
      assetId: trader.side === "sell" ? BigInt(assetId) : QUOTE_ASSET_ID,
      units: trader.noteUnits,
      owner,
      nsecret: trader.nsecret,
    },
  };
}

/**
 * The message `batch_cross` verifies for a spend.
 *
 * Over the *traded* asset, not the note's: a buy is about tNVDA even though it is paid for in
 * tUSDG. Not bound to the slot or the sub-batch — the sealer assigns both after submission, so a
 * trader signing offline cannot know them. The nullifier inside it is what stops the signature
 * moving: a nullifier may be published once, so there is nowhere to move to.
 */
export function signSpend(trader, windowId, assetId, leafIndex, note) {
  const nul = nullifier(commitment(note), trader.nsecret, BigInt(leafIndex));
  const message = hash2(
    hash2(DOMAIN_SPEND, BigInt(windowId)),
    hash2(hash2(BigInt(assetId), trader.side === "buy" ? 0n : 1n), hash2(trader.quantity, nul)),
  );
  return { nullifier: nul, signature: sign(trader.secret, message) };
}

/** A submittable order payload, in the shape `validatePayload` checks. */
export function payloadFor(trader, windowId, assetId, leafIndex) {
  const { pk, owner, note } = noteFor(trader, assetId);
  const { signature } = signSpend(trader, windowId, assetId, leafIndex, note);
  return {
    assetId: Number(assetId),
    side: trader.side,
    quantity: trader.quantity.toString(),
    noteUnits: trader.noteUnits.toString(),
    owner: owner.toString(),
    // The order salt **is** the note's `nsecret`, and that is not incidental: the settler
    // rebuilds the spent note from `salt_field` and refuses the order if the result does not
    // reproduce the commitment claimed at submission. A book that used an independent salt
    // submitted, sealed, priced and matched, and then failed at settlement with "revealed
    // payload does not rebuild its commitment" — naming the symptom and not the coupling.
    salt: trader.nsecret.toString(),
    auth: {
      pkX: pk.x.toString(),
      pkY: pk.y.toString(),
      npk: trader.npk.toString(),
      sLo: signature.sLo.toString(),
      sHi: signature.sHi.toString(),
      eLo: signature.eLo.toString(),
      eHi: signature.eHi.toString(),
    },
  };
}
