import { expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { deriveVaultKeys, vaultMessage } from "../vault";
import { ivkForEpoch } from "../note";
import { generateAuditorKeypair, openViewingKey, sealViewingKey, toHex } from "../disclosure";

/**
 * What a disclosure grant actually hands over.
 *
 * The claim on `/proofs` is that an auditor's access is *scoped cryptographically* rather than by
 * a flag somebody could flip. That is either true of these bytes or it is marketing, and the
 * difference is checkable — so it is checked. Each assertion below is one clause of the claim:
 * the key opens the epoch granted, is not the master, does not open the neighbouring epoch, is
 * useless to anyone else holding the box, and fails loudly rather than quietly when tampered
 * with.
 *
 * The last one matters more than it looks. AES-GCM authenticates, so a bent box throws; without
 * that it would yield a plausible wrong key, decrypt nothing, and read to an auditor as an epoch
 * in which this trader did nothing.
 */
test("a grant opens exactly one epoch and no other", async () => {
  const a = privateKeyToAccount(
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  );
  const keys = await deriveVaultKeys(await a.signMessage({ message: vaultMessage(a.address) }));
  const auditor = generateAuditorKeypair();
  const other = generateAuditorKeypair();

  const sealed = await sealViewingKey(keys.ivk, 7, auditor.publicKey);
  console.log("  sealed box:", toHex(sealed).slice(0, 26) + "…", `(${sealed.length} bytes)`);

  const opened = await openViewingKey(sealed, auditor.secretKey);
  expect(opened).toBe(ivkForEpoch(keys.ivk, 7n));
  console.log("  opens epoch 7:      yes");

  // It is not the master key, and it is not any other epoch.
  expect(opened).not.toBe(keys.ivk);
  expect(opened).not.toBe(ivkForEpoch(keys.ivk, 8n));
  console.log("  is the master key:  no");
  console.log("  opens epoch 8:      no");

  // Another auditor cannot open it, even holding the box.
  await expect(openViewingKey(sealed, other.secretKey)).rejects.toThrow();
  console.log("  another auditor:    refused");

  // Tampering is detected rather than yielding a plausible wrong key.
  const bent = new Uint8Array(sealed);
  bent[bent.length - 1] ^= 1;
  await expect(openViewingKey(bent, auditor.secretKey)).rejects.toThrow();
  console.log("  one bit flipped:    refused");

  // Two grants of the same epoch share no key material.
  const again = await sealViewingKey(keys.ivk, 7, auditor.publicKey);
  expect(toHex(again)).not.toBe(toHex(sealed));
  console.log("  re-grant reuses bytes: no");
});
