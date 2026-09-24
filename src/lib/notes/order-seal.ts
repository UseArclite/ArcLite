import { x25519 } from "@noble/curves/ed25519";

/**
 * Sealing an order payload to a window's published key.
 *
 * Lives here rather than in `src/server/orders.ts` because both sides need it and they must not
 * drift: the vault worker seals, the sealer opens, and a one-byte disagreement about the HKDF
 * info or the header layout would present as "every order in this window was undecryptable".
 *
 * The all-zero nonce is safe only because a fresh ephemeral key is generated per call, so the
 * derived AES key is never reused. Written down because a zero nonce otherwise reads as a bug.
 */

export interface SealablePayload {
  assetId: number;
  side: "buy" | "sell";
  quantity: string;
  owner: string;
  salt: string;
  auth: {
    pkX: string;
    pkY: string;
    npk: string;
    sLo: string;
    sHi: string;
    eLo: string;
    eHi: string;
  };
}

/** Seal an order to a window's published key. Used by the client and by the tests. */
export async function sealPayload(
  payload: SealablePayload,
  windowPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const ephemeralSecret = x25519.utils.randomPrivateKey();
  const shared = x25519.getSharedSecret(ephemeralSecret, windowPublicKey);
  const key = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  const aes = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("arclite/order/v1") as BufferSource,
      info: windowPublicKey as BufferSource,
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(12) },
      aes,
      new TextEncoder().encode(JSON.stringify(payload)) as BufferSource,
    ),
  );
  const out = new Uint8Array(33 + ciphertext.length);
  out[0] = 1;
  out.set(x25519.getPublicKey(ephemeralSecret), 1);
  out.set(ciphertext, 33);
  return out;
}
