import { describe, expect, test } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { commitment, nullifier, computeRoot, IncrementalTree } from "../note";
import { hash2, P } from "../poseidon2";
import {
  balanceByAsset,
  candidateNote,
  deriveVaultKeys,
  ownerField,
  outputNote,
  rebuildNote,
  scanLeaves,
  vaultMessage,
  VAULT_KEY_VERSION,
  type ConfirmedNote,
} from "../vault";

/**
 * Key derivation and note discovery.
 *
 * The failure mode these guard against is silent: wrong keys do not raise, they produce a
 * different account whose notes simply never appear. So the assertions are about *sameness* —
 * same signature to same keys, same keys to same commitments — rather than about any value
 * being "correct" in isolation.
 */

// Anvil's published account #1. A test key, never a secret.
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const other = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

const sign = (a: typeof account) => a.signMessage({ message: vaultMessage(a.address) });

/** One vault, derived the way the app derives it. */
const vaultKeys = async () => deriveVaultKeys(await sign(account));

describe("the signed message", () => {
  test("names the address and the version, so a signature cannot cross either", () => {
    const message = vaultMessage("0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333");
    expect(message).toContain("0xaaaabbbbccccddddeeeeffff0000111122223333");
    expect(message).toContain(`Version: ${VAULT_KEY_VERSION}`);
  });

  test("says plainly that it is not a transaction", () => {
    // The person reading this prompt is the last line of defence, so the wording is a tested
    // property rather than a nicety.
    const message = vaultMessage("0x1111111111111111111111111111111111111111");
    expect(message).toContain("does not approve a transaction");
    expect(message).toContain("Only sign this on the ArcLite site");
  });
});

describe("key derivation", () => {
  test("is deterministic — the same signature always opens the same vault", async () => {
    // This is the whole recovery story. If it ever fails, the notes are unreachable, not hidden.
    const signature = await sign(account);
    const a = await deriveVaultKeys(signature);
    const b = await deriveVaultKeys(signature);
    expect(a).toEqual(b);
  });

  test("a wallet re-signing the same message reproduces the vault", async () => {
    // Relies on deterministic ECDSA (RFC 6979). Asserting it here means a wallet or library that
    // ever signed with a random nonce fails a test rather than losing someone's balance.
    expect(await sign(account)).toBe(await sign(account));
  });

  test("different accounts get different vaults", async () => {
    const a = await deriveVaultKeys(await sign(account));
    const b = await deriveVaultKeys(await sign(other));
    expect(a.ivk).not.toBe(b.ivk);
    expect(a.npk).not.toBe(b.npk);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test("the four subkeys are independent, not slices of one stretch", async () => {
    const k = await deriveVaultKeys(await sign(account));
    const values = [k.npk, k.pkX, k.pkY, k.ivk];
    expect(new Set(values.map(String)).size).toBe(4);
  });

  test("every subkey lands inside the field", async () => {
    // A value at or above P is not a field element; the circuit would reduce it and compute a
    // different owner than the client did.
    const k = await deriveVaultKeys(await sign(account));
    for (const v of [k.npk, k.pkX, k.pkY, k.ivk]) {
      expect(v >= 0n).toBe(true);
      expect(v < P).toBe(true);
    }
  });

  test("a version bump produces a different vault rather than the same one", async () => {
    const signature = await sign(account);
    const v1 = await deriveVaultKeys(signature, 1);
    const v2 = await deriveVaultKeys(signature, 2);
    expect(v1.ivk).not.toBe(v2.ivk);
    expect(v2.version).toBe(2);
  });

  test("the fingerprint is short, stable, and not the key", async () => {
    const k = await deriveVaultKeys(await sign(account));
    expect(k.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(k.fingerprint).not.toContain(k.ivk.toString(16));
  });

  test("refuses a signature too short to hold 512 bits of entropy", async () => {
    await expect(deriveVaultKeys("0xdeadbeef")).rejects.toThrow(/too short/);
  });

  test("refuses a malformed hex string rather than silently truncating", async () => {
    await expect(deriveVaultKeys("0xabc")).rejects.toThrow(/whole number of bytes/);
  });
});

describe("candidate notes", () => {
  test("regenerate identically from the key alone — the recovery property", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const first = candidateNote(keys, 7, 3, 1n, 100n);
    const again = candidateNote(keys, 7, 3, 1n, 100n);
    expect(again.commitment).toBe(first.commitment);
    expect(again.note.nsecret).toBe(first.note.nsecret);
  });

  test("the commitment is exactly what the note SDK computes", async () => {
    // The circuit and the contract both build the commitment this way; the vault must not have
    // its own idea of the formula.
    const keys = await deriveVaultKeys(await sign(account));
    const c = candidateNote(keys, 1, 0, 42n, 500n);
    expect(c.commitment).toBe(commitment(c.note));
    expect(c.note.owner).toBe(ownerField(keys));
  });

  test("a different counter, epoch, asset or size is a different note", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const base = candidateNote(keys, 1, 0, 1n, 100n);
    for (const variant of [
      candidateNote(keys, 1, 1, 1n, 100n),
      candidateNote(keys, 2, 0, 1n, 100n),
      candidateNote(keys, 1, 0, 2n, 100n),
      candidateNote(keys, 1, 0, 1n, 101n),
    ]) {
      expect(variant.commitment).not.toBe(base.commitment);
    }
  });

  test("nsecret differs per note, so one spend cannot expose another", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const secrets = new Set(
      Array.from({ length: 16 }, (_, i) =>
        candidateNote(keys, 1, i, 1n, 1n).note.nsecret.toString(),
      ),
    );
    expect(secrets.size).toBe(16);
  });

  test("the view tag is one byte and spreads across its range", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const tags = Array.from({ length: 256 }, (_, i) => candidateNote(keys, 1, i, 1n, 1n).viewTag);
    expect(tags.every((t) => Number.isInteger(t) && t >= 0 && t <= 255)).toBe(true);
    // A constant or near-constant tag would leak nothing but would also filter nothing.
    expect(new Set(tags).size).toBeGreaterThan(100);
  });

  test("another vault's notes are not confusable with ours", async () => {
    const mine = await deriveVaultKeys(await sign(account));
    const theirs = await deriveVaultKeys(await sign(other));
    expect(candidateNote(mine, 1, 0, 1n, 100n).commitment).not.toBe(
      candidateNote(theirs, 1, 0, 1n, 100n).commitment,
    );
  });
});

