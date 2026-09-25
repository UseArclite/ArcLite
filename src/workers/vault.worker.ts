/// <reference lib="webworker" />
import { commitment as noteCommitment, nullifier } from "@/lib/notes/note";
import { sealPayload } from "@/lib/notes/order-seal";
import { sealViewingKey, toHex } from "@/lib/notes/disclosure";
import { signSpend } from "@/lib/notes/vault";
import { buildUnshieldWitness } from "@/lib/notes/unshield";
import { proveUnshield } from "@/lib/notes/browser-prover";
import {
  balanceByAsset,
  candidateNote,
  outputNote,
  deriveVaultKeys,
  rebuildNote,
  scanLeaves,
  type Candidate,
  type ConfirmedNote,
  type NoteOrigin,
  type VaultKeys,
} from "@/lib/notes/vault";

/**
 * The vault worker: the only place in the browser that holds private key material.
 *
 * Two reasons it is a worker rather than a module on the main thread, and the second is the one
 * that matters:
 *
 *   1. Scanning hashes the whole leaf set. On the main thread that janks the UI; here it does
 *      not touch the frame budget.
 *   2. **The keys never enter the document's scope.** Nothing on the main thread — no React
 *      state, no devtools inspection of a provider, no third-party script that gets bundled in
 *      later — can reach them. Messages carry balances out; they never carry keys.
 *
 * Consequently this file never sends `npk`, `pkX`, `pkY`, `ivk`, `nsecret`, or a raw signature
 * in any reply, and never accepts a request to export them. There is deliberately no
 * `type: 'export'`. If proving later needs a witness, it gets built here and only the proof
 * leaves.
 */

export type VaultRequest =
  | { id: number; type: "unlock"; signature: string }
  | { id: number; type: "lock" }
  | {
      id: number;
      type: "scan";
      /** Every commitment in the tree, in leaf order, as decimal strings. */
      leaves: string[];
      /** The notes this client believes it created: (epoch, counter, assetId, units). */
      expected: { epoch: number; counter: number; assetId: string; units: string }[];
      /**
       * Notes a settlement produced for this vault.
       *
       * These have no counter of their own — `settleBatch` derives each from the spent note's
       * `nsecret` and the window id — so they cannot be expressed as `expected` and a vault
       * that only looks there is blind to everything it has traded into.
       */
      outputs?: {
        parentEpoch: number;
        parentCounter: number;
        windowId: string;
        slot: 0 | 1;
        assetId: string;
        units: string;
      }[];
      /** Nullifiers already published on-chain, as decimal strings. */
      spent?: string[];
    }
  | {
      /**
       * Seal one epoch's viewing key to an auditor.
       *
       * Here rather than on the main thread because the input is the master `ivk`. Sealing is
       * the one operation that deliberately hands out key material, so the material it hands out
       * has to be the derived epoch key and nothing else — and the only way to guarantee that is
       * for the master never to cross this boundary.
       */
      id: number;
      type: "seal-disclosure";
      epoch: number;
      /** The auditor's published X25519 key, 32 bytes, hex. */
      auditorPublicKey: string;
    }
  | {
      /** The commitment for a note this vault is about to shield. */
      id: number;
      type: "prepare-deposit";
      epoch: number;
      counter: number;
      assetId: string;
      units: string;
    }
  | {
      id: number;
      /**
       * Match on-chain deposits back to their counters.
       *
       * A note needs (epoch, counter, assetId, units) and only the first two come from the keys.
       * The chain supplies the other two — `Shielded` names the asset, the amount and the
       * commitment — so the counter is the one unknown, and it is a small integer that can
       * simply be tried. This is what lets a vault rebuild itself on a browser that has never
       * seen it.
       */
      type: "recover";
      /** From the chain: what was deposited, and the commitment it produced. */
      deposits: { assetId: string; units: string; commitment: string }[];
      /** How far to search. Counters are assigned densely from zero. */
      maxCounter: number;
    }
  | {
      id: number;
      type: "prepare-order";
      /** The window this order is for. The signature is bound to it. */
      windowId: string;
      /** Where the note sits in the pool's tree — needed for its nullifier. */
      leafIndex: string;
      /** The window's published X25519 key, hex. The payload is sealed to it here. */
      windowPublicKey: string;
      /** Identifies the note being spent — a buyer spends quote, a seller spends the asset. */
      epoch: number;
      counter: number;
      noteAssetId: string;
      /** Units the note holds, decimal. Not the order size: a note is spent whole. */
      noteUnits: string;
      /** How the note was made. Omitted means a deposit, for callers that predate outputs. */
      origin?: NoteOrigin;
      /** The asset being traded, which is the asset the note holds only for a sell. */
      assetId: string;
      /** Raw units offered, decimal. For a buy these are base units the quote note pays for. */
      quantity: string;
      side: "buy" | "sell";
    }
  | {
      id: number;
      type: "prepare-unshield";
      /** The note to spend, as the vault found it in the tree. */
      epoch: number;
      counter: number;
      assetId: string;
      noteUnits: string;
      /** How the note was made. Omitted means a deposit, for callers that predate outputs. */
      origin?: NoteOrigin;
      /**
       * The whole commitment set, as `scan` takes it.
       *
       * The worker rebuilds the tree and finds the note's own path, rather than being handed
       * one. Same reason `scan` does: asking a server for the path to *your* leaf tells it which
       * leaf is yours, and a wrong path is a rejected transaction rather than a lost note — so
       * the cost of doing it here is a few hashes and the benefit is that the question never
       * arises.
       */
      leaves: string[];
      /** Raw units to withdraw. The remainder comes back as a change note. */
      units: string;
      recipient: string;
      /** The counter the change note is derived at. Must not collide with an existing note. */
      changeCounter: number;
    };

