import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Barretenberg, BackendType, UltraHonkBackend } from "@aztec/bb.js";
import { Noir } from "@noir-lang/noir_js";
import type { BatchWitness } from "@/server/witness";

/**
 * Proving `batch_cross` in-process.
 *
 * ## It works, and it is fast — but only under Node
 *
 * Measured on the committed witness:
 *
 * | | native `bb` | `bb.js` under Node | `bb.js` under Bun |
 * |---|---|---|---|
 * | backend init | — | **0.1 s** | never returned |
 * | proving | 0.77 s | **1.10 s** | — |
 * | peak RSS | 146 MB | **342 MB** | 177 MB and climbing |
 *
 * Under **Bun**, `Barretenberg.new` pegs one core at 100% and does not return — over five minutes
 * for a circuit native `bb` proves in under one second, with no log output at all. bb.js leans on
 * Node's `worker_threads` and WASM plumbing, and Bun's compatibility there is evidently not
 * sufficient.
 *
 * That matters in a specific and slightly awkward way: **Vercel functions run Node, so production
 * is fine — but `bun run dev` cannot prove.** Rather than hang a local tick forever, this module
 * refuses to start under Bun and says why. A developer seeing "proving is unavailable under Bun"
 * has something to act on; a developer watching a tick never return does not.
 *
 * ## Budget
 *
 * 1.10 s and 342 MB sits far inside Vercel's 800 s and 4 GB, and nowhere near the wasm32 4 GiB
 * address ceiling that forced the 16-order sub-batch cap. The shippable part of `@aztec/bb.js` is
 * `dest/` at ~21 MB; the 132 MB `build/` directory is native binaries a WASM deployment does not
 * need and must be excluded from the bundle, or the 250 MB function limit is gone on its own.
 */

export class ProverUnavailable extends Error {}

/** Node-only. Returns the reason if proving cannot run here, or null if it can. */
/**
 * Where the compiled circuit is, wherever this is running.
 *
 * `circuits/target/` is build output and gitignored, so nothing under it reaches a deployment —
 * the prover would have thrown ENOENT on every settlement, and `settleMatchedWindows` catches
 * per-window errors, so it would have read as a window that failed rather than a venue that
 * cannot prove at all. The compiled artifact is committed under `circuits/artifacts/` and the
 * postbuild copies it into each function bundle; `circuits/target/` stays as the local
 * fallback, so a freshly recompiled circuit is picked up without a copy step.
 *
 * Ordered most-specific first, and the failure names every path it looked in. A missing artifact
 * is a deployment mistake, and the error should say so rather than naming one path that was
 * never going to exist.
 */
const CIRCUIT_SEARCH_PATHS = [
  "circuits/artifacts/batch_cross.json",
  "circuits/target/batch_cross.json",
];

/**
 * The structured reference string, shipped rather than downloaded.
 *
 * bb.js fetches the SRS from `crs.aztec-cdn.foundation` into `~/.bb-crs` on first use. In a
 * Vercel function that is an outbound request on the settlement path, into a home directory that
 * may not be writable — and when it fails, Node reports `fetch failed` and nothing else, so the
 * venue looks like it cannot reach the chain rather than the prover's CDN.
 *
 * `batch_cross` pads to 2^17, which needs 2^17 x 64 = 8 MiB of G1 points and 128 bytes of G2.
 * The full SRS is 196 MB; a prefix is all `Crs` reads, and it checks the file is *at least* the
 * size it needs. So the prefix ships, the settlement path makes no network call it does not have
 * to, and a cold start does not pay for 8 MB over the wire.
 *
 * Set only when the directory exists, so a local checkout with a populated `~/.bb-crs` keeps
 * using it and a larger circuit is not silently proved against a too-small SRS.
 */
function bundledSrsPath(): string | undefined {
  if (process.env.CRS_PATH) return process.env.CRS_PATH;
  return ["circuits/artifacts/crs", "circuits/target/crs"].find((dir) =>
    existsSync(`${dir}/bn254_g1.dat`),
  );
}

