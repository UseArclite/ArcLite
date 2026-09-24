import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { candidateNote, deriveVaultKeys, vaultMessage } from "@/lib/notes/vault";
import type { VaultRequest, VaultResponse } from "../vault.worker";

/**
 * The worker's message protocol, exercised against a real Worker rather than by calling the
 * handler directly.
 *
 * Two things are only true across the boundary: that keys stay on the far side of it, and that
 * everything crossing survives structured cloning — bigints do not, which is why every field
 * value in the protocol is a decimal string. Calling the handler in-process would prove neither.
 */

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const worker = new Worker(new URL("../vault.worker.ts", import.meta.url).href, { type: "module" });
afterAll(() => worker.terminate());

let nextId = 1;
function ask(request: Omit<VaultRequest, "id"> & Record<string, unknown>): Promise<VaultResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not reply")), 10_000);
    const onMessage = (event: MessageEvent<VaultResponse>) => {
      if (event.data.id !== id) return;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage as EventListener);
      resolve(event.data);
    };
    worker.addEventListener("message", onMessage as EventListener);
    worker.postMessage({ ...request, id });
  });
}

const signature = await account.signMessage({ message: vaultMessage(account.address) });
const keys = await deriveVaultKeys(signature);

describe("vault worker", () => {
  test("refuses to scan before it is unlocked", async () => {
    const response = await ask({ type: "scan", leaves: [], expected: [] });
    expect(response).toMatchObject({ type: "error", error: "vault is locked" });
  });

  test("unlocks and reports the same fingerprint the pure derivation computes", async () => {
    const response = await ask({ type: "unlock", signature });
    expect(response.type).toBe("unlocked");
    if (response.type !== "unlocked") return;
    expect(response.fingerprint).toBe(keys.fingerprint);
  });

  test("never sends key material across the boundary", async () => {
    // The guarantee the worker exists for. Asserted against the serialised reply, so a key
    // smuggled inside any nested field is caught, not just one added as a top-level property.
    const response = await ask({
      type: "scan",
      leaves: [],
      expected: [{ epoch: 1, counter: 0, assetId: "1", units: "100" }],
    });
    const wire = JSON.stringify(response);
    for (const secret of [keys.npk, keys.pkX, keys.pkY, keys.ivk]) {
      expect(wire).not.toContain(secret.toString());
    }
    expect(wire).not.toContain(signature);
    // nsecret is per-note and equally secret — it is the spending authority for that note.
    expect(wire).not.toContain(candidateNote(keys, 1, 0, 1n, 100n).note.nsecret.toString());
  });

  test("finds a note that is in the tree and reports its leaf index", async () => {
    const mine = candidateNote(keys, 1, 0, 7n, 4242n);
    const response = await ask({
      type: "scan",
      leaves: ["1", "2", mine.commitment.toString()],
      expected: [{ epoch: 1, counter: 0, assetId: "7", units: "4242" }],
    });
    expect(response.type).toBe("scanned");
    if (response.type !== "scanned") return;
    expect(response.confirmed).toEqual([
      {
        epoch: 1,
        counter: 0,
        assetId: "7",
        units: "4242",
        leafIndex: 2,
        // The same value the leaf was matched against — and the handle any order spending this
        // note carries, which is what lets receipts be found without a second local record.
        commitment: `0x${mine.commitment.toString(16).padStart(64, "0")}`,
        // Present so the client can ask the pool whether the note is already spent. A
        // commitment stays in the tree forever, so without this a spent note is
        // indistinguishable from a live one.
        nullifier: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        // And how to rebuild it. A deposit and a settlement output share the same
        // `(epoch, counter)` when the output came from that deposit, so the pair alone names
        // two different notes.
        origin: { kind: "deposit" },
      },
    ]);
    expect(response.balances).toEqual([{ assetId: "7", units: "4242" }]);
    expect(response.leafCount).toBe(3);
  });

  test("reports an empty tree as an honest zero rather than an error", async () => {
    const response = await ask({
      type: "scan",
      leaves: [],
      expected: [{ epoch: 1, counter: 0, assetId: "1", units: "100" }],
    });
    expect(response.type).toBe("scanned");
    if (response.type !== "scanned") return;
    expect(response.confirmed).toHaveLength(0);
    expect(response.unconfirmed).toHaveLength(1);
    expect(response.balances).toHaveLength(0);
  });

  test("units survive the boundary at uint256 scale", async () => {
    // Anything that crossed as a number here would round. 10^30 is past 2^53 by a wide margin.
    const big = (10n ** 30n + 7n).toString();
    const mine = candidateNote(keys, 2, 1, 3n, BigInt(big));
    const response = await ask({
      type: "scan",
      leaves: [mine.commitment.toString()],
      expected: [{ epoch: 2, counter: 1, assetId: "3", units: big }],
    });
    expect(response.type).toBe("scanned");
    if (response.type !== "scanned") return;
    expect(response.balances).toEqual([{ assetId: "3", units: big }]);
  });

  test("locking makes it forget, so a later scan cannot use stale keys", async () => {
    expect((await ask({ type: "lock" })).type).toBe("locked");
    const after = await ask({ type: "scan", leaves: [], expected: [] });
    expect(after).toMatchObject({ type: "error", error: "vault is locked" });
  });

  test("an unknown message is an error, not a crash or a useful reply", async () => {
    const response = await ask({ type: "export-keys" } as never);
    expect(response).toMatchObject({ type: "error", error: "unknown request" });
  });
});

