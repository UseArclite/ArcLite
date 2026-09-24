import { x25519 } from "@noble/curves/ed25519";
import { sealPayload } from "@/lib/notes/order-seal";
import { hash2 } from "@/lib/notes/poseidon2";
import { ownerOf } from "@/lib/notes/note";
import { P } from "@/lib/notes/poseidon2";
import { db } from "@/server/db";
import { ARCLITE, resolveChainId } from "@/lib/chain/chains";

/**
 * Sealed order intake, and the reveal that turns a sealed book into an orders root.
 *
 * ## What the server can check before the seal, and what it deliberately cannot
 *
 * Intake validates the window is open, the commitment is unspoken-for, the account is inside its
 * rate limit, and the ciphertext matches the hash the submitter bound to it. All of that is
 * possible **without reading the payload**, which is the point: an operator that had to decrypt
 * an order to decide whether to accept it would see the whole book as it arrived.
 *
 * ## KEYPAIR mode offers no protection against early decryption, and stores its key accordingly
 *
 * The first version of this held the window secret in process memory and wrote it to the row
 * only once the book closed, so a reader of the database could not open orders early. That looks
 * like a security property and is not one: the *operator* — the same process — held the key the
 * whole time. It bought nothing against the only adversary it could plausibly deter, and it cost
 * availability, because a serverless instance that vanishes between opening a window and sealing
 * it takes the key with it and makes every order in that window undecryptable.
 *
 * That is not a hypothetical. It happened on the first end-to-end run: the reveal was invoked
 * from a different process than the one that opened the window, and the book was unrecoverable.
 *
 * So the secret is written immediately, and `KEYPAIR` is documented as what it is — a transport
 * encryption that keeps orders private from *other traders* and from anyone reading the network,
 * and not from us. `TLOCK` is the mode that makes early decryption impossible rather than
 * impolite, because the key does not exist until drand publishes the round. `seal_mode` is
 * recorded per window precisely so a window sealed under the weaker mode can never later be
 * described as having used the stronger one.
 */

export { sealPayload };

export const SEAL_MODE = (process.env.ARCLITE_SEAL_MODE ?? "KEYPAIR") as "KEYPAIR" | "TLOCK";
export const MAX_ORDERS_PER_ACCOUNT = Number(process.env.ARCLITE_MAX_ORDERS_PER_ACCOUNT ?? 8);

