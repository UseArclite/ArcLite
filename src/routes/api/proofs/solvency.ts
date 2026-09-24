import { createFileRoute } from "@tanstack/react-router";
import { createPublicClient, http, type Address } from "viem";
import { ARCLITE, CHAINS, resolveChainId } from "@/lib/chain/chains";

/**
 * The pool's accountability record: solvency, and the delayed tape.
 *
 * ## Why this is a check and not a proof, and why that is not a downgrade
 *
 * `plan.md`'s cut list replaces the `epoch_solvency` circuit with the on-chain invariant, and
 * the reasoning holds: crossing moves **zero** ERC-20s, so `totalUnits` changes only on shield
 * and unshield. Solvency therefore reduces to `balanceOf(pool) >= totalUnits[asset]`, which
 * anyone can evaluate themselves against the chain — no trusted setup, no prover, no verifier,
 * and nothing to take on faith. A ZK proof of the same statement would be a revaluation and
 * disclosure artifact on top, not the thing securing the funds.
 *
 * So this endpoint says "verified on-chain" rather than "proven", because that is what it is.
 * The dashboard repeats that wording instead of implying a proof system is running where one is
 * not.
 *
 * Everything here is a plain `eth_call` against public state. It is offered as a convenience,
 * not as an authority: the whole point is that a reader can reproduce it without us.
 */

const registryAbi = [
  {
    type: "function",
    name: "registeredCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "assetIdAt",
    stateMutability: "view",
    inputs: [{ type: "uint256" }],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "asset",
    stateMutability: "view",
    inputs: [{ type: "uint16" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "feed", type: "address" },
          { name: "navOracle", type: "address" },
          { name: "kind", type: "uint8" },
          { name: "status", type: "uint8" },
          { name: "decimals", type: "uint8" },
          { name: "distributing", type: "bool" },
          { name: "maxStalenessSec", type: "uint32" },
          { name: "maxNavAgeSec", type: "uint32" },
          { name: "assetId", type: "uint16" },
        ],
      },
    ],
  },
] as const;

const poolAbi = [
  {
    type: "function",
    name: "isSolvent",
    stateMutability: "view",
    inputs: [{ type: "uint16" }],
    outputs: [{ type: "bool" }, { type: "uint256" }, { type: "uint256" }],
  },
  {
    type: "function",
    name: "currentRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "nextLeafIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "openWindowId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
] as const;

const tokenAbi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export const Route = createFileRoute("/api/proofs/solvency")({
  server: {
    handlers: {
      GET: async () => {
        const chainId = resolveChainId();
        const deployed = ARCLITE[chainId];

        if (!deployed.pool || !deployed.eligibleRegistry) {
          return Response.json(
            { chainId, deployed: false, reason: "the pool is not deployed on this network yet" },
            { headers: { "cache-control": "no-store" } },
          );
        }

        try {
          const client = createPublicClient({ chain: CHAINS[chainId], transport: http() });
          const pool = deployed.pool as Address;
          const registry = deployed.eligibleRegistry as Address;

          const [root, leafCount, openWindow, paused, registeredCount] = await Promise.all([
            client.readContract({ address: pool, abi: poolAbi, functionName: "currentRoot" }),
            client.readContract({ address: pool, abi: poolAbi, functionName: "nextLeafIndex" }),
            client.readContract({ address: pool, abi: poolAbi, functionName: "openWindowId" }),
            client.readContract({ address: pool, abi: poolAbi, functionName: "paused" }),
            client.readContract({
              address: registry,
              abi: registryAbi,
              functionName: "registeredCount",
            }),
          ]);

          const assets = await Promise.all(
            Array.from({ length: Number(registeredCount) }, async (_, i) => {
              const assetId = await client.readContract({
                address: registry,
                abi: registryAbi,
                functionName: "assetIdAt",
                args: [BigInt(i)],
              });
              const [entry, solvency] = await Promise.all([
                client.readContract({
                  address: registry,
                  abi: registryAbi,
                  functionName: "asset",
                  args: [assetId],
                }),
                client.readContract({
                  address: pool,
                  abi: poolAbi,
                  functionName: "isSolvent",
                  args: [assetId],
                }),
              ]);
              const symbol = await client
                .readContract({ address: entry.token, abi: tokenAbi, functionName: "symbol" })
                .catch(() => `asset ${assetId}`);
              const [solvent, owed, held] = solvency;
              return {
                assetId,
                symbol,
                token: entry.token,
                // So a reader sees 2.00 USDG rather than 2000000. The raw value is still what
                // the check is made against; this only says where the point goes.
                decimals: entry.decimals,
                // Strings, not numbers: raw units are uint256 and JSON numbers are doubles.
                // A balance that silently rounds is worse than no balance at all.
                owed: owed.toString(),
                held: held.toString(),
                solvent,
                surplus: (held - owed).toString(),
              };
            }),
          );

          return Response.json(
            {
              chainId,
              deployed: true,
              pool,
              // The honest label. This is a check anyone can repeat, not a proof we produced.
              method: "on-chain invariant: balanceOf(pool) >= totalUnits(asset)",
              why: "Crossing moves no tokens, so totalUnits changes only on shield and unshield. Solvency is therefore checkable directly against the chain, with nothing to take on faith.",
              solvent: assets.every((a) => a.solvent),
              assets,
              tree: { root, leafCount: Number(leafCount) },
              openWindowId: openWindow.toString(),
              paused,
              tapeRegistry: deployed.tapeRegistry ?? null,
              checkedAt: new Date().toISOString(),
            },
            { headers: { "cache-control": "public, s-maxage=10, stale-while-revalidate=30" } },
          );
        } catch (error) {
          return Response.json(
            { chainId, deployed: true, error: (error as Error).message },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
