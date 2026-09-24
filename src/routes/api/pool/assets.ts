import { createFileRoute } from "@tanstack/react-router";
import { createPublicClient, http, type Address } from "viem";
import { ARCLITE, CHAINS, resolveChainId } from "@/lib/chain/chains";

/**
 * What the pool will actually accept, read from `EligibleRegistry` on whichever chain is
 * configured.
 *
 * The dashboard used a hardcoded map of testnet token addresses, which is exactly the kind of
 * thing that survives a network switch and points a mainnet deposit at a testnet stand-in. The
 * registry is the only authority on which `assetId` corresponds to which token — it is what
 * `shield` reads to decide what to transfer — so asking it removes the question rather than
 * answering it twice.
 *
 * Distinct from `/api/market/assets`, which describes what is *tradable* and comes from
 * Robinhood's registry and Chainlink. This describes what is *depositable*, and comes from our
 * own contract. On testnet the two differ by construction: the quote asset is registered here so
 * the pool can account for it, and deliberately absent there because a window may not price the
 * asset it also pays out in.
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

const erc20Abi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;

export const Route = createFileRoute("/api/pool/assets")({
  server: {
    handlers: {
      GET: async () => {
        const chainId = resolveChainId();
        const deployed = ARCLITE[chainId];

        if (!deployed.eligibleRegistry) {
          return Response.json(
            { chainId, deployed: false, reason: "no registry on this network", assets: [] },
            { headers: { "cache-control": "no-store" } },
          );
        }

        try {
          const client = createPublicClient({ chain: CHAINS[chainId], transport: http() });
          const registry = deployed.eligibleRegistry as Address;

          const count = await client.readContract({
            address: registry,
            abi: registryAbi,
            functionName: "registeredCount",
          });

          const ids = await Promise.all(
            Array.from({ length: Number(count) }, (_, i) =>
              client.readContract({
                address: registry,
                abi: registryAbi,
                functionName: "assetIdAt",
                args: [BigInt(i)],
              }),
            ),
          );

          const assets = await Promise.all(
            ids.map(async (assetId) => {
              const a = await client.readContract({
                address: registry,
                abi: registryAbi,
                functionName: "asset",
                args: [assetId],
              });
              // The symbol is for the dropdown only, so a token that does not answer is listed
              // by id rather than dropped — being unable to name it is not a reason to make it
              // undepositable.
              const symbol = await client
                .readContract({ address: a.token, abi: erc20Abi, functionName: "symbol" })
                .catch(() => `asset ${assetId}`);
              return {
                assetId,
                token: a.token,
                symbol,
                decimals: a.decimals,
                kind: a.kind,
                status: a.status,
                isQuote: assetId === deployed.quoteAssetId,
              };
            }),
          );

          return Response.json(
            { chainId, deployed: true, registry, assets },
            // The registry changes on the order of days; a deposit reads it once per page.
            { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=300" } },
          );
        } catch (error) {
          return Response.json(
            { chainId, deployed: true, error: (error as Error).message, assets: [] },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
