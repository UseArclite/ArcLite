import { describe, expect, test } from "bun:test";
import { ivkForEpoch } from "../note";
import {
  generateAuditorKeypair,
  openViewingKey,
  sealViewingKey,
  SEAL_VERSION,
} from "../disclosure";

/**
 * Sealed viewing keys.
 *
 * The property that carries the whole disclosure design is the third test: an auditor given
 * epoch 7 cannot read epoch 8. If that failed, every "scoped" grant would silently be a grant of
 * everything, and nothing in the contract would reveal it.
 */

const IVK = 0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809n;

describe("sealing", () => {
  test("round-trips the epoch key to the intended auditor", async () => {
    const auditor = generateAuditorKeypair();
    const sealed = await sealViewingKey(IVK, 7, auditor.publicKey);
    expect(await openViewingKey(sealed, auditor.secretKey)).toBe(ivkForEpoch(IVK, 7n));
  });

  test("another auditor cannot open it", async () => {
    const intended = generateAuditorKeypair();
    const eavesdropper = generateAuditorKeypair();
    const sealed = await sealViewingKey(IVK, 7, intended.publicKey);
    await expect(openViewingKey(sealed, eavesdropper.secretKey)).rejects.toThrow();
  });

  test("epoch 7's key does not open epoch 8 — the whole point of scoping", async () => {
    // The scope is the key itself, not a flag a contract could flip. An auditor holding epoch 7
    // reconstructs epoch 7's notes and nothing else, because every note's randomness derives
    // from the epoch key rather than the master one.
    const auditor = generateAuditorKeypair();
    const seven = await openViewingKey(
      await sealViewingKey(IVK, 7, auditor.publicKey),
      auditor.secretKey,
    );
    const eight = await openViewingKey(
      await sealViewingKey(IVK, 8, auditor.publicKey),
      auditor.secretKey,
    );
    expect(seven).not.toBe(eight);
    expect(seven).toBe(ivkForEpoch(IVK, 7n));
  });

  test("the disclosed key does not reveal the master key", async () => {
    // Granting one epoch must not quietly grant the rest. `ivk_epoch` is a one-way hash of the
    // master key, so walking backwards is the hash's preimage problem.
    const auditor = generateAuditorKeypair();
    const disclosed = await openViewingKey(
      await sealViewingKey(IVK, 7, auditor.publicKey),
      auditor.secretKey,
    );
    expect(disclosed).not.toBe(IVK);
  });

  test("every seal is unique, even for the same key and auditor", async () => {
    // A fresh ephemeral per grant. Without it, the all-zero nonce would reuse an AES-GCM key —
    // and re-granting after a revocation would be a byte-identical replay of the first grant.
    const auditor = generateAuditorKeypair();
    const a = await sealViewingKey(IVK, 7, auditor.publicKey);
    const b = await sealViewingKey(IVK, 7, auditor.publicKey);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(await openViewingKey(a, auditor.secretKey)).toBe(
      await openViewingKey(b, auditor.secretKey),
    );
  });

  test("a tampered box throws rather than yielding a plausible wrong key", async () => {
    // Silently returning garbage would look like an empty epoch, which an auditor could easily
    // read as "this trader did nothing".
    const auditor = generateAuditorKeypair();
    const sealed = await sealViewingKey(IVK, 7, auditor.publicKey);
    sealed[sealed.length - 1] ^= 0x01;
    await expect(openViewingKey(sealed, auditor.secretKey)).rejects.toThrow();
  });

  test("a swapped ephemeral key is detected", async () => {
    const auditor = generateAuditorKeypair();
    const sealed = await sealViewingKey(IVK, 7, auditor.publicKey);
    sealed[5] ^= 0x01; // inside the ephemeral public key
    await expect(openViewingKey(sealed, auditor.secretKey)).rejects.toThrow();
  });

  test("carries a version, so a scheme change is legible", async () => {
    const auditor = generateAuditorKeypair();
    const sealed = await sealViewingKey(IVK, 7, auditor.publicKey);
    expect(sealed[0]).toBe(SEAL_VERSION);
    sealed[0] = 99;
    await expect(openViewingKey(sealed, auditor.secretKey)).rejects.toThrow(/unknown seal version/);
  });

  test("refuses an auditor key of the wrong length", async () => {
    await expect(sealViewingKey(IVK, 7, new Uint8Array(31))).rejects.toThrow(/32 bytes/);
  });

  test("refuses a truncated box", async () => {
    const auditor = generateAuditorKeypair();
    await expect(openViewingKey(new Uint8Array(10), auditor.secretKey)).rejects.toThrow(
      /too short/,
    );
  });
});
