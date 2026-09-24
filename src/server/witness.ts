import { hash2 } from "@/lib/notes/poseidon2";
import { commitment, nullifier, zeroLadder, DEPTH, type Note } from "@/lib/notes/note";
import { MAX_ASSETS, pricesRoot, isDeferred, type PriceEntry } from "@/lib/notes/prices";

/**
 * Build the `batch_cross` witness from a matched window.
 *
 * This is where the matcher's answer becomes something a prover can consume, and it is also the
 * place TypeScript and Noir are forced to agree: every hash here is recomputed inside the circuit
 * and compared against a public input, so a drift shows up as a proof that will not generate
 * rather than as a wrong number that settles.
 *
 * Nothing here decides anything. It rearranges what `matchWindow` already decided into the exact
 * argument list `circuits/batch_cross/src/main.nr` takes.
 */

export const N_ORDERS = 16;
export const N_OUTPUTS = 32;

/**
 * `batch_cross`'s `quote_asset_id` is a public input, not a constant.
 *
 * It was hardcoded to 0, which read as "the registry's quote slot" — but `assetIdOf` returns 0
 * for *unregistered* and `nextAssetId` starts at 1, so no registered asset can have id 0. A
 * quote note would have carried an asset field the pool accounts nothing under, and a note the
 * pool cannot account for is a note it will never pay out. The pool now holds it in an immutable
 * and supplies it to the verifier, so the settler cannot choose it.
 */
/** `10^(dec_base + 18 - dec_quote)` for an 18-decimal base and a 6-decimal quote. */
export const QUOTE_SCALE = 10n ** 30n;

const DOMAIN_ORDER = 0x6f72646572n; // "order"
const DOMAIN_RECEIPT = 0x72637074n; // "rcpt"
const DOMAIN_TAPE = 0x74617065n; // "tape"

export interface SpendAuthorisation {
  /** The Grumpkin public key `owner` commits to. */
  pkX: bigint;
  pkY: bigint;
  npk: bigint;
  sLo: bigint;
  sHi: bigint;
  eLo: bigint;
  eHi: bigint;
}

export interface WitnessOrder {
  /** Row in the committed price table. One-hot in the circuit. */
  assetIndex: number;
  side: "buy" | "sell";
  quantity: bigint;
  filled: bigint;
  salt: bigint;
  /** The note being spent, and where it sits in the tree. */
  note: Note;
  /**
   * The owner's authorisation for this spend.
   *
   * Without it a settler holding a revealed order could replay the note into a later batch:
   * `owner` and `nsecret` are both in the plaintext, and before this they were all a witness
   * needed. The signature is the difference between knowing a secret and being allowed to use it.
   */
  auth: SpendAuthorisation;
  leafIndex: bigint;
  path: bigint[];
}

export interface WitnessInput {
  circuitVersion: bigint;
  windowId: bigint;
  subBatchIndex: bigint;
  oldRoot: bigint;
  entries: PriceEntry[];
  assetCount: number;
  pricedAt: bigint;
  sequencerOk: boolean;
  /** The pool's `quoteAssetId`. A buy is funded in it and a sell is paid in it. */
  quoteAssetId: bigint;
  orders: WitnessOrder[];
}

export interface BatchWitness {
  /** Public inputs, in the order `settleBatch` builds them. */
  publicInputs: {
    circuitVersion: bigint;
    windowId: bigint;
    subBatchIndex: bigint;
    oldRoot: bigint;
    ordersRoot: bigint;
    pricesRoot: bigint;
    deferMask: bigint;
    quoteAssetId: bigint;
    outputsSubtreeRoot: bigint;
    receiptsRoot: bigint;
    tapeLeaf: bigint;
    nullifiers: bigint[];
  };
  /** Everything else, as the circuit's parameter names. */
  private: Record<string, unknown>;
}