export type VaultResponse =
  | { id: number; type: "unlocked"; fingerprint: string; version: number }
  | { id: number; type: "locked" }
  | {
      id: number;
      type: "scanned";
      fingerprint: string;
      root: string;
      leafCount: number;
      confirmed: {
        epoch: number;
        counter: number;
        assetId: string;
        units: string;
        leafIndex: number;
        /** Also the handle any order spending this note was submitted under. */
        commitment: string;
        /** Public once spent. Ask the pool's `nullifierSpent` whether this note is still live. */
        nullifier: string;
        /**
         * How this note was made, and therefore how to rebuild it.
         *
         * A settlement output carries its *parent's* `(epoch, counter)` because that is the only
         * handle it has, so those two fields cannot tell the two derivations apart. Returning
         * this is what lets a later spend rebuild the note it is actually spending rather than
         * silently rebuilding the parent — which is what made every traded note unspendable.
         */
        origin: NoteOrigin;
      }[];
      unconfirmed: { epoch: number; counter: number; assetId: string; units: string }[];
      balances: { assetId: string; units: string }[];
    }
  | { id: number; type: "deposit-prepared"; commitment: string; counter: number }
  | {
      id: number;
      type: "disclosure-sealed";
      /** The sealed box, hex. Opaque to everything but the auditor's secret key. */
      sealed: string;
      epoch: number;
    }
  | {
      id: number;
      type: "recovered";
      /** The records a vault needs to find these notes, in the shape `scan` takes. */
      records: { epoch: number; counter: number; assetId: string; units: string }[];
      /** Deposits whose counter was not found within `maxCounter`. */
      unmatched: string[];
    }
  | {
      id: number;
      type: "unshield-prepared";
      /** Exactly `RwaDarkPool.unshield`'s arguments. Nothing secret survives the return. */
      proof: string;
      root: string;
      nullifier: string;
      changeCommitment: string;
      assetId: number;
      units: string;
      recipient: string;
      relayer: string;
      relayerFeeUnits: string;
      /** So the client can remember the change note and find it again after the withdrawal. */
      change: { counter: number; assetId: string; units: string } | null;
      provingMs: number;
    }
  | {
      id: number;
      type: "order-prepared";
      /** Everything the intake API needs, and nothing it must not have. */
      commitment: string;
      nonceHash: string;
      accountHash: string;
      /** The sealed payload, hex. The main thread never sees its contents. */
      payloadCt: string;
    }
  /**
   * A phase boundary inside a long job, so the main thread can say what is happening.
   *
   * Unlike every other member this does **not** complete the request: the same `id` still gets
   * its real reply afterwards. The router in `vault-provider.tsx` has to leave the pending
   * handler in place when it sees one, which is the whole reason this is a separate type rather
   * than a field on the result.
   *
   * Nothing secret travels here. A phase name is not a witness.
   */
  | { id: number; type: "progress"; phase: ProofPhase }
  | { id: number; type: "error"; error: string };