describe("scanning the tree", () => {
  test("finds our leaves among strangers' and builds a path that reaches the root", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const theirs = await deriveVaultKeys(await sign(other));

    const ours = [candidateNote(keys, 1, 0, 1n, 100n), candidateNote(keys, 1, 2, 5n, 250n)];
    const noise = [0, 1, 3, 4].map((i) => candidateNote(theirs, 1, i, 9n, 1n));

    // Interleaved, so a scan that assumed our notes were contiguous would pass by accident.
    const leaves = [noise[0]!, ours[0]!, noise[1]!, noise[2]!, ours[1]!, noise[3]!].map(
      (c) => c.commitment,
    );

    const result = scanLeaves(ours, leaves);
    expect(result.confirmed.map((c) => c.leafIndex)).toEqual([1, 4]);
    expect(result.unconfirmed).toHaveLength(0);
    expect(result.leafCount).toBe(6);

    // The path is the thing a proof is built from. If it does not reach the root, the contract
    // rejects the proof — so verify it rather than merely checking it is 24 elements long.
    for (const note of result.confirmed) {
      expect(computeRoot(note.commitment, note.path, BigInt(note.leafIndex))).toBe(result.root);
    }
  });

  test("the locally rebuilt root matches the tree the contract would build", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const leaves = [0, 1, 2].map((i) => candidateNote(keys, 1, i, 1n, 10n).commitment);
    const tree = new IncrementalTree();
    for (const leaf of leaves) tree.insert(leaf);
    expect(scanLeaves([], leaves).root).toBe(tree.root());
  });

  test("a note that never landed is reported unconfirmed, not silently dropped", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const landed = candidateNote(keys, 1, 0, 1n, 100n);
    const missing = candidateNote(keys, 1, 1, 1n, 100n);
    const result = scanLeaves([landed, missing], [landed.commitment]);
    expect(result.confirmed).toHaveLength(1);
    expect(result.unconfirmed.map((c) => c.counter)).toEqual([1]);
  });

  test("an empty tree yields no notes and the empty root, not an error", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    // This is today's real state: nothing is deployed, so there is nothing to find. It must be a
    // clean zero rather than a crash or a fabricated balance.
    const result = scanLeaves([candidateNote(keys, 1, 0, 1n, 100n)], []);
    expect(result.confirmed).toHaveLength(0);
    expect(result.leafCount).toBe(0);
    expect(result.root).toBe(new IncrementalTree().root());
  });

  test("a duplicated commitment resolves to its first position", async () => {
    // Only the first is spendable: the nullifier binds the leaf index, and the contract accepts
    // the nullifier of whichever leaf the prover cites — so pointing at the later copy would
    // produce a valid-looking note the pool has already accounted for once.
    const keys = await deriveVaultKeys(await sign(account));
    const c = candidateNote(keys, 1, 0, 1n, 100n);
    const result = scanLeaves([c], [c.commitment, c.commitment]);
    expect(result.confirmed[0]!.leafIndex).toBe(0);
  });
});