/** The five-level reduction over exactly 32 leaves, matching the circuit. */
export function subtreeRoot(leaves: readonly bigint[]): bigint {
  if (leaves.length !== N_OUTPUTS) throw new Error(`expected ${N_OUTPUTS} leaves`);
  let level = [...leaves];
  for (let d = 0; d < 5; d++) {
    const next: bigint[] = [];
    for (let j = 0; j < level.length / 2; j++) next.push(hash2(level[j * 2]!, level[j * 2 + 1]!));
    level = next;
  }
  return level[0]!;
}

/** Authentication path for a leaf in a tree built from `leaves`, padded with the zero ladder. */
export function authPath(leaves: readonly bigint[], index: number): bigint[] {
  const zeros = zeroLadder(DEPTH);
  const path: bigint[] = [];
  let level = [...leaves];
  let idx = index;
  for (let d = 0; d < DEPTH; d++) {
    const sibling = idx ^ 1;
    path.push(sibling < level.length ? level[sibling]! : zeros[d]!);
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hash2(level[i]!, i + 1 < level.length ? level[i + 1]! : zeros[d]!));
    }
    level = next;
    idx >>= 1;
  }
  return path;
}

function pad<T>(values: readonly T[], length: number, filler: T): T[] {
  if (values.length > length) throw new Error(`too many values: ${values.length} > ${length}`);
  return [...values, ...Array.from({ length: length - values.length }, () => filler)];
}

