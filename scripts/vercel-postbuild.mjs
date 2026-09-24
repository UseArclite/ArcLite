#!/usr/bin/env node
/**
 * Inject cron and function configuration into the Vercel Build Output.
 *
 * This is the *only* place crons belong. Declaring them in `vercel.json` as well fails the
 * deploy outright — `duplicated_cron_job`, at the patchBuild step, after the build has already
 * succeeded — because Vercel reads both and sees the same path and schedule twice.
 *
 * Nitro's vercel preset writes `.vercel/output/config.json` itself and does not carry over a
 * root `vercel.json`'s `crons` or `functions` keys — and for Build Output API deployments Vercel
 * reads cron definitions from that generated file, not from `vercel.json`. Merging here is the
 * deterministic way to get both, rather than hoping the root file is honoured.
 *
 * Runs as part of the build command. Idempotent.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const OUT = ".vercel/output";
const CONFIG = join(OUT, "config.json");

if (!existsSync(CONFIG)) {
  console.error(`[postbuild] ${CONFIG} not found — did the build run with NITRO_PRESET=vercel?`);
  process.exit(1);
}

// Cron routes are added here as they land. Vercel requires Pro for per-minute schedules;
// on Hobby anything more frequent than daily fails the deployment outright.
const CRONS = [
  // Per-minute schedules require the Vercel Pro plan; on Hobby anything more frequent than
  // daily fails the deployment outright.
  { path: "/api/cron/oracle", schedule: "* * * * *" },
  { path: "/api/cron/tick", schedule: "* * * * *" },
];

// Proving needs the headroom; everything else stays cheap. Measured cost for a 2^19 circuit is
// 12 s / 1.1 GB (docs/week1-check2-proving-cost.md), so 800 s / 3009 MB is generous on purpose.
const FUNCTION_OVERRIDES = {
  maxDuration: 300,
  memory: 2048,
  // Deliberately NOT overriding `runtime`.
  //
  // Nitro labels the function `bun1.x` because the build runs under Bun, and `Barretenberg.new`
  // never returns under Bun — so pinning `nodejs22.x` looked like the fix. It is not: Nitro
  // emits a Bun-targeted entrypoint, and the deployment answered every request with a 500. The
  // whole site was down until it was reverted.
  //
  // Changing the runtime means changing what the build targets, not relabelling its output.
};

const config = JSON.parse(readFileSync(CONFIG, "utf8"));

if (CRONS.length > 0) {
  config.crons = CRONS;
  console.log(`[postbuild] injected ${CRONS.length} cron(s)`);
} else {
  console.log("[postbuild] no crons defined yet");
}

const fnDir = join(OUT, "functions");
const funcs = existsSync(fnDir) ? readdirSync(fnDir).filter((f) => f.endsWith(".func")) : [];
for (const fn of funcs) {
  const vc = join(fnDir, fn, ".vc-config.json");
  if (!existsSync(vc)) continue;
  const cfg = JSON.parse(readFileSync(vc, "utf8"));
  Object.assign(cfg, FUNCTION_OVERRIDES);
  writeFileSync(vc, JSON.stringify(cfg, null, 2));
  console.log(
    `[postbuild] ${fn}: maxDuration=${cfg.maxDuration}s memory=${cfg.memory}MB runtime=${cfg.runtime}`,
  );
}

writeFileSync(CONFIG, JSON.stringify(config, null, 2));
console.log(`[postbuild] ok — ${funcs.length} function(s) configured`);

// The compiled circuit, into every function bundle.
//
// Nitro traces imports, not `readFileSync` paths, so the prover's artifact is invisible to the
// bundler and never ships. It is committed under `circuits/artifacts/` for exactly this reason;
// copying it here is what puts it where the function can read it.
const ARTIFACT_DIR = "circuits/artifacts";
if (existsSync(ARTIFACT_DIR)) {
  const artifacts = readdirSync(ARTIFACT_DIR).filter((f) => f.endsWith(".json"));
  // And every subdirectory: `crs/` is the structured reference string, `bb/` is barretenberg's
  // WASM. bb.js resolves both relative to where its own module ended up, which the bundler
  // decides — it inlines bb.js into `_libs/`, where neither path exists. The prover points at
  // these copies explicitly, so the arrangement of the bundle stops mattering.
  const dirs = readdirSync(ARTIFACT_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  let copied = 0;
  for (const fn of funcs) {
    const dest = join(fnDir, fn, ARTIFACT_DIR);
    mkdirSync(dest, { recursive: true });
    for (const a of artifacts) copyFileSync(join(ARTIFACT_DIR, a), join(dest, a));
    for (const dir of dirs) {
      mkdirSync(join(dest, dir), { recursive: true });
      for (const f of readdirSync(join(ARTIFACT_DIR, dir))) {
        copyFileSync(join(ARTIFACT_DIR, dir, f), join(dest, dir, f));
        copied += 1;
      }
    }
  }
  console.log(
    `[postbuild] copied ${artifacts.length} circuit artifact(s) and ${copied} support file(s) ` +
      `into ${funcs.length} function(s)`,
  );
} else {
  console.warn(`[postbuild] ${ARTIFACT_DIR} is missing — settlement will not be able to prove`);
}

// Noir's WASM, next to whichever chunk ended up referencing it.
//
// `@noir-lang/acvm_js`'s node build reads `${__dirname}/acvm_js_bg.wasm`. That is correct while
// the module sits in `node_modules`; after bundling, `__dirname` is whatever directory the
// chunk landed in. The file is not copied there, so the first `Noir.execute` throws ENOENT —
// on the settlement path, where it reads as a window that failed rather than a deployment that
// cannot execute a witness at all.
//
// Rather than predict the layout, this finds the chunks that name each file and copies it beside
// each one. The bundler is free to rearrange; the file follows.
const NOIR_WASM = [
  ["acvm_js_bg.wasm", "node_modules/@noir-lang/acvm_js/nodejs/acvm_js_bg.wasm"],
  ["noirc_abi_wasm_bg.wasm", "node_modules/@noir-lang/noirc_abi/nodejs/noirc_abi_wasm_bg.wasm"],
];

function chunksMentioning(dir, needle, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) chunksMentioning(path, needle, found);
    else if (/\.(mjs|js|cjs)$/.test(entry.name) && readFileSync(path, "utf8").includes(needle)) {
      found.push(dir);
    }
  }
  return found;
}

for (const fn of funcs) {
  for (const [name, source] of NOIR_WASM) {
    if (!existsSync(source)) {
      console.warn(`[postbuild] ${source} is missing — witness execution will fail`);
      continue;
    }
    const dirs = [...new Set(chunksMentioning(join(fnDir, fn), name))];
    for (const dir of dirs) copyFileSync(source, join(dir, name));
    console.log(`[postbuild] ${fn}: placed ${name} in ${dirs.length} director(ies)`);
  }
}
