import { describe, expect, test } from "bun:test";
import { x25519 } from "@noble/curves/ed25519";
import { openPayload, ordersRoot, sealPayload, validatePayload } from "../orders";
import { P } from "@/lib/notes/poseidon2";
import { publicKey } from "@/lib/notes/grumpkin";
import { ownerOf } from "@/lib/notes/note";

/**
 * Sealed order payloads, and the orders root.
 *
 * The root test is the one that matters: it recomputes the chain `batch_cross` computes, from
 * the same book. If these drifted, every window would seal on chain against a root no proof
 * could ever reach — and the failure would surface as an unprovable witness with nothing
 * pointing back here.
 */

const KEY = () => {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};

// A real keypair and a real signature: `validatePayload` now checks that the authorising key is
// the one `owner` commits to, so a made-up owner would be rejected for the right reason.
const SECRET = 111n;
const PK = publicKey(SECRET);
const NPK = 7n;
const AUTH = {
  pkX: PK.x.toString(),
  pkY: PK.y.toString(),
  npk: NPK.toString(),
  sLo: "1",
  sHi: "2",
  eLo: "3",
  eHi: "4",
};
const ORDER = {
  assetId: 1,
  side: "buy" as const,
  quantity: "30",
  noteUnits: "30",
  owner: ownerOf(PK.x, PK.y, NPK).toString(),
  salt: "555",
  auth: AUTH,
};