export function buildWitness(input: WitnessInput): BatchWitness {
  if (input.orders.length > N_ORDERS) {
    throw new Error(`a sub-batch holds at most ${N_ORDERS} orders`);
  }
  if (input.entries.length !== MAX_ASSETS) throw new Error(`expected ${MAX_ASSETS} table rows`);

  // Mirrors the circuit: a window may not price the asset it also pays out in, or a seller's
  // "quote" would be units of the very asset being traded and the pool would hand out twice what
  // it took in. Caught here so it reads as a misconfigured window rather than an unsatisfied
  // constraint with a line number.
  for (let a = 0; a < input.assetCount; a++) {
    if (input.entries[a]!.assetId === input.quoteAssetId) {
      throw new Error(`asset ${input.quoteAssetId} is the quote asset and cannot also be priced`);
    }
  }

  const { root: priceRoot, deferMask } = pricesRoot(
    input.entries,
    input.assetCount,
    input.windowId,
    input.pricedAt,
    input.sequencerOk,
  );

  const active = input.orders.length;

  // Per-order arrays, padded to the circuit's fixed width. A padding slot must be provably inert:
  // zero quantity, zero fill, zero nullifier.
  const assetSelector: bigint[][] = [];
  const side: bigint[] = [];
  const quantity: bigint[] = [];
  const filled: bigint[] = [];
  const orderSalt: bigint[] = [];
  const activeFlags: bigint[] = [];
  const inUnits: bigint[] = [];
  const pkX: bigint[] = [];
  const pkY: bigint[] = [];
  const npk: bigint[] = [];
  const sigSLo: bigint[] = [];
  const sigSHi: bigint[] = [];
  const sigELo: bigint[] = [];
  const sigEHi: bigint[] = [];
  const nsecret: bigint[] = [];
  const leafIndex: bigint[] = [];
  const paths: bigint[][] = [];
  const nullifiers: bigint[] = [];

  const zeros = zeroLadder(DEPTH);

  for (let i = 0; i < N_ORDERS; i++) {
    const order = input.orders[i];
    const selector = Array.from({ length: MAX_ASSETS }, () => 0n);
    // Padding slots still have to name a row, because the circuit's one-hot check runs
    // unconditionally. Row 0 is arbitrary and inert: their quantity and fill are zero.
    selector[order ? order.assetIndex : 0] = 1n;
    assetSelector.push(selector);

    if (!order) {
      side.push(0n);
      quantity.push(0n);
      filled.push(0n);
      orderSalt.push(0n);
      activeFlags.push(0n);
      inUnits.push(0n);
      pkX.push(0n);
      pkY.push(0n);
      npk.push(0n);
      sigSLo.push(0n);
      sigSHi.push(0n);
      sigELo.push(0n);
      sigEHi.push(0n);
      nsecret.push(0n);
      leafIndex.push(0n);
      paths.push([...zeros]);
      nullifiers.push(0n);
      continue;
    }

    const c = commitment(order.note);
    side.push(order.side === "buy" ? 0n : 1n);
    quantity.push(order.quantity);
    filled.push(order.filled);
    orderSalt.push(order.salt);
    activeFlags.push(1n);
    inUnits.push(order.note.units);
    pkX.push(order.auth.pkX);
    pkY.push(order.auth.pkY);
    npk.push(order.auth.npk);
    sigSLo.push(order.auth.sLo);
    sigSHi.push(order.auth.sHi);
    sigELo.push(order.auth.eLo);
    sigEHi.push(order.auth.eHi);
    nsecret.push(order.note.nsecret);
    leafIndex.push(order.leafIndex);
    paths.push(order.path);
    nullifiers.push(nullifier(c, order.note.nsecret, order.leafIndex));
  }

  // Per-asset aggregates. Derived here rather than taken from the matcher so the witness cannot
  // disagree with the book it was built from — the circuit checks both against each other anyway,
  // but a mismatch found here names the problem instead of failing as an unsatisfied constraint.
  const buyTotal = Array.from({ length: MAX_ASSETS }, () => 0n);
  const sellTotal = Array.from({ length: MAX_ASSETS }, () => 0n);
  const matched = Array.from({ length: MAX_ASSETS }, () => 0n);
  const buyIsSmaller = Array.from({ length: MAX_ASSETS }, () => 0n);

  for (let i = 0; i < active; i++) {
    const order = input.orders[i]!;
    if (order.side === "buy") buyTotal[order.assetIndex]! += order.quantity;
    else sellTotal[order.assetIndex]! += order.quantity;
  }
  for (let a = 0; a < MAX_ASSETS; a++) {
    const deferred = isDeferred(input.entries[a]!);
    matched[a] = deferred ? 0n : buyTotal[a]! < sellTotal[a]! ? buyTotal[a]! : sellTotal[a]!;
    buyIsSmaller[a] = buyTotal[a]! < sellTotal[a]! ? 1n : 0n;
  }

  // Witnessed quotient and remainder of quantity × matched / sideTotal. The circuit proves these
  // rather than dividing, because Noir's `/` on a Field is a modular inverse, not integer
  // division.
  const prorataQ = Array.from({ length: N_ORDERS }, () => 0n);
  const prorataR = Array.from({ length: N_ORDERS }, () => 0n);
  for (let i = 0; i < active; i++) {
    const order = input.orders[i]!;
    const total = order.side === "buy" ? buyTotal[order.assetIndex]! : sellTotal[order.assetIndex]!;
    if (total === 0n) continue;
    const numerator = order.quantity * matched[order.assetIndex]!;
    prorataQ[i] = numerator / total;
    prorataR[i] = numerator % total;
  }

  // Orders root: the sealed book, chained before any price was observed.
  let ordersRoot = hash2(DOMAIN_ORDER, input.windowId);
  ordersRoot = hash2(ordersRoot, input.subBatchIndex);
  for (let i = 0; i < N_ORDERS; i++) {
    if (activeFlags[i] !== 1n) continue;
    const assetId = input.entries[assetSelector[i]!.indexOf(1n)]!.assetId;
    const leaf = hash2(
      hash2(hash2(assetId, side[i]!), quantity[i]!),
      hash2(input.orders[i]!.note.owner, orderSalt[i]!),
    );
    ordersRoot = hash2(ordersRoot, leaf);
  }

  let receiptsRoot = hash2(DOMAIN_RECEIPT, input.windowId);
  for (let i = 0; i < N_ORDERS; i++) {
    const assetId = input.entries[assetSelector[i]!.indexOf(1n)]!.assetId;
    receiptsRoot = hash2(
      receiptsRoot,
      hash2(hash2(nullifiers[i]!, filled[i]!), hash2(quantity[i]!, assetId)),
    );
  }

  // Outputs are *derived*, never supplied. The circuit rebuilds them from the book and compares,
  // so anything else fails to prove — which is the whole point: until this existed, whoever built
  // the proof could spend a trader's note and pay the proceeds into a note they owned, and every
  // conservation check still passed because conservation is about how much crossed rather than
  // who received it.
  //
  // Two per order, in slot order: the residual, then the received leg.
  const outputs: bigint[] = Array.from({ length: N_OUTPUTS }, () => 0n);
  const quoteQ = Array.from({ length: N_ORDERS }, () => 0n);
  const quoteR = Array.from({ length: N_ORDERS }, () => 0n);
  // The quote cost of the *whole* order. The circuit proves a buyer's note covers this rather
  // than only the part that filled: the matcher picks `filled` after the order is signed, so a
  // note that covered some outcomes and not others would make a valid crossing unprovable.
  const maxCostQ = Array.from({ length: N_ORDERS }, () => 0n);
  const maxCostR = Array.from({ length: N_ORDERS }, () => 0n);

  for (let i = 0; i < N_ORDERS; i++) {
    const order = input.orders[i];
    const row = input.entries[assetSelector[i]!.indexOf(1n)]!;

    const product = filled[i]! * row.refValueE18;
    quoteQ[i] = product / QUOTE_SCALE;
    quoteR[i] = product % QUOTE_SCALE;
    const maxProduct = quantity[i]! * row.refValueE18;
    maxCostQ[i] = maxProduct / QUOTE_SCALE;
    maxCostR[i] = maxProduct % QUOTE_SCALE;

    if (!order) continue;

    const isSell = order.side === "sell";
    // A seller funds the trade with the asset; a buyer funds it with quote, and pays the
    // rounding up where the seller is paid the rounding down. Per asset the two sides' fills are
    // forced equal, so across the window buyers hand over at least what sellers take away.
    const spent = isSell ? order.filled : quoteQ[i]! + (quoteR[i]! > 0n ? 1n : 0n);
    const residual: Note = {
      assetId: isSell ? row.assetId : input.quoteAssetId,
      // `note.units`, not `quantity`. A note is spent whole — its nullifier is published — so
      // everything it held that did not fill has to come back. Using `quantity` meant a trader
      // offering 30 units of a 100-unit note forfeited the other 70.
      units: order.note.units - spent,
      owner: order.note.owner,
      nsecret: hash2(order.note.nsecret, hash2(input.windowId, 0n)),
    };
    const received: Note = {
      // A buyer receives base units; a seller receives quote.
      assetId: isSell ? input.quoteAssetId : row.assetId,
      units: isSell ? quoteQ[i]! : order.filled,
      owner: order.note.owner,
      nsecret: hash2(order.note.nsecret, hash2(input.windowId, 1n)),
    };

    outputs[i * 2] = commitment(residual);
    outputs[i * 2 + 1] = commitment(received);
  }

  // The tape commits to per-asset matched volume and nothing else. It used to chain the receipts
  // root, which commits to per-order (nullifier, filled, quantity) — revealing the tape against
  // that would have meant revealing the order book. A delayed tape publishes how much of each
  // asset crossed, not the trades that made up the total.
  let tape = hash2(
    hash2(DOMAIN_TAPE, input.windowId),
    hash2(input.subBatchIndex, input.circuitVersion),
  );
  // Only the live rows: empty ones carry nothing the commitment needs, and chaining all 32 cost
  // TapeRegistry 8.9M gas per publish recomputing hashes over zeros.
  for (let a = 0; a < input.assetCount; a++) {
    tape = hash2(tape, hash2(input.entries[a]!.assetId, matched[a]!));
  }

  return {
    publicInputs: {
      circuitVersion: input.circuitVersion,
      windowId: input.windowId,
      subBatchIndex: input.subBatchIndex,
      oldRoot: input.oldRoot,
      ordersRoot,
      pricesRoot: priceRoot,
      deferMask,
      quoteAssetId: input.quoteAssetId,
      outputsSubtreeRoot: subtreeRoot(outputs),
      receiptsRoot,
      tapeLeaf: tape,
      nullifiers,
    },
    private: {
      entries: input.entries,
      asset_count: input.assetCount,
      priced_at: input.pricedAt,
      sequencer_ok: input.sequencerOk,
      asset_selector: assetSelector,
      side,
      quantity,
      filled,
      order_salt: orderSalt,
      active: activeFlags,
      in_units: inUnits,
      pk_x: pkX,
      pk_y: pkY,
      npk,
      sig_s_lo: sigSLo,
      sig_s_hi: sigSHi,
      sig_e_lo: sigELo,
      sig_e_hi: sigEHi,
      nsecret,
      leaf_index: leafIndex,
      path: paths,
      asset_buy_total: buyTotal,
      asset_sell_total: sellTotal,
      asset_matched: matched,
      buy_is_smaller: buyIsSmaller,
      prorata_q: prorataQ,
      prorata_r: prorataR,
      max_cost_q: maxCostQ,
      max_cost_r: maxCostR,
      out_commitment: outputs,
      quote_q: quoteQ,
      quote_r: quoteR,
    },
  };
}