export interface OrderPayload {
  assetId: number;
  side: "buy" | "sell";
  /** Raw token units, as a decimal string — uint256, so never a JSON number. */
  quantity: string;
  /**
   * Units held by the note being spent, which is not the same number as `quantity`.
   *
   * A note is spent whole — its nullifier is published — so the unspent remainder comes back as
   * a fresh note. A seller's note holds the asset; a **buyer's holds quote**, and has to cover
   * the order's cost at the committed reference rather than its quantity in base units.
   */
  noteUnits: string;
  /** The note's owner field, decimal. */
  owner: string;
  /**
   * Per-order salt, decimal. Binds the order to its commitment in the sealed book.
   *
   * It is also **the note's `nsecret`**, and that is load-bearing rather than incidental: the
   * settler rebuilds the spent note from this field and refuses the order if the result does not
   * reproduce the commitment claimed at submission. The vault worker sets it deliberately — the
   * note's rho is already unique per (epoch, counter) and already derived from the viewing key,
   * so it needs no second source of randomness and it regenerates with the note.
   *
   * An order built with an independent salt submits, seals, prices and matches, and then fails
   * at settlement with "revealed payload does not rebuild its commitment" — a message that names
   * the symptom and not the coupling.
   */
  salt: string;
  /**
   * The owner's authorisation for this spend, produced inside the vault worker.
   *
   * Without it the sealer could replay a revealed note into a later batch — `owner` and the note
   * secret are both in the plaintext, and before this they were everything a witness needed.
   */
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

export interface SubmitResult {
  ok: boolean;
  reason?: string;
  orderId?: string;
}

const bytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/**
 * The open window's database row.
 *
 * Separate from `currentWindow`, which returns the public `WindowView` the dashboard renders.
 * That shape deliberately has no row id — it is sent to browsers — and widening it to carry one
 * so this module could use it would leak an internal key into a public API for convenience.
 */
export async function openWindowRow(
  chainId: number,
): Promise<{ id: string; seq: string; chainWindowId: string; sealsAt: string } | null> {
  const sql = db();
  const rows = await sql<{ id: string; seq: string; chain_window_id: string; seals_at: Date }[]>`
    select id::text, seq::text, chain_window_id::text, seals_at from arclite.windows
     where chain_id = ${chainId} and status = 'OPEN'
     order by seq desc limit 1
  `;
  const r = rows[0];
  return r
    ? { id: r.id, seq: r.seq, chainWindowId: r.chain_window_id, sealsAt: r.seals_at.toISOString() }
    : null;
}

/** The X25519 key an open window's orders are sealed to, created on first use. */
export async function windowSealingKey(
  windowId: string,
): Promise<{ publicKey: Uint8Array; mode: string }> {
  const sql = db();
  const existing = await sql<{ public_key: Uint8Array; seal_mode: string }[]>`
    select public_key, seal_mode from arclite.window_keys where window_id = ${windowId}::bigint
  `;
  if (existing[0]) return { publicKey: existing[0].public_key, mode: existing[0].seal_mode };

  const secretKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(secretKey);

  // Written immediately, not withheld. Withholding it from the database while the process that
  // generated it still holds it protects against nobody and loses the book if that process dies.
  // Under TLOCK there is no secret to store at all.
  await sql`
    insert into arclite.window_keys (window_id, public_key, secret_key, seal_mode)
    values (${windowId}::bigint, ${Buffer.from(publicKey)}, ${Buffer.from(secretKey)},
            ${SEAL_MODE}::arclite.seal_mode)
    on conflict (window_id) do nothing
  `;
  const stored = await sql<{ public_key: Uint8Array; seal_mode: string }[]>`
    select public_key, seal_mode from arclite.window_keys where window_id = ${windowId}::bigint
  `;
  return { publicKey: stored[0]!.public_key, mode: stored[0]!.seal_mode };
}

export async function submitOrder(input: {
  chainId: number;
  windowSeq: string;
  accountHash: string;
  commitment: string;
  nonceHash: string;
  payloadCt: string;
}): Promise<SubmitResult> {
  const ct = bytes(input.payloadCt);
  // Bound at submission so a payload cannot be swapped afterwards for one that decrypts
  // differently. The sealer checks it again before trusting a single field.
  const payloadHash = await sha256(ct);

  const sql = db();
  const rows = await sql<{ ok: boolean; reason: string | null; order_id: string | null }[]>`
    select ok, reason, order_id::text from arclite.submit_order(
      ${input.chainId}, ${input.windowSeq}::bigint,
      ${Buffer.from(bytes(input.accountHash))}, ${Buffer.from(bytes(input.commitment))},
      ${Buffer.from(bytes(input.nonceHash))}, ${Buffer.from(ct)}, ${Buffer.from(payloadHash)},
      ${MAX_ORDERS_PER_ACCOUNT}
    )
  `;
  const r = rows[0]!;
  return { ok: r.ok, reason: r.reason ?? undefined, orderId: r.order_id ?? undefined };
}

/** Open the sealed box an order arrived in. Throws if it was tampered with. */
export async function openPayload(ct: Uint8Array, secretKey: Uint8Array): Promise<OrderPayload> {
  if (ct.length <= 33) throw new Error("payload is too short");
  const ephemeral = ct.slice(1, 33);
  const shared = x25519.getSharedSecret(secretKey, ephemeral);
  const key = await crypto.subtle.importKey("raw", shared as BufferSource, "HKDF", false, [
    "deriveKey",
  ]);
  const aes = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("arclite/order/v1") as BufferSource,
      info: x25519.getPublicKey(secretKey) as BufferSource,
    },
    key,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(12) },
      aes,
      ct.slice(33) as BufferSource,
    ),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as OrderPayload;
}

