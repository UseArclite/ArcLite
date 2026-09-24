import { x25519 } from "@noble/curves/ed25519";
import { ivkForEpoch } from "./note";
import { P } from "./poseidon2";

/**
 * Sealing a viewing key to an auditor.
 *
 * What a grant actually hands over is `ivk_epoch = poseidon2(ivk, epoch)`. That key reconstructs
 * one epoch's notes and is useless for any other, because every note's randomness derives from
 * the epoch key rather than from the master one. **The scope is the key**, not a flag on a
 * contract that could be flipped — which is the difference between a disclosure boundary and a
 * promise to respect one.
 *
 * The master `ivk` never leaves the vault worker. An auditor holding epoch 7's key cannot walk
 * backwards to it, so granting one epoch does not quietly grant the rest.
 *
 * ## The scheme
 *
 * X25519 ECDH with a fresh ephemeral key per grant, HKDF-SHA256 to derive an AES-256-GCM key,
 * and the ephemeral public key prepended to the ciphertext. Standard sealed-box construction:
 *
 * - **Ephemeral per grant**, so two grants to the same auditor share no key material and
 *   re-granting after a revocation is not a replay of the first.
 * - **Auditor's public key in the HKDF info**, so a sealed box cannot be lifted and re-presented
 *   as though it were addressed to a different auditor.
 * - **AES-GCM**, so tampering is detected on open rather than yielding a plausible wrong key that
 *   would silently decrypt nothing and look like an empty epoch.
 *
 * Nothing here is committed on-chain beyond the ciphertext: `DisclosureRegistry` stores it
 * opaquely, because a contract that could read it would be a contract that published it.
 */

/** Wire format version, so a scheme change is visible rather than a decryption failure. */
export const SEAL_VERSION = 1;

const HEADER = 1 + 32; // version byte + ephemeral public key

function hkdf(secret: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle
    .importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"])
    .then((base) =>
      crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new TextEncoder().encode("arclite/disclosure/v1") as BufferSource,
          info: info as BufferSource,
        },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    );
}

function fieldToBytes(value: bigint): Uint8Array {
  if (value < 0n || value >= P) throw new Error("viewing key is not a field element");
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToField(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * Seal one epoch's viewing key to an auditor's published X25519 key.
 *
 * The nonce is all-zero, which is safe *only* because the AES key is derived from a fresh
 * ephemeral secret for every call and is therefore never reused. That is the standard sealed-box
 * argument, and it is written down here because "zero nonce" otherwise reads as a bug.
 */
export async function sealViewingKey(
  ivk: bigint,
  epoch: number,
  auditorPublicKey: Uint8Array,
): Promise<Uint8Array> {
  if (auditorPublicKey.length !== 32) throw new Error("auditor key must be 32 bytes");

  const epochKey = ivkForEpoch(ivk, BigInt(epoch));
  const ephemeralSecret = x25519.utils.randomPrivateKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, auditorPublicKey);

  // The recipient is bound into the derivation, so a box cannot be re-addressed.
  const key = await hkdf(shared, auditorPublicKey);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(12) },
      key,
      fieldToBytes(epochKey) as BufferSource,
    ),
  );

  const out = new Uint8Array(HEADER + ciphertext.length);
  out[0] = SEAL_VERSION;
  out.set(ephemeralPublic, 1);
  out.set(ciphertext, HEADER);
  return out;
}

/** The auditor's side. Returns `ivk_epoch`, or throws if the box was tampered with. */
export async function openViewingKey(
  sealed: Uint8Array,
  auditorSecretKey: Uint8Array,
): Promise<bigint> {
  if (sealed.length <= HEADER) throw new Error("sealed key is too short");
  if (sealed[0] !== SEAL_VERSION) {
    throw new Error(`unknown seal version ${sealed[0]}; this client cannot open it`);
  }

  const ephemeralPublic = sealed.slice(1, HEADER);
  const shared = x25519.getSharedSecret(auditorSecretKey, ephemeralPublic);
  const key = await hkdf(shared, x25519.getPublicKey(auditorSecretKey));

  // AES-GCM authenticates: a tampered box throws here rather than yielding a plausible wrong
  // key that would decrypt nothing and look like an empty epoch.
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(12) },
      key,
      sealed.slice(HEADER) as BufferSource,
    ),
  );
  return bytesToField(plaintext);
}

/** An auditor keypair. The secret never leaves the auditor. */
export function generateAuditorKeypair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export const toHex = (bytes: Uint8Array): `0x${string}` =>
  `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