describe("balances", () => {
  const nullifierOf = (n: ConfirmedNote) =>
    nullifier(n.commitment, n.note.nsecret, BigInt(n.leafIndex));

  test("sum per asset in raw units, with no prices anywhere near the vault", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const notes = [
      candidateNote(keys, 1, 0, 1n, 100n),
      candidateNote(keys, 1, 1, 1n, 250n),
      candidateNote(keys, 1, 2, 7n, 5n),
    ];
    const result = scanLeaves(
      notes,
      notes.map((n) => n.commitment),
    );
    const totals = balanceByAsset(result.confirmed, new Set(), nullifierOf);
    expect(totals.get(1n)).toBe(350n);
    expect(totals.get(7n)).toBe(5n);
  });

  test("a spent note stops counting", async () => {
    const keys = await deriveVaultKeys(await sign(account));
    const notes = [candidateNote(keys, 1, 0, 1n, 100n), candidateNote(keys, 1, 1, 1n, 250n)];
    const result = scanLeaves(
      notes,
      notes.map((n) => n.commitment),
    );
    const spent = new Set([nullifierOf(result.confirmed[0]!)]);
    expect(balanceByAsset(result.confirmed, spent, nullifierOf).get(1n)).toBe(250n);
  });

  test("totals are exact at sizes that would lose precision as numbers", async () => {
    // Raw units are uint256. Anything that touched a double here would round silently.
    const keys = await deriveVaultKeys(await sign(account));
    const big = 10n ** 30n + 1n;
    const notes = [candidateNote(keys, 1, 0, 1n, big), candidateNote(keys, 1, 1, 1n, big)];
    const result = scanLeaves(
      notes,
      notes.map((n) => n.commitment),
    );
    expect(balanceByAsset(result.confirmed, new Set(), nullifierOf).get(1n)).toBe(2n * big);
  });
});

/**
 * Finding the notes a crossing produced.
 *
 * Settlement does not mint outputs from a counter. It derives each from the **spent** note's
 * `nsecret` and the window it settled in, which is what lets the owner of the input recover the
 * output and nobody else. It also means `candidateNote` cannot reach them — they have no counter
 * of their own — so a vault that regenerates only deposits is blind to every note it has ever
 * traded into. That is not a cosmetic gap: the money sits in the pool, owed, and invisible, and
 * the withdraw panel simply disappears.
 *
 * These assert the client derives byte-identically to `buildWitness`. A drift here is a note
 * nobody can ever find again.
 */
const outputAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const outputKeys = await deriveVaultKeys(
  await outputAccount.signMessage({ message: vaultMessage(outputAccount.address) }),
);

describe("notes a settlement produced", () => {
  const keys = outputKeys;

  test("matches the settler's derivation for both slots", () => {
    const windowId = 77n;
    const parent = { epoch: 1, counter: 3 };

    // What the client regenerates for the note that was spent.
    const spent = candidateNote(keys, parent.epoch, parent.counter, 4n, 10_000_000000n);

    for (const slot of [0, 1] as const) {
      const out = outputNote(keys, parent, windowId, slot, 1n, 42n);
      // The rule `buildWitness` applies, written out rather than imported, so a change to
      // either side fails this instead of both moving together.
      const expected = commitment({
        assetId: 1n,
        units: 42n,
        owner: spent.note.owner,
        nsecret: hash2(spent.note.nsecret, hash2(windowId, BigInt(slot))),
      });
      expect(out.commitment).toBe(expected);
    }
  });

  test("the two slots are different notes, and neither is the parent", () => {
    const parent = { epoch: 1, counter: 0 };
    const residual = outputNote(keys, parent, 5n, 0, 4n, 1n);
    const received = outputNote(keys, parent, 5n, 1, 4n, 1n);
    const spent = candidateNote(keys, parent.epoch, parent.counter, 4n, 1n);
    expect(residual.commitment).not.toBe(received.commitment);
    expect(residual.commitment).not.toBe(spent.commitment);
  });

  test("a different window gives a different note", () => {
    // The window is in the derivation so the same note spent in two windows cannot produce the
    // same output twice.
    const parent = { epoch: 1, counter: 2 };
    expect(outputNote(keys, parent, 9n, 0, 1n, 7n).commitment).not.toBe(
      outputNote(keys, parent, 10n, 0, 1n, 7n).commitment,
    );
  });
});

