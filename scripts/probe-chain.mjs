#!/usr/bin/env node
/**
 * Read-only reconnaissance of Robinhood Chain.
 *
 * Re-runnable answer to week-1 check #1 and its ongoing monitoring form: confirms the token
 * restriction model, the shared control contract's pause/blocklist state, BN254 precompile
 * availability, and gas conditions. Becomes the basis for contracts/script/VerifyLive.s.sol.
 *
 *   node scripts/probe-chain.mjs [--mainnet|--testnet] [--pool 0x...]
 *
 * Exits non-zero if any invariant the venue depends on is violated, so it can run in CI or as a
 * liveness alarm.
 */

const NETWORKS = {
  mainnet: { chainId: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com" },
  testnet: { chainId: 46630, rpc: "https://rpc.testnet.chain.robinhood.com" },
};

// Shared beacon + pause authority + blocklist registry for all Robinhood tokenized assets.
const CONTROL = "0xe10b6f6B275de231345c20D14Ab812db62151b00";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const SEL = {
  paused: "0x5c975abb",
  implementation: "0x5c60da1b",
  isBlocked: "0xfbac3951",
  uiMultiplier: "0xa60bf13d",
  oraclePaused: "0x7706ba52",
  decimals: "0x313ce567",
  balanceOf: "0x70a08231",
};

const args = process.argv.slice(2);
const net = args.includes("--testnet") ? "testnet" : "mainnet";
const { chainId, rpc } = NETWORKS[net];
const poolArg = args.indexOf("--pool");
const POOL = poolArg !== -1 ? args[poolArg + 1] : null;

let id = 0;
async function rpcCall(method, params) {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const ethCall = (to, data) => rpcCall("eth_call", [{ to, data }, "latest"]);
const addrArg = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const isTrue = (hex) => BigInt(hex || "0x0") === 1n;

const problems = [];
const note = (ok, label, detail) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) problems.push(label);
};

async function main() {
  console.log(`\nArcLite chain probe — ${net} (expected chainId ${chainId})\n`);

  const onChainId = parseInt(await rpcCall("eth_chainId", []), 16);
  note(onChainId === chainId, "chainId matches", `got ${onChainId}`);

  const block = await rpcCall("eth_getBlockByNumber", ["latest", false]);
  const baseFeeGwei = parseInt(block.baseFeePerGas ?? "0x0", 16) / 1e9;
  console.log(
    `  --    head block ${parseInt(block.number, 16)}, base fee ${baseFeeGwei.toFixed(6)} gwei`,
  );

  console.log("\nControl contract (beacon + pause authority + blocklist)");
  const paused = isTrue(await ethCall(CONTROL, SEL.paused));
  note(!paused, "global pause is OFF", paused ? "*** ALL TOKENS FROZEN ***" : "");
  const impl = await ethCall(CONTROL, SEL.implementation);
  console.log(`  --    beacon implementation 0x${impl.slice(-40)}`);

  if (POOL) {
    const blocked = isTrue(await ethCall(CONTROL, SEL.isBlocked + addrArg(POOL)));
    note(!blocked, "pool is not blocklisted", blocked ? "*** POOL BLOCKED ***" : POOL);
  }

  console.log("\nBN254 precompiles (required for on-chain Honk verification)");
  const pairing = await ethCall("0x0000000000000000000000000000000000000008", "0x");
  note(isTrue(pairing), "ecPairing 0x08");
  const ecAdd = await ethCall("0x0000000000000000000000000000000000000006", "0x" + "0".repeat(256));
  note(ecAdd.length === 130, "ecAdd 0x06");
  const ecMul = await ethCall("0x0000000000000000000000000000000000000007", "0x" + "0".repeat(192));
  note(ecMul.length === 130, "ecMul 0x07");

  console.log("\nEligible assets — registry ∩ Chainlink feeds");
  const [assetsRes, feedsRes] = await Promise.all([
    fetch("https://api.robinhood.com/rhj/assets").then((r) => r.json()),
    fetch("https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json").then((r) =>
      r.json(),
    ),
  ]);
  const feedSyms = new Set(
    feedsRes
      .filter((f) => f.name?.startsWith("Robinhood "))
      .map((f) => f.name.slice("Robinhood ".length).split(" / ")[0].split("-")[0]),
  );
  const assets = assetsRes.assets.filter((a) => a.deployments?.some((d) => d.chainId === chainId));
  const eligible = assets.filter((a) => feedSyms.has(a.tokenSymbol));
  console.log(
    `  --    ${assets.length} registry assets, ${feedSyms.size} feeds, ${eligible.length} eligible`,
  );
  note(eligible.length > 0, "at least one eligible asset");

  console.log("\nSpot-check: all tokens share one beacon");
  for (const sym of ["NVDA", "AAPL", "SPY"]) {
    const a = eligible.find((x) => x.tokenSymbol === sym);
    if (!a) {
      note(false, `${sym} present in eligible set`);
      continue;
    }
    const addr = a.deployments.find((d) => d.chainId === chainId).contractAddress;
    const slot = await rpcCall("eth_getStorageAt", [addr, BEACON_SLOT, "latest"]);
    const shares = "0x" + slot.slice(-40).toLowerCase() === CONTROL.toLowerCase();
    const mult = BigInt(await ethCall(addr, SEL.uiMultiplier));
    const oPaused = isTrue(await ethCall(addr, SEL.oraclePaused));
    note(
      shares && !oPaused,
      `${sym} beacon shared, oracle live`,
      `mult=${(Number(mult) / 1e18).toFixed(9)}`,
    );
  }

  console.log(
    problems.length
      ? `\n${problems.length} problem(s): ${problems.join(", ")}\n`
      : "\nAll checks passed.\n",
  );
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`\nprobe failed: ${e.message}\n`);
  process.exit(2);
});
