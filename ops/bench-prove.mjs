#!/usr/bin/env node
/**
 * Week-1 check #2 — UltraHonk WASM proving cost for a 2^19 circuit.
 *
 * plan.md sizes `batch_cross` at ~299k gates padding to 2^19, and caps it at 16 orders because
 * a wasm32 prover cannot address more than 4 GiB however much memory the function is given.
 * That cap, the sub-batch count and the window length all rest on this measurement.
 *
 * Forces BackendType.Wasm* on purpose: bb.js will otherwise pick a native NAPI/binary backend
 * when one is present, which is not what runs on Vercel and would give a flattering number.
 *
 *   node bench-prove.mjs [threads] [Wasm|WasmWorker]
 */
import { Barretenberg, BackendType, UltraHonkBackend } from "@aztec/bb.js";
import { readFileSync } from "node:fs";

const threads = Number(process.argv[2] ?? 2);
const backendType = process.argv[3] ?? BackendType.WasmWorker;
const CIRCUIT = process.env.CIRCUIT ?? "../circuits/target/sizing.json";
const WITNESS = process.env.WITNESS ?? "../circuits/target/witness.gz"; // bb.js wants the COMPRESSED witness

const secs = (a, b) => ((b - a) / 1000).toFixed(2);
let peak = 0;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 100);

const circuit = JSON.parse(readFileSync(CIRCUIT, "utf8"));
const witness = new Uint8Array(readFileSync(WITNESS));

console.log(`\nUltraHonk proving benchmark`);
console.log(
  `  backend:  ${backendType}   threads: ${threads}   srsSize: ${process.env.SRS_SIZE ?? "default"}`,
);

const t0 = Date.now();
// srsSize must cover the circuit: the CRS is sized in G1 points and bb throws
// "trying to get too many points in MemBn254CrsFactory" if it is short. It is downloaded once
// and cached under ~/.bb-crs, so a bigger circuit means a bigger cold-start download.
const srsSize = Number(process.env.SRS_SIZE ?? 0) || undefined;
const api = await Barretenberg.new({ threads, backend: backendType, srsSize });
const t1 = Date.now();

const backend = new UltraHonkBackend(circuit.bytecode, api);
// verifierTarget 'evm' = keccak transcript + ZK: the on-chain-verifiable configuration.
const proof = await backend.generateProof(witness, { verifierTarget: "evm" });
const t2 = Date.now();

const vk = await backend.getVerificationKey({ verifierTarget: "evm" });
const t3 = Date.now();

const ok = await backend.verifyProof(proof, { verifierTarget: "evm" });
const t4 = Date.now();

clearInterval(sampler);
const proveS = (t2 - t1) / 1000;
const peakMB = peak / 1024 / 1024;

console.log(`\n  api init:        ${secs(t0, t1)} s`);
console.log(`  generateProof:   ${secs(t1, t2)} s   <-- the number that matters`);
console.log(`  getVerificationKey: ${secs(t2, t3)} s`);
console.log(`  verifyProof:     ${secs(t3, t4)} s   (verified: ${ok})`);
console.log(`  total:           ${secs(t0, t4)} s`);
console.log(`\n  proof bytes:     ${proof.proof.length}`);
console.log(`  public inputs:   ${proof.publicInputs.length}`);
console.log(`  vk bytes:        ${vk.length}`);
console.log(`  peak RSS:        ${peakMB.toFixed(0)} MB`);
console.log(`\n  vs Vercel limits (800 s, 4 GB, wasm32 4 GiB wall):`);
console.log(`    time headroom:   ${(800 / proveS).toFixed(0)}x`);
console.log(`    memory headroom: ${(4096 / peakMB).toFixed(1)}x\n`);

await api.destroy();
process.exit(ok ? 0 : 1);
