// Three-way parity for the committed price table, against the live deployment.
//
// `PriceCommitter.commitWindow` derives `pricesRoot` on-chain, in Solidity, from its own
// staticcalls to the feeds. `batch_cross` recomputes it in Noir from the witnessed table. This
// recomputes it a third time in TypeScript from the entries the contract stored.
//
// If these disagree, every crossing proof cites a table the contract never committed and no
// batch can ever settle — a failure that would otherwise surface as an unsatisfied constraint
// with nothing to point at.
//
//   bun scripts/price-parity-live.mjs
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rhcTestnet } from "../src/lib/chain/chains.ts";
import { emptyEntry, pricesRoot, packEntry, MAX_ASSETS } from "../src/lib/notes/prices.ts";

const PRICER = "0x478D11836CdFdDD60941Ffe08a02b2C2cc70E824";
const WINDOW = BigInt(process.env.WINDOW_ID ?? Math.floor(Date.now() / 1000));

const abi = [
  { type: "function", name: "commitWindow", stateMutability: "nonpayable",
    inputs: [{ name: "windowId", type: "uint64" }, { name: "assetIds", type: "uint16[]" }],
    outputs: [{ type: "bytes32" }, { type: "uint256" }] },
  { type: "function", name: "window", stateMutability: "view",
    inputs: [{ type: "uint64" }],
    outputs: [{ components: [
      { name: "pricesRoot", type: "bytes32" }, { name: "deferMask", type: "uint256" },
      { name: "committedAt", type: "uint64" }, { name: "assetCount", type: "uint16" },
      { name: "sequencerOk", type: "bool" }], type: "tuple" }] },
  { type: "function", name: "entryOf", stateMutability: "view",
    inputs: [{ type: "uint64" }, { type: "uint16" }],
    outputs: [{ components: [
      { name: "assetId", type: "uint16" }, { name: "kind", type: "uint8" },
      { name: "flags", type: "uint8" }, { name: "updatedAt", type: "uint64" },
      { name: "roundId", type: "uint80" }, { name: "refValueE18", type: "uint128" },
      { name: "uiMultiplierE18", type: "uint128" }], type: "tuple" }] },
  { type: "function", name: "heartbeat", stateMutability: "nonpayable", inputs: [], outputs: [] },
];

const account = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain: rhcTestnet, transport: http() });
const wallet = createWalletClient({ account, chain: rhcTestnet, transport: http() });

const ASSETS = [1, 2, 3];

// The heartbeat shim stands in for a Chainlink sequencer uptime feed, which does not exist for
// this chain. Without a recent ping the committer marks every asset stale, pool-wide.
console.log("pinging the sequencer heartbeat…");
await pub.waitForTransactionReceipt({
  hash: await wallet.writeContract({ address: PRICER, abi, functionName: "heartbeat" }),
});

console.log(`committing window ${WINDOW} over assets ${ASSETS.join(", ")}…`);
const hash = await wallet.writeContract({
  address: PRICER, abi, functionName: "commitWindow", args: [WINDOW, ASSETS],
});
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log("  gas used:", receipt.gasUsed.toString());

const committed = await pub.readContract({ address: PRICER, abi, functionName: "window", args: [WINDOW] });
console.log("\non-chain:");
console.log("  pricesRoot :", committed.pricesRoot);
console.log("  deferMask  :", committed.deferMask.toString());
console.log("  committedAt:", committed.committedAt.toString());
console.log("  sequencerOk:", committed.sequencerOk);
console.log("  assetCount :", committed.assetCount);

// Rebuild the table from what the contract stored, then hash it the circuit's way.
const entries = Array.from({ length: MAX_ASSETS }, emptyEntry);
for (let i = 0; i < ASSETS.length; i++) {
  const e = await pub.readContract({ address: PRICER, abi, functionName: "entryOf", args: [WINDOW, ASSETS[i]] });
  entries[i] = {
    assetId: BigInt(e.assetId), kind: BigInt(e.kind), flags: BigInt(e.flags),
    updatedAt: BigInt(e.updatedAt), roundId: BigInt(e.roundId),
    refValueE18: BigInt(e.refValueE18), uiMultiplierE18: BigInt(e.uiMultiplierE18),
  };
  const [lo, hi] = packEntry(entries[i]);
  console.log(`  asset ${e.assetId}: flags=${e.flags} ref=${e.refValueE18} mult=${e.uiMultiplierE18}`);
  console.log(`            lo=0x${lo.toString(16)} hi=0x${hi.toString(16)}`);
}

const ts = pricesRoot(entries, ASSETS.length, WINDOW, BigInt(committed.committedAt), committed.sequencerOk);

console.log("\ntypescript:");
console.log("  pricesRoot :", "0x" + ts.root.toString(16).padStart(64, "0"));
console.log("  deferMask  :", ts.deferMask.toString());

const rootMatch = BigInt(committed.pricesRoot) === ts.root;
const maskMatch = committed.deferMask === ts.deferMask;
console.log("\n  pricesRoot matches:", rootMatch);
console.log("  deferMask matches :", maskMatch);
process.exit(rootMatch && maskMatch ? 0 : 1);