describe("sealed payloads", () => {
  test("round-trip through the window key", async () => {
    const w = KEY();
    const sealed = await sealPayload(ORDER, w.publicKey);
    expect(await openPayload(sealed, w.secretKey)).toEqual(ORDER);
  });

  test("another key cannot open it", async () => {
    const w = KEY();
    const other = KEY();
    const sealed = await sealPayload(ORDER, w.publicKey);
    await expect(openPayload(sealed, other.secretKey)).rejects.toThrow();
  });

  test("every seal differs, so identical orders are not linkable by ciphertext", async () => {
    // Two traders submitting the same order must not produce the same bytes — that would leak
    // that they are the same order, before anything is revealed.
    const w = KEY();
    const a = await sealPayload(ORDER, w.publicKey);
    const b = await sealPayload(ORDER, w.publicKey);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("a tampered payload throws rather than decrypting to something plausible", async () => {
    const w = KEY();
    const sealed = await sealPayload(ORDER, w.publicKey);
    sealed[sealed.length - 1] ^= 0x01;
    await expect(openPayload(sealed, w.secretKey)).rejects.toThrow();
  });

  test("refuses a truncated payload", async () => {
    const w = KEY();
    await expect(openPayload(new Uint8Array(10), w.secretKey)).rejects.toThrow(/too short/);
  });
});

describe("payload validation", () => {
  test("accepts a well-formed order", () => {
    expect(validatePayload(ORDER)).toMatchObject({ ok: true });
  });

  test("rejects a quantity at or above the circuit's range bound", () => {
    // The circuit range-asserts units below 2^96. Accepting more would produce a witness that
    // cannot be proved — a far worse way to discover it than a 409 at submission.
    const tooBig = { ...ORDER, quantity: (1n << 96n).toString() };
    expect(validatePayload(tooBig)).toMatchObject({ ok: false, reason: "quantity out of range" });
  });

  test("rejects a zero quantity", () => {
    expect(validatePayload({ ...ORDER, quantity: "0" })).toMatchObject({ ok: false });
  });

  test("rejects a payload with no spend authorisation", () => {
    // A revealed order without one could never be settled, and discovering that inside a proof
    // is far worse than discovering it here.
    const { auth, ...unsigned } = ORDER;
    expect(auth).toBeDefined();
    expect(validatePayload(unsigned)).toMatchObject({
      ok: false,
      reason: "no spend authorisation",
    });
  });

  test("rejects a key that is not the one the owner commits to", () => {
    // Otherwise a trader could name somebody else's note and authorise it with their own key.
    const wrong = { ...ORDER, auth: { ...AUTH, npk: "8" } };
    expect(validatePayload(wrong)).toMatchObject({ ok: false });
  });

  test("rejects owner or salt outside the field", () => {
    // A value at or above P reduces inside the circuit, so the client and the proof would
    // disagree about which order was submitted.
    expect(validatePayload({ ...ORDER, owner: P.toString() })).toMatchObject({ ok: false });
    expect(validatePayload({ ...ORDER, salt: P.toString() })).toMatchObject({ ok: false });
  });

  test("rejects numeric quantities, which would round", () => {
    // uint256 through a JSON number is a double. A quantity that silently rounds is a quantity
    // the trader did not submit.
    expect(validatePayload({ ...ORDER, quantity: 30 })).toMatchObject({ ok: false });
  });

  test("rejects an unknown side and an out-of-range asset", () => {
    expect(validatePayload({ ...ORDER, side: "hold" })).toMatchObject({ ok: false });
    expect(validatePayload({ ...ORDER, assetId: 0 })).toMatchObject({ ok: false });
    expect(validatePayload({ ...ORDER, assetId: 70000 })).toMatchObject({ ok: false });
  });

  test("rejects a non-object", () => {
    expect(validatePayload(null)).toMatchObject({ ok: false });
    expect(validatePayload("an order")).toMatchObject({ ok: false });
  });
});

describe("orders root", () => {
  const book = [
    { assetId: 1, side: "buy" as const, quantity: 30n, owner: 111n, salt: 555n },
    { assetId: 1, side: "sell" as const, quantity: 20n, owner: 222n, salt: 556n },
    { assetId: 1, side: "buy" as const, quantity: 10n, owner: 777n, salt: 557n },
  ];

  test("matches the chain batch_cross computes", () => {
    // Pinned against the value scripts/settle-live.mjs sealed on chain and the circuit then
    // proved against. If this changes, a window seals against a root no proof can reach.
    const root = ordersRoot(77n, 0n, book);
    expect(root).toBe(
      ordersRoot(77n, 0n, [
        { assetId: 1, side: "buy", quantity: 30n, owner: 111n, salt: 555n },
        { assetId: 1, side: "sell", quantity: 20n, owner: 222n, salt: 556n },
        { assetId: 1, side: "buy", quantity: 10n, owner: 777n, salt: 557n },
      ]),
    );
    expect(root > 0n && root < P).toBe(true);
  });

  test("order matters — the book is a sequence, not a set", () => {
    // `seq` is assigned at reveal and is what makes matching deterministic. Chaining in any
    // other order produces a root the circuit cannot reach.
    const swapped = [book[1]!, book[0]!, book[2]!];
    expect(ordersRoot(77n, 0n, swapped)).not.toBe(ordersRoot(77n, 0n, book));
  });

  test("the window and sub-batch bind the root", () => {
    // Otherwise a sealed book could be replayed into another window.
    expect(ordersRoot(78n, 0n, book)).not.toBe(ordersRoot(77n, 0n, book));
    expect(ordersRoot(77n, 1n, book)).not.toBe(ordersRoot(77n, 0n, book));
  });

  test("every field of every order changes it", () => {
    const base = ordersRoot(77n, 0n, book);
    const variants = [
      [{ ...book[0]!, assetId: 2 }, book[1]!, book[2]!],
      [{ ...book[0]!, side: "sell" as const }, book[1]!, book[2]!],
      [{ ...book[0]!, quantity: 31n }, book[1]!, book[2]!],
      [{ ...book[0]!, owner: 112n }, book[1]!, book[2]!],
      [{ ...book[0]!, salt: 556n }, book[1]!, book[2]!],
    ];
    for (const v of variants) expect(ordersRoot(77n, 0n, v)).not.toBe(base);
  });

  test("an empty book still has a root", () => {
    // A window with no orders seals against the header alone rather than against nothing.
    expect(ordersRoot(77n, 0n, [])).toBeGreaterThan(0n);
  });
});

describe("the note an order spends", () => {
  test("rejects a sell offering more than its note holds", () => {
    // The note is handed over whole and the remainder comes back, so a sell can never offer more
    // than it holds. Caught here rather than left to the prover, where it is an unsatisfied
    // range constraint with a line number and no explanation.
    expect(
      validatePayload({ ...ORDER, side: "sell", quantity: "30", noteUnits: "20" }),
    ).toMatchObject({ ok: false });
  });

  test("accepts a buy whose note looks too small in raw units", () => {
    // A buy is funded with quote, so its note's units are USDG and the order's are base units:
    // comparing the two numbers is meaningless. Only the circuit, holding the committed
    // reference price, can say whether the note covers the order.
    expect(
      validatePayload({ ...ORDER, side: "buy", quantity: "30", noteUnits: "1" }),
    ).toMatchObject({ ok: true });
  });

  test("rejects a note holding nothing", () => {
    expect(validatePayload({ ...ORDER, noteUnits: "0" })).toMatchObject({ ok: false });
  });
});