/** Render a witness as the `Prover.toml` nargo expects. Decimal strings throughout. */
export function toProverToml(w: BatchWitness): string {
  const dec = (v: unknown): string => `"${(v as bigint).toString()}"`;
  const arr = (v: readonly bigint[]) => `[${v.map(dec).join(", ")}]`;
  const p = w.publicInputs;
  const q = w.private as Record<string, never>;

  const lines: string[] = [
    `circuit_version = ${dec(p.circuitVersion)}`,
    `window_id = ${dec(p.windowId)}`,
    `sub_batch_index = ${dec(p.subBatchIndex)}`,
    `old_root = ${dec(p.oldRoot)}`,
    `orders_root = ${dec(p.ordersRoot)}`,
    `prices_root_pub = ${dec(p.pricesRoot)}`,
    `defer_mask = ${dec(p.deferMask)}`,
    `quote_asset_id = ${dec(p.quoteAssetId)}`,
    `outputs_subtree_root = ${dec(p.outputsSubtreeRoot)}`,
    `receipts_root = ${dec(p.receiptsRoot)}`,
    `tape_leaf = ${dec(p.tapeLeaf)}`,
    `nullifiers = ${arr(p.nullifiers)}`,
    `asset_count = "${w.private.asset_count}"`,
    `priced_at = ${dec(w.private.priced_at)}`,
    `sequencer_ok = ${w.private.sequencer_ok}`,
  ];

  for (const key of [
    "side",
    "quantity",
    "filled",
    "order_salt",
    "active",
    "in_units",
    "pk_x",
    "pk_y",
    "npk",
    "sig_s_lo",
    "sig_s_hi",
    "sig_e_lo",
    "sig_e_hi",
    "nsecret",
    "leaf_index",
    "asset_buy_total",
    "asset_sell_total",
    "asset_matched",
    "buy_is_smaller",
    "prorata_q",
    "prorata_r",
    "max_cost_q",
    "max_cost_r",
    "out_commitment",
    "quote_q",
    "quote_r",
  ] as const) {
    lines.push(`${key} = ${arr(q[key] as unknown as bigint[])}`);
  }

  // Nested arrays are inline; nargo accepts them and it keeps the file readable.
  const nested = (name: string, rows: bigint[][]) =>
    lines.push(`${name} = [${rows.map((r) => arr(r)).join(", ")}]`);
  nested("asset_selector", w.private.asset_selector as bigint[][]);
  nested("path", w.private.path as bigint[][]);

  // Structs go last: TOML tables end the flat section.
  for (const e of w.private.entries as PriceEntry[]) {
    lines.push("");
    lines.push("[[entries]]");
    lines.push(`asset_id = ${dec(e.assetId)}`);
    lines.push(`kind = ${dec(e.kind)}`);
    lines.push(`flags = ${dec(e.flags)}`);
    lines.push(`updated_at = ${dec(e.updatedAt)}`);
    lines.push(`round_id = ${dec(e.roundId)}`);
    lines.push(`ref_value_e18 = ${dec(e.refValueE18)}`);
    lines.push(`ui_multiplier_e18 = ${dec(e.uiMultiplierE18)}`);
  }

  return lines.join("\n") + "\n";
}
