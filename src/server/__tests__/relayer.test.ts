import { describe, expect, test, afterEach } from "bun:test";
import {
  assertKeyPolicy,
  plaintextRelayerAccepted,
  PLAINTEXT_ACK,
  RelayerUnavailable,
} from "../relayer";

/**
 * The key policy.
 *
 * This is the assertion `plan.md` demanded be a control rather than a checklist item: mainnet
 * must refuse to boot on a plaintext key that nobody deliberately allowed. It is worth its own
 * test because it is the kind of guard that silently stops working — one refactor that turns the
 * throw into a console warning, and it is gone with nothing failing.
 *
 * The policy changed once, and the reason matters more than the mechanics. `KMS_KEY_ID` used to
 * satisfy the gate on its own, and nothing in the codebase has ever signed through KMS — so
 * setting it switched the check off while changing nothing about how transactions were signed.
 * A control that reads as "the key is in a hardware module" and means "somebody typed a variable
 * name" is worse than no control, because it is believed. Hence two tests that did not exist
 * before: `KMS_KEY_ID` now throws, and the hot key needs a phrase that says what it is.
 */

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("mainnet key policy", () => {
  test("refuses to sign on mainnet with an unacknowledged plaintext key", () => {
    delete process.env.KMS_KEY_ID;
    delete process.env.ARCLITE_MAINNET_PLAINTEXT_RELAYER;
    expect(() => assertKeyPolicy(4663, true)).toThrow(RelayerUnavailable);
    expect(() => assertKeyPolicy(4663, true)).toThrow(/plaintext RELAYER_PRIVATE_KEY/);
  });

  test("allows mainnet once a hot key is acknowledged in words", () => {
    delete process.env.KMS_KEY_ID;
    process.env.ARCLITE_MAINNET_PLAINTEXT_RELAYER = PLAINTEXT_ACK;
    expect(() => assertKeyPolicy(4663, true)).not.toThrow();
    expect(plaintextRelayerAccepted()).toBe(true);
  });

  test("a near miss is not an acknowledgement", () => {
    // `true`, `1`, `yes` and the variable's own name are all things someone reaches for when
    // they want a gate to go away. None of them say what is being accepted, so none of them
    // count — the whole value of the phrase is that it cannot be set absent-mindedly.
    delete process.env.KMS_KEY_ID;
    for (const value of ["true", "1", "yes", "ARCLITE_MAINNET_PLAINTEXT_RELAYER", ""]) {
      process.env.ARCLITE_MAINNET_PLAINTEXT_RELAYER = value;
      expect(plaintextRelayerAccepted()).toBe(false);
      expect(() => assertKeyPolicy(4663, true)).toThrow(RelayerUnavailable);
    }
  });

  test("KMS_KEY_ID throws while there is no KMS signer to honour it", () => {
    // The dangerous combination, and the reason this test exists: someone sets this believing
    // the key is now in a hardware module, and the relayer goes on signing with the plaintext
    // key exactly as before. Silence here would be a false sense of custody.
    process.env.KMS_KEY_ID = "arn:aws:kms:us-east-1:1:key/abc";
    process.env.ARCLITE_MAINNET_PLAINTEXT_RELAYER = PLAINTEXT_ACK;
    expect(() => assertKeyPolicy(4663, true)).toThrow(RelayerUnavailable);
    expect(() => assertKeyPolicy(4663, true)).toThrow(/no KMS account/);
  });

  test("allows mainnet when there is no plaintext key at all", () => {
    delete process.env.KMS_KEY_ID;
    delete process.env.ARCLITE_MAINNET_PLAINTEXT_RELAYER;
    expect(() => assertKeyPolicy(4663, false)).not.toThrow();
  });

  test("leaves testnet alone", () => {
    // The whole point of a testnet is that a plaintext key is acceptable there.
    delete process.env.KMS_KEY_ID;
    delete process.env.ARCLITE_MAINNET_PLAINTEXT_RELAYER;
    expect(() => assertKeyPolicy(46630, true)).not.toThrow();
  });

  test("throws rather than warning", () => {
    // A warning in a serverless log is a warning nobody reads. The failure has to stop the
    // relayer from existing, not annotate it.
    delete process.env.KMS_KEY_ID;
    delete process.env.ARCLITE_MAINNET_PLAINTEXT_RELAYER;
    let threw = false;
    try {
      assertKeyPolicy(4663, true);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
