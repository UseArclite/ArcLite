/**
 * Proving a withdrawal in the browser.
 *
 * This is the piece that makes "your funds are yours" a property rather than a promise.
 * `RwaDarkPool.unshield` carries no pause, no role and no window check, and anyone holding a
 * valid proof can call it — so a holder who can generate this proof can leave while the venue is
 * paused, the asset is delisted, and the operator is hostile or simply gone. A server-side
 * prover would undo all of that: the witness contains the note's secrets, so a server that could
 * prove your withdrawal could also spend your note.
 *
 * `unshield` is deliberately tiny — about 2^14 — for exactly this reason. It costs a couple of
 * seconds on a laptop, where `batch_cross` at 2^17 would not be reasonable to ask of a browser.
 *
 * ## Loaded on demand
 *
 * Barretenberg is tens of megabytes of WebAssembly. Importing it at module scope would make
 * every visitor download a prover to look at a chart, and would slow the vault's unlock — which
 * happens on every page load — for a path most sessions never take. The dynamic import here
 * keeps it out of the worker's bundle until somebody actually withdraws.
 *
 * ## Single-threaded, deliberately
 *
 * Multi-threaded proving needs `SharedArrayBuffer`, which needs cross-origin isolation, which
 * means COOP/COEP headers that break third-party embeds across the rest of the site. For a 2^14
 * circuit the trade is not close: one thread is a few seconds, and the alternative is a header
 * policy the whole application has to live under.
 */

/** Where the compiled circuit is served from. Slimmed to ABI and bytecode: ~5 KB, not 88. */
const CIRCUIT_URL = "/circuits/unshield.json";

let cached: Promise<{
  execute: (inputs: Record<string, unknown>) => Promise<Uint8Array>;
  prove: (witness: Uint8Array) => Promise<{ proof: Uint8Array; publicInputs: string[] }>;
}> | null = null;

async function backend() {
  cached ??= (async () => {
    const [{ Noir }, bb, circuit] = await Promise.all([
      import("@noir-lang/noir_js"),
      import("@aztec/bb.js"),
      fetch(CIRCUIT_URL).then((r) => {
        if (!r.ok) throw new Error(`the withdrawal circuit is not published at ${CIRCUIT_URL}`);
        return r.json() as Promise<{ bytecode: string }>;
      }),
    ]);

    const noir = new Noir(circuit as never);
    const api = await bb.Barretenberg.new({
      backend: bb.BackendType.Wasm,
      threads: 1,
      // 2^17, not the 2^14 the circuit needs.
      //
      // The browser loads a *compressed* reference string at 32 bytes a point, and its loader
      // requires the buffer to be a whole number of 4 MiB chunks — 2^17 points. Asking for
      // exactly what `unshield` needs produced a 512 KiB buffer and
      // `SrsInitSrs: compressed points_buf size 524288 must be a positive multiple of 4194304`,
      // a message that names neither the circuit nor the option that caused it.
      //
      // So the floor is 4 MiB over the wire, once, cached by the browser thereafter. The node
      // path has no such constraint and still asks for exactly what it needs.
      srsSize: 1 << 17,
    });
    const honk = new bb.UltraHonkBackend(circuit.bytecode, api);

    return {
      execute: async (inputs: Record<string, unknown>) =>
        (await noir.execute(inputs as never)).witness,
      // `verifierTarget: "evm"` — the ZK target the deployed verifier was generated from. The
      // deprecated `keccak: true` means `evm-no-zk`, which produces a proof of a different
      // length that verifies perfectly here and is rejected on chain.
      prove: async (witness: Uint8Array) => honk.generateProof(witness, { verifierTarget: "evm" }),
    };
  })();
  return cached;
}

/** Prove a withdrawal. Returns the proof bytes as hex, ready for `RwaDarkPool.unshield`. */
export async function proveUnshield(
  inputs: Record<string, unknown>,
): Promise<{ proof: string; publicInputs: string[] }> {
  const { execute, prove } = await backend();
  const witness = await execute(inputs);
  const { proof, publicInputs } = await prove(witness);
  return {
    proof: `0x${[...proof].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    publicInputs,
  };
}