/**
 * Where barretenberg's WASM is, told rather than inferred.
 *
 * bb.js locates it as `dirname(import.meta.url) + "/../../barretenberg-threads.wasm.gz"`, which
 * is correct only while the module sits in `node_modules`. Nitro inlines it into
 * `_libs/@aztec/bb.js+[...].mjs`, and from there that path does not exist — the failure reached
 * the logs as "fetch failed" with the cause "not implemented... yet...", undici refusing a
 * `file:` URL, naming neither WASM nor bb.js. Every settlement failed this way and it read like
 * the venue could not reach the chain.
 *
 * `BackendOptions.wasmPath` is the **file**, not the directory holding it — `fetchCode` uses it
 * as `wasmPath ?? getCurrentDir() + "/../../barretenberg-threads.wasm.gz"` and reads it
 * directly. Passing the directory reads a directory: `EISDIR: illegal operation on a directory`,
 * which says nothing about WASM either. The doc comment on the option ("Path to download WASM
 * files", plural) reads like a directory, so this is worth stating rather than inferring twice.
 *
 * Telling bb.js where its file is, is proof against however the bundler arranges the output.
 * Trying to configure the bundler is not: two attempts at that took the site down.
 */
function bundledWasmPath(): string | undefined {
  if (process.env.ARCLITE_BB_WASM_PATH) return process.env.ARCLITE_BB_WASM_PATH;
  return [
    "circuits/artifacts/bb/barretenberg-threads.wasm.gz",
    "node_modules/@aztec/bb.js/dest/node/barretenberg_wasm/barretenberg-threads.wasm.gz",
  ].find((file) => existsSync(file));
}

export function resolveCircuitPath(name = "batch_cross"): string {
  const candidates = [
    process.env.ARCLITE_CIRCUIT_PATH,
    ...CIRCUIT_SEARCH_PATHS.map((p) => p.replace("batch_cross", name)),
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `compiled circuit ${name} not found — looked in ${candidates.join(", ")} from ${process.cwd()}`,
    );
  }
  return found;
}

/**
 * Let `fetch` read a `file:` URL, because Noir's WASM loader uses one.
 *
 * `@noir-lang/acvm_js` publishes `main: ./nodejs/…`, which reads its WASM off disk, and
 * `module: ./web/…`, which does `fetch(new URL('acvm_js_bg.wasm', import.meta.url))`. Vite's SSR
 * build prefers `module`, so the server gets the web loader — and under Node that URL is a
 * `file:` one, which undici refuses with "not implemented... yet...", surfacing as a bare
 * "fetch failed". Every settlement died there, before proving was even reached.
 *
 * Two other fixes were tried and both took the site down, because each fought the bundler
 * instead of the problem. Aliasing to the node build put CommonJS that uses `__dirname` into an
 * ESM chunk, so the module threw on load and *every* route 500d. Pinning the function to
 * `nodejs22.x` relabelled an entrypoint Nitro had built for Bun, with the same result.
 *
 * This asks the bundler for nothing. It adds handling for a scheme `fetch` currently refuses and
 * passes everything else through untouched, so nothing that works today changes. The file has to
 * exist where `import.meta.url` resolves, which is next to the chunk — `vercel-postbuild.mjs`
 * puts it there.
 */
function allowFileUrlFetch(): void {
  const original = globalThis.fetch as typeof fetch & { arcliteFileAware?: boolean };
  if (original.arcliteFileAware) return;

  const patched = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (!url?.startsWith("file:")) return original(input, init);
    // Content type matters: `WebAssembly.instantiateStreaming` refuses anything that is not
    // `application/wasm`, and falls back to a plain `arrayBuffer()` only if it is absent.
    return new Response(readFileSync(fileURLToPath(url)), {
      status: 200,
      headers: { "content-type": "application/wasm" },
    });
  }) as typeof fetch & { arcliteFileAware?: boolean };
  patched.arcliteFileAware = true;
  globalThis.fetch = patched;
}

export function proverUnavailableReason(): string | null {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    return "proving is unavailable under Bun: Barretenberg.new does not return. Vercel runs Node, so this affects local development only.";
  }
  return null;
}

export interface ProofResult {
  /** The proof bytes, as the Solidity verifier expects them. */
  proof: Uint8Array;
  /** Public inputs, hex, in the circuit's order. */
  publicInputs: string[];
  provingMs: number;
}

let cached: {
  api: Awaited<ReturnType<typeof Barretenberg.new>>;
  backend: UltraHonkBackend;
} | null = null;