/** A payload is only usable if every field is in range. Rejected orders stay in the book. */
export function validatePayload(
  p: unknown,
): { ok: true; payload: OrderPayload } | { ok: false; reason: string } {
  if (!p || typeof p !== "object") return { ok: false, reason: "payload is not an object" };
  const o = p as Record<string, unknown>;
  if (!Number.isInteger(o.assetId) || (o.assetId as number) < 1 || (o.assetId as number) > 65535) {
    return { ok: false, reason: "assetId out of range" };
  }
  if (o.side !== "buy" && o.side !== "sell")
    return { ok: false, reason: "side must be buy or sell" };
  for (const field of ["quantity", "noteUnits", "owner", "salt"] as const) {
    if (typeof o[field] !== "string" || !/^\d+$/.test(o[field] as string)) {
      return { ok: false, reason: `${field} must be a decimal string` };
    }
  }
  const quantity = BigInt(o.quantity as string);
  // The circuit range-asserts units below 2^96. An order above it would produce a witness that
  // cannot be proved, which is a far worse way to find out than rejecting it here.
  if (quantity <= 0n || quantity >= 1n << 96n)
    return { ok: false, reason: "quantity out of range" };
  const noteUnits = BigInt(o.noteUnits as string);
  if (noteUnits <= 0n || noteUnits >= 1n << 96n)
    return { ok: false, reason: "noteUnits out of range" };
  // A sell comes straight out of the note, so the note has to hold at least what is offered. A
  // buy cannot be checked here — its cost depends on the reference price, which is committed
  // after the seal — so the circuit is what enforces that one.
  if (o.side === "sell" && noteUnits < quantity)
    return { ok: false, reason: "the note holds less than the order offers" };
  for (const field of ["owner", "salt"] as const) {
    if (BigInt(o[field] as string) >= P)
      return { ok: false, reason: `${field} is not a field element` };
  }

  const auth = o.auth as Record<string, unknown> | undefined;
  if (!auth || typeof auth !== "object") return { ok: false, reason: "no spend authorisation" };
  for (const field of ["pkX", "pkY", "npk", "sLo", "sHi", "eLo", "eHi"] as const) {
    if (typeof auth[field] !== "string" || !/^\d+$/.test(auth[field] as string)) {
      return { ok: false, reason: `auth.${field} must be a decimal string` };
    }
    if (BigInt(auth[field] as string) >= P) {
      return { ok: false, reason: `auth.${field} is not a field element` };
    }
  }

  // The authorising key must be the one `owner` commits to, or a trader could name somebody
  // else's note and sign it with their own key. Checked here rather than left to the circuit: a
  // mismatch found now names the problem, while the same mismatch found by the prover is an
  // unsatisfied constraint with a line number and nothing else.
  const expectedOwner = ownerOf(
    BigInt(auth.pkX as string),
    BigInt(auth.pkY as string),
    BigInt(auth.npk as string),
  );
  if (expectedOwner !== BigInt(o.owner as string)) {
    return { ok: false, reason: "the authorising key does not match the note's owner" };
  }

  return { ok: true, payload: o as unknown as OrderPayload };
}

const DOMAIN_ORDER = 0x6f72646572n; // "order"

/**
 * The orders root over a revealed book, matching `batch_cross`'s chain exactly.
 *
 * Order matters and is `seq`, assigned at reveal. Chaining in any other order produces a root the
 * circuit cannot reach, and the failure would surface as an unprovable witness rather than as
 * anything that points here.
 */
export function ordersRoot(
  windowId: bigint,
  subBatchIndex: bigint,
  book: readonly {
    assetId: number;
    side: "buy" | "sell";
    quantity: bigint;
    owner: bigint;
    salt: bigint;
  }[],
): bigint {
  let root = hash2(DOMAIN_ORDER, windowId);
  root = hash2(root, subBatchIndex);
  for (const o of book) {
    root = hash2(
      root,
      hash2(
        hash2(hash2(BigInt(o.assetId), o.side === "buy" ? 0n : 1n), o.quantity),
        hash2(o.owner, o.salt),
      ),
    );
  }
  return root;
}