/**
 * Rebuilding a note the way it was actually made.
 *
 * The bug these guard against reached mainnet and was invisible from every number on screen.
 *
 * A settlement output carries its **parent's** `(epoch, counter)` — it has no counter of its own,
 * and those two fields are the only handle it has. `prepare-order` rebuilt the note it was about
 * to spend with `candidateNote`, the deposit derivation, from exactly those two fields. So an
 * order funded by a note a crossing had returned rebuilt the *parent* instead: a real note of the
 * same vault, same owner, same asset, well-formed in every way — and already spent, settling the
 * very order that produced the output being spent.
 *
 * The venue refused it as already offered, which was true and unexplainable from the dashboard.
 * The vault could see every note a crossing gave it and could spend none of them.
 */
describe("rebuildNote", () => {
  test("a deposit and its own output share (epoch, counter) and are different notes", async () => {
    const keys = await vaultKeys();
    const parent = candidateNote(keys, 1, 0, 7n, 1_000n);
    const residual = outputNote(keys, { epoch: 1, counter: 0 }, 223n, 0, 7n, 1_000n);

    // Same handle. This is why the pair cannot be the whole answer.
    expect(residual.epoch).toBe(parent.epoch);
    expect(residual.counter).toBe(parent.counter);
    expect(residual.commitment).not.toBe(parent.commitment);
    expect(residual.note.nsecret).not.toBe(parent.note.nsecret);
  });

  test("rebuilds an output, not its parent — the bug, stated directly", async () => {
    const keys = await vaultKeys();
    const parent = candidateNote(keys, 1, 0, 7n, 1_000n);
    const residual = outputNote(keys, { epoch: 1, counter: 0 }, 223n, 0, 7n, 1_000n);

    const rebuilt = rebuildNote(keys, {
      epoch: residual.epoch,
      counter: residual.counter,
      assetId: residual.assetId,
      units: residual.units,
      origin: residual.origin,
    });

    expect(rebuilt.commitment).toBe(residual.commitment);
    // The assertion that would have caught it: before the fix this was the parent.
    expect(rebuilt.commitment).not.toBe(parent.commitment);
  });

  test("rebuilds the received leg distinctly from the residual", async () => {
    const keys = await vaultKeys();
    const residual = outputNote(keys, { epoch: 1, counter: 4 }, 300n, 0, 7n, 50n);
    const received = outputNote(keys, { epoch: 1, counter: 4 }, 300n, 1, 1n, 900n);
    // Slot separates the two legs of one crossing; without it a trader's two outputs would be
    // the same note and one of them unspendable.
    expect(received.commitment).not.toBe(residual.commitment);
    expect(rebuildNote(keys, { ...received, origin: received.origin }).commitment).toBe(
      received.commitment,
    );
  });

  test("the window binds an output, so the same parent in two windows gives two notes", async () => {
    const keys = await vaultKeys();
    const a = outputNote(keys, { epoch: 1, counter: 0 }, 223n, 0, 7n, 1_000n);
    const b = outputNote(keys, { epoch: 1, counter: 0 }, 224n, 0, 7n, 1_000n);
    expect(a.commitment).not.toBe(b.commitment);
  });

  test("a deposit still rebuilds as itself", async () => {
    const keys = await vaultKeys();
    const deposit = candidateNote(keys, 1, 3, 7n, 25n);
    expect(rebuildNote(keys, { ...deposit, origin: deposit.origin }).commitment).toBe(
      deposit.commitment,
    );
    expect(deposit.origin).toEqual({ kind: "deposit" });
  });

  test("an output found by a scan keeps the origin that rebuilds it", async () => {
    const keys = await vaultKeys();
    const residual = outputNote(keys, { epoch: 1, counter: 0 }, 223n, 0, 7n, 1_000n);
    // Exactly the shape the vault uses: scan the tree, then spend what it found.
    const found = scanLeaves([residual], [1n, residual.commitment]).confirmed[0]!;
    expect(found.origin).toEqual({ kind: "output", windowId: "223", slot: 0 });
    expect(rebuildNote(keys, found).commitment).toBe(residual.commitment);
  });
});