/**
 * Hold one backend across invocations.
 *
 * A warm serverless instance reuses this, so only the first proof of an instance's life pays the
 * initialisation. It is cheap here (0.1 s) but the SRS allocation is not free, and re-doing it
 * per proof would triple the cost of a window that proves several sub-batches.
 */
async function backendFor(circuitPath: string): Promise<UltraHonkBackend> {
  if (cached) return cached.backend;

  const reason = proverUnavailableReason();
  if (reason) throw new ProverUnavailable(reason);

  allowFileUrlFetch();
  const circuit = JSON.parse(readFileSync(circuitPath, "utf8")) as { bytecode: string };
  const api = await Barretenberg.new({
    backend: BackendType.Wasm,
    // Single-threaded, deliberately.
    //
    // bb.js spawns worker threads by resolving `thread.worker.js` relative to its own module —
    // which after bundling is `_libs/@aztec/`, where the file does not exist. The failure is an
    // *uncaught exception* on the worker, so it kills the whole invocation rather than rejecting
    // the promise: the tick recorded nothing at all, no error and no run, for six minutes. It
    // read as a cron that had stopped firing.
    //
    // Copying the worker across would not help for long — it requires bb.js internals that the
    // bundler has also moved. One thread spawns none. The cost is real but small: 2^17 gates
    // prove in about five seconds on two threads, and a `maxDuration` of 300 has room for
    // several times that. `ARCLITE_PROVER_THREADS` raises it where the layout allows.
    threads: Number(process.env.ARCLITE_PROVER_THREADS ?? 1),
    // Sized to the circuit: batch_cross is 68,729 gates and pads to 2^17. Leaving this unset
    // makes bb.js pick, and a larger SRS costs memory for nothing.
    srsSize: 1 << 17,
    // Both told explicitly. Left to bb.js they are resolved relative to where its own module
    // ended up, which the bundler decides.
    crsPath: bundledSrsPath(),
    wasmPath: bundledWasmPath(),
  });
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  cached = { api, backend };
  return backend;
}

/**
 * Prove a witness produced by `nargo execute`.
 *
 * `verifierTarget: "evm"` and not `keccak: true`.
 *
 * They are not the same thing. `keccak` is deprecated for `verifierTarget: "evm-no-zk"` — the
 * **non-ZK** variant — while the deployed verifier is generated by
 * `bb write_solidity_verifier` from a vk written with `--verifier_target evm`, which is the ZK
 * one. The proofs differ in length: 8128 bytes against 9152. The chain said so precisely,
 * `ProofLengthWrongWithLogN(17, …)`, and the proof verified perfectly well natively first —
 * which is the expensive way to find a flag, exactly as the old comment here warned, while the
 * flag it recommended was the wrong one.
 */
export async function proveBatch(
  witnessGz: Uint8Array,
  circuitPath = resolveCircuitPath(),
): Promise<ProofResult> {
  const backend = await backendFor(circuitPath);
  const started = Date.now();
  const proof = await backend.generateProof(witnessGz, { verifierTarget: "evm" });
  return {
    proof: proof.proof,
    publicInputs: proof.publicInputs,
    provingMs: Date.now() - started,
  };
}

/** Verify locally before spending gas. A rejected proof costs a simulation, not a settlement. */
export async function verifyBatch(
  proof: { proof: Uint8Array; publicInputs: string[] },
  circuitPath = resolveCircuitPath(),
): Promise<boolean> {
  const backend = await backendFor(circuitPath);
  return backend.verifyProof(proof as never, { verifierTarget: "evm" });
}

/**
 * Turn a `BatchWitness` into the input object `Noir.execute` expects.
 *
 * Every numeric value crosses as a **decimal string**. The Noir ABI accepts numbers for small
 * types, but a `Field` is 254 bits and a JavaScript number is a double — a witness value that
 * silently rounded would produce a proof of a statement nobody made, and it would verify.
 */