/**
 * Decrypt a sealed window's book, in submission order, and record its orders root.
 *
 * Every order is either revealed or rejected — never dropped. Dropping one would make the order
 * count disagree with the book, and the orders root the contract was sealed with unreachable.
 */
export async function revealWindow(
  windowId: string,
  chainWindowId: bigint,
): Promise<{
  revealed: number;
  rejected: number;
  ordersRoot: string | null;
}> {
  const sql = db();
  const stored = await sql<{ secret_key: Uint8Array | null; seal_mode: string }[]>`
    select secret_key, seal_mode from arclite.window_keys where window_id = ${windowId}::bigint
  `;
  const key = stored[0]?.secret_key;
  if (!key) {
    // No key, so the book cannot be opened. The caller must void the window rather than settle
    // an empty one — settling would silently discard orders traders believe are resting.
    return { revealed: 0, rejected: 0, ordersRoot: null };
  }

  await sql`
    update arclite.window_keys set revealed_at = now() where window_id = ${windowId}::bigint
  `;

  const orders = await sql<{ id: string; payload_ct: Uint8Array; payload_hash: Uint8Array }[]>`
    select id::text, payload_ct, payload_hash from arclite.orders
     where window_id = ${windowId}::bigint and status = 'SEALED'
     order by submitted_at, id
  `;

  // A buy is paid for with a quote note, so a network with no quote asset cannot fund one. The
  // order would seal, match, and then fail at settlement — wedging the window and every deposit
  // behind it — so it is refused here, where the trader gets a reason instead of a stuck window.
  const hasQuoteAsset = ARCLITE[resolveChainId()].quoteAssetId !== null;

  const book: {
    assetId: number;
    side: "buy" | "sell";
    quantity: bigint;
    owner: bigint;
    salt: bigint;
  }[] = [];
  let rejected = 0;
  let seq = 0;

  for (const row of orders) {
    try {
      const digest = await sha256(row.payload_ct);
      if (Buffer.from(digest).toString("hex") !== Buffer.from(row.payload_hash).toString("hex")) {
        throw new Error("payload does not match the hash bound at submission");
      }
      const opened = await openPayload(row.payload_ct, key);
      const checked = validatePayload(opened);
      if (!checked.ok) throw new Error(checked.reason);

      const p = checked.payload;
      if (p.side === "buy" && !hasQuoteAsset) {
        throw new Error("buys are closed on this network until a quote asset is deployed");
      }
      await sql`
        select arclite.reveal_order(${row.id}::bigint, ${seq}, ${p.assetId}, ${p.side},
          ${p.quantity}::numeric, ${p.noteUnits}::numeric, ${p.owner}::numeric, ${p.salt}::numeric,
          ${p.auth.pkX}::numeric, ${p.auth.pkY}::numeric, ${p.auth.npk}::numeric,
          ${p.auth.sLo}::numeric, ${p.auth.sHi}::numeric,
          ${p.auth.eLo}::numeric, ${p.auth.eHi}::numeric)
      `;
      book.push({
        assetId: p.assetId,
        side: p.side,
        quantity: BigInt(p.quantity),
        owner: BigInt(p.owner),
        salt: BigInt(p.salt),
      });
      seq += 1;
    } catch (error) {
      await sql`select arclite.reject_order(${row.id}::bigint, ${(error as Error).message.slice(0, 200)})`;
      rejected += 1;
    }
  }

  const root = ordersRoot(chainWindowId, 0n, book);
  const rootBytes = Buffer.from(root.toString(16).padStart(64, "0"), "hex");
  await sql`select arclite.set_orders_root(${windowId}::bigint, ${rootBytes}, ${book.length})`;

  return {
    revealed: book.length,
    rejected,
    ordersRoot: `0x${root.toString(16).padStart(64, "0")}`,
  };
}