/**
 * The stages a withdrawal actually goes through, in order.
 *
 * Named after what the worker does rather than after a cryptographic narrative: there is no local
 * verification step here, so there is no stage claiming one. `broadcasting` is set by the main
 * thread once the proof comes back and the transaction goes out.
 */
export type ProofPhase = "locating" | "witness" | "proving" | "broadcasting";

// Module scope inside the worker. Never posted, never persisted.
let keys: VaultKeys | null = null;

function post(message: VaultResponse) {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
}

const toHex32 = (v: bigint): string => `0x${v.toString(16).padStart(64, "0")}`;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function digest(input: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function nullifierOf(note: ConfirmedNote): bigint {
  return nullifier(note.commitment, note.note.nsecret, BigInt(note.leafIndex));
}

async function handle(request: VaultRequest): Promise<VaultResponse> {
  switch (request.type) {
    case "unlock": {
      keys = await deriveVaultKeys(request.signature);
      // The fingerprint is a hash of the viewing key, so it identifies the vault without
      // disclosing anything that could read it.
      return {
        id: request.id,
        type: "unlocked",
        fingerprint: keys.fingerprint,
        version: keys.version,
      };
    }

    case "lock": {
      keys = null;
      return { id: request.id, type: "locked" };
    }

    case "scan": {
      if (!keys) return { id: request.id, type: "error", error: "vault is locked" };

      const candidates: Candidate[] = [
        ...request.expected.map((e) =>
          candidateNote(keys!, e.epoch, e.counter, BigInt(e.assetId), BigInt(e.units)),
        ),
        // Notes a crossing produced. Derived from the note they replaced rather than from a
        // counter, which is what lets the owner of the input recover the output and nobody
        // else — and what puts them out of `candidateNote`'s reach.
        ...(request.outputs ?? []).map((o) =>
          outputNote(
            keys!,
            { epoch: o.parentEpoch, counter: o.parentCounter },
            BigInt(o.windowId),
            o.slot,
            BigInt(o.assetId),
            BigInt(o.units),
          ),
        ),
      ];
      const leaves = request.leaves.map((l) => BigInt(l));
      const result = scanLeaves(candidates, leaves);

      const spent = new Set((request.spent ?? []).map((n) => BigInt(n)));
      const balances = balanceByAsset(result.confirmed, spent, nullifierOf);

      return {
        id: request.id,
        type: "scanned",
        fingerprint: keys.fingerprint,
        root: result.root.toString(),
        leafCount: result.leafCount,
        confirmed: result.confirmed.map((c) => ({
          epoch: c.epoch,
          counter: c.counter,
          assetId: c.assetId.toString(),
          units: c.units.toString(),
          leafIndex: c.leafIndex,
          origin: c.origin,
          // The note's commitment is also the handle its orders were submitted under, so
          // returning it lets the client ask what became of them without keeping a second
          // record of its own. One thing to lose instead of two.
          commitment: toHex32(c.commitment),
          // And its nullifier, so the client can ask the pool whether the note is already
          // spent. This is not key material: a nullifier is published on chain the moment the
          // note is spent, and it reveals nothing about the secret it derives from. Without it
          // the main thread cannot tell a live note from one settlement consumed — a commitment
          // stays in the tree forever, because the tree is append-only.
          nullifier: toHex32(nullifierOf(c)),
        })),
        unconfirmed: result.unconfirmed.map((c) => ({
          epoch: c.epoch,
          counter: c.counter,
          assetId: c.assetId.toString(),
          units: c.units.toString(),
        })),
        balances: [...balances].map(([assetId, units]) => ({
          assetId: assetId.toString(),
          units: units.toString(),
        })),
      };
    }

    case "recover": {
      if (!keys) return { id: request.id, type: "error", error: "vault is locked" };

      // Try each counter against each deposit until the commitment matches.
      //
      // Bounded and cheap: a few hundred Poseidon hashes for a wallet with a handful of
      // deposits, done once after losing a browser. Epoch is 1 throughout — the epoch lane is
      // for scoped auditor disclosure and nothing has opened it yet, so searching others would
      // be searching for notes that cannot exist.
      const wanted = new Map(request.deposits.map((d) => [d.commitment.toLowerCase(), d]));
      const records: { epoch: number; counter: number; assetId: string; units: string }[] = [];

      for (const d of request.deposits) {
        for (let counter = 0; counter <= request.maxCounter; counter++) {
          const c = candidateNote(keys, 1, counter, BigInt(d.assetId), BigInt(d.units));
          if (toHex32(c.commitment).toLowerCase() !== d.commitment.toLowerCase()) continue;
          records.push({ epoch: 1, counter, assetId: d.assetId, units: d.units });
          wanted.delete(d.commitment.toLowerCase());
          break;
        }
      }

      return {
        id: request.id,
        type: "recovered",
        // Ascending, so the next deposit's counter carries on from the highest found rather
        // than colliding with one of these.
        records: records.sort((a, b) => a.counter - b.counter),
        // Named rather than silently dropped: a deposit the search could not place is a note
        // this vault cannot spend, and the holder should know it exists.
        unmatched: [...wanted.keys()],
      };
    }

    case "seal-disclosure": {
      if (!keys) return { id: request.id, type: "error", error: "vault is locked" };
      const pk = hexToBytes(request.auditorPublicKey);
      if (pk.length !== 32) {
        return {
          id: request.id,
          type: "error",
          error: "an auditor key is 32 bytes — that is " + pk.length,
        };
      }
      // `sealViewingKey` derives `ivk_epoch` itself and seals only that. The master key is read
      // here and nowhere else, and nothing derived from it is returned except the box.
      const sealed = await sealViewingKey(keys.ivk, request.epoch, pk);
      return {
        id: request.id,
        type: "disclosure-sealed",
        sealed: toHex(sealed),
        epoch: request.epoch,
      };
    }

    case "prepare-deposit": {
      if (!keys) return { id: request.id, type: "error", error: "vault is locked" };
      // Only the commitment leaves. The note's secrets stay here, and the client regenerates the
      // whole note later from (epoch, counter, assetId, units) — which is why a deposit needs no
      // ciphertext stored anywhere.
      const candidate = candidateNote(
        keys,
        request.epoch,
        request.counter,
        BigInt(request.assetId),
        BigInt(request.units),
      );
      return {
        id: request.id,
        type: "deposit-prepared",
        commitment: toHex32(candidate.commitment),
        counter: request.counter,
      };
    }

    case "prepare-order": {
      if (!keys) return { id: request.id, type: "error", error: "vault is locked" };

      // The note this order offers. Built here, from the vault's keys, so `owner` and `nsecret`
      // never cross to the main thread — and the payload is sealed here for the same reason: the
      // window's plaintext order would otherwise exist, however briefly, in the document's scope.
      //
      // Through `rebuildNote`, not `candidateNote`. A note a crossing returned carries its
      // parent's `(epoch, counter)` and derives from the parent's secret, so rebuilding it the
      // deposit way produces the parent — a real note of this vault, already spent settling the
      // order that created this one. Every order funded from a traded note was therefore
      // submitted against a commitment the venue had already seen, and refused as already
      // offered, with nothing on screen to explain why.
      const candidate = rebuildNote(keys, {
        epoch: request.epoch,
        counter: request.counter,
        assetId: BigInt(request.noteAssetId),
        units: BigInt(request.noteUnits),
        origin: request.origin ?? { kind: "deposit" },
      });

      // The spend authorisation. Produced here, in the worker, because it needs the spending
      // secret — the one piece of key material that must never reach the document's scope.
      const nul = nullifier(
        candidate.commitment,
        candidate.note.nsecret,
        BigInt(request.leafIndex),
      );
      const sig = signSpend(
        keys,
        BigInt(request.windowId),
        BigInt(request.assetId),
        request.side,
        BigInt(request.quantity),
        nul,
      );

      const payload = {
        assetId: Number(request.assetId),
        side: request.side,
        quantity: request.quantity,
        noteUnits: request.noteUnits,
        owner: candidate.note.owner.toString(),
        // The order salt is the note's rho: already unique per (epoch, counter) and already
        // derived from the viewing key, so it needs no second source of randomness — and it
        // regenerates with the note, which a fresh random salt would not.
        salt: candidate.note.nsecret.toString(),
        auth: {
          pkX: keys.pkX.toString(),
          pkY: keys.pkY.toString(),
          npk: keys.npk.toString(),
          sLo: sig.sLo.toString(),
          sHi: sig.sHi.toString(),
          eLo: sig.eLo.toString(),
          eHi: sig.eHi.toString(),
        },
      };

      const windowKey = hexToBytes(request.windowPublicKey);
      const payloadCt = await sealPayload(payload, windowKey);

      // `account_hash` links this trader's orders within one window and not across windows —
      // the window key is the salt, so a new window gives a new hash for the same account.
      const accountHash = await digest(`account:${keys.fingerprint}:${request.windowPublicKey}`);
      const nonceHash = await digest(`nonce:${candidate.commitment}:${request.counter}`);

      return {
        id: request.id,
        type: "order-prepared",
        commitment: toHex32(candidate.commitment),
        nonceHash,
        accountHash,
        payloadCt: `0x${[...payloadCt].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      };
    }

    case "prepare-unshield": {
      if (!keys) return { id: request.id, type: "error", error: "vault is locked" };

      // Built *and proved* here, in the worker, because the witness contains the note's secrets
      // — `nsecret`, the owner preimage, the spending key's public half. Anything that can build
      // this witness can spend the note, so a server that offered to prove withdrawals for you
      // would be a server you had handed your funds to. It is also what makes "unshield is
      // always open" true rather than promised: this path needs no operator at all.
      // Same rule as an order: rebuild the note the way it was made. A withdrawal of a note a
      // crossing returned would otherwise rebuild the parent, whose commitment is not at the
      // leaf being proved against — so the scan below would simply not find it, and the holder
      // would be told their own note was not in the pool.
      // Each phase is announced before it starts, so the panel is never a step behind what the
      // worker is doing. Proving is seconds; the two before it are milliseconds, and showing them
      // is what makes the wait legible rather than uniform.
      post({ id: request.id, type: "progress", phase: "locating" });
      const candidate = rebuildNote(keys, {
        epoch: request.epoch,
        counter: request.counter,
        assetId: BigInt(request.assetId),
        units: BigInt(request.noteUnits),
        origin: request.origin ?? { kind: "deposit" },
      });
      const found = scanLeaves([candidate], request.leaves.map(BigInt));
      const confirmed = found.confirmed[0];
      if (!confirmed) {
        // The note is not in this pool's tree. Either the deposit never landed, or it is in a
        // different pool — both are worth saying plainly, because "proof failed" would not be.
        return {
          id: request.id,
          type: "error",
          error: "that note is not in this pool's commitment set",
        };
      }
      post({ id: request.id, type: "progress", phase: "witness" });
      const witness = buildUnshieldWitness(keys, found.root, {
        note: confirmed,
        units: BigInt(request.units),
        recipient: request.recipient as `0x${string}`,
        changeCounter: request.changeCounter,
      });

      post({ id: request.id, type: "progress", phase: "proving" });
      const started = Date.now();
      const proof = await proveUnshield(witness.inputs);
      const p = witness.publicInputs;
      return {
        id: request.id,
        type: "unshield-prepared",
        proof: proof.proof,
        root: toHex32(p.root),
        nullifier: toHex32(p.nullifier),
        changeCommitment: toHex32(p.changeCommitment),
        assetId: Number(p.assetId),
        units: p.units.toString(),
        recipient: request.recipient,
        relayer: "0x0000000000000000000000000000000000000000",
        relayerFeeUnits: "0",
        change: witness.change
          ? {
              counter: witness.change.counter,
              assetId: request.assetId,
              units: witness.change.units.toString(),
            }
          : null,
        provingMs: Date.now() - started,
      };
    }

    default: {
      // An unknown message is a bug or an intrusion attempt; either way, say nothing useful.
      return { id: (request as { id: number }).id ?? -1, type: "error", error: "unknown request" };
    }
  }
}

self.addEventListener("message", (event: MessageEvent<VaultRequest>) => {
  void handle(event.data)
    .then(post)
    .catch((error: unknown) =>
      post({ id: event.data?.id ?? -1, type: "error", error: (error as Error).message }),
    );
});