export function toNoirInputs(w: BatchWitness): Record<string, unknown> {
  const dec = (v: unknown) => (v as bigint).toString();
  const p = w.publicInputs;
  const q = w.private as Record<string, unknown>;

  const entries = (q.entries as Record<string, bigint>[]).map((e) => ({
    asset_id: dec(e.assetId),
    kind: dec(e.kind),
    flags: dec(e.flags),
    updated_at: dec(e.updatedAt),
    round_id: dec(e.roundId),
    ref_value_e18: dec(e.refValueE18),
    ui_multiplier_e18: dec(e.uiMultiplierE18),
  }));

  return {
    circuit_version: dec(p.circuitVersion),
    window_id: dec(p.windowId),
    sub_batch_index: dec(p.subBatchIndex),
    old_root: dec(p.oldRoot),
    orders_root: dec(p.ordersRoot),
    prices_root_pub: dec(p.pricesRoot),
    defer_mask: dec(p.deferMask),
    quote_asset_id: dec(p.quoteAssetId),
    outputs_subtree_root: dec(p.outputsSubtreeRoot),
    receipts_root: dec(p.receiptsRoot),
    tape_leaf: dec(p.tapeLeaf),
    nullifiers: p.nullifiers.map(dec),
    entries,
    // u32, not Field: the ABI wants a number here and rejects a decimal string.
    asset_count: q.asset_count as number,
    priced_at: dec(q.priced_at),
    sequencer_ok: q.sequencer_ok as boolean,
    asset_selector: (q.asset_selector as bigint[][]).map((row) => row.map(dec)),
    side: (q.side as bigint[]).map(dec),
    quantity: (q.quantity as bigint[]).map(dec),
    filled: (q.filled as bigint[]).map(dec),
    order_salt: (q.order_salt as bigint[]).map(dec),
    active: (q.active as bigint[]).map(dec),
    in_units: (q.in_units as bigint[]).map(dec),
    pk_x: (q.pk_x as bigint[]).map(dec),
    pk_y: (q.pk_y as bigint[]).map(dec),
    npk: (q.npk as bigint[]).map(dec),
    sig_s_lo: (q.sig_s_lo as bigint[]).map(dec),
    sig_s_hi: (q.sig_s_hi as bigint[]).map(dec),
    sig_e_lo: (q.sig_e_lo as bigint[]).map(dec),
    sig_e_hi: (q.sig_e_hi as bigint[]).map(dec),
    nsecret: (q.nsecret as bigint[]).map(dec),
    leaf_index: (q.leaf_index as bigint[]).map(dec),
    path: (q.path as bigint[][]).map((row) => row.map(dec)),
    asset_buy_total: (q.asset_buy_total as bigint[]).map(dec),
    asset_sell_total: (q.asset_sell_total as bigint[]).map(dec),
    asset_matched: (q.asset_matched as bigint[]).map(dec),
    buy_is_smaller: (q.buy_is_smaller as bigint[]).map(dec),
    prorata_q: (q.prorata_q as bigint[]).map(dec),
    prorata_r: (q.prorata_r as bigint[]).map(dec),
    max_cost_q: (q.max_cost_q as bigint[]).map(dec),
    max_cost_r: (q.max_cost_r as bigint[]).map(dec),
    out_commitment: (q.out_commitment as bigint[]).map(dec),
    quote_q: (q.quote_q as bigint[]).map(dec),
    quote_r: (q.quote_r as bigint[]).map(dec),
  };
}

let noir: Noir | null = null;

/**
 * Execute the circuit to produce a witness, with no `nargo` anywhere.
 *
 * This is what makes proving possible in a serverless function at all: `nargo` is a Rust binary
 * that will not be on a Vercel instance, so the witness has to be solved in JS from the compiled
 * ACIR. A failure here is the circuit rejecting the inputs — an unsatisfied constraint — which is
 * the same signal `nargo execute` gives and is usually a matcher or witness-builder bug rather
 * than a proving one.
 */
export async function executeWitness(
  inputs: Record<string, unknown>,
  circuitPath = resolveCircuitPath(),
): Promise<Uint8Array> {
  const reason = proverUnavailableReason();
  if (reason) throw new ProverUnavailable(reason);

  allowFileUrlFetch();
  noir ??= new Noir(JSON.parse(readFileSync(circuitPath, "utf8")));
  const { witness } = await noir.execute(inputs as never);
  return witness;
}

export async function shutdownProver(): Promise<void> {
  await cached?.api.destroy();
  cached = null;
}