/**
 * Recovering a vault that has lost its records.
 *
 * A note is regenerated from (epoch, counter, assetId, units). The signature gives the first
 * two; the last two live only in the browser's own records — so losing them means a vault that
 * scans the tree and honestly finds nothing while the money sits in it. The notes are not lost.
 * The coordinates are.
 *
 * `Shielded` carries the asset, the amount and the commitment, and `shield` is a public transfer
 * so the depositor is the transaction sender. That leaves the counter as the only unknown, and
 * it is a small integer.
 */
describe("recovering from the chain", () => {
  // An earlier test locks the vault on purpose, to prove locking forgets. These need it open.
  beforeAll(async () => {
    await ask({ type: "unlock", signature });
  });

  test("finds the counter for each deposit, given only what the chain shows", async () => {
    // Deliberately not 0, 1, 2: a search that only ever tried the obvious ones would pass a
    // test built from them and fail on a vault that had deposited a few times first.
    const planted = [
      { counter: 0, assetId: 1n, units: 1_000_000n },
      { counter: 3, assetId: 22n, units: 4_000_000_000_000_000n },
      { counter: 7, assetId: 7n, units: 60_000_000_000_000_000n },
    ];
    const deposits = planted.map((p) => ({
      assetId: p.assetId.toString(),
      units: p.units.toString(),
      // Exactly what the chain would report, and nothing else.
      commitment: `0x${candidateNote(keys, 1, p.counter, p.assetId, p.units).commitment.toString(16).padStart(64, "0")}`,
    }));

    const response = await ask({ type: "recover", deposits, maxCounter: 32 });
    expect(response.type).toBe("recovered");
    if (response.type !== "recovered") return;

    expect(response.records).toEqual(
      planted.map((p) => ({
        epoch: 1,
        counter: p.counter,
        assetId: p.assetId.toString(),
        units: p.units.toString(),
      })),
    );
    expect(response.unmatched).toEqual([]);
  });

  test("names a deposit it could not place rather than dropping it", async () => {
    // A commitment this vault did not create — someone else's deposit, or a counter beyond the
    // search bound. Silently omitting it would tell the holder their recovery was complete.
    const mine = candidateNote(keys, 1, 2, 1n, 500n);
    const response = await ask({
      type: "recover",
      deposits: [
        {
          assetId: "1",
          units: "500",
          commitment: `0x${mine.commitment.toString(16).padStart(64, "0")}`,
        },
        { assetId: "1", units: "999", commitment: `0x${"ab".repeat(32)}` },
      ],
      maxCounter: 16,
    });
    expect(response.type).toBe("recovered");
    if (response.type !== "recovered") return;

    expect(response.records).toEqual([{ epoch: 1, counter: 2, assetId: "1", units: "500" }]);
    expect(response.unmatched).toEqual([`0x${"ab".repeat(32)}`]);
  });
});
