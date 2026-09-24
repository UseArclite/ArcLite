import { createFileRoute } from "@tanstack/react-router";
import { createPublicClient, http, type Address } from "viem";
import { ARCLITE, CHAINS, resolveChainId } from "@/lib/chain/chains";

/**
 * The deposits an address has made, so a vault can rebuild itself from the chain.
 *
 * A note is `candidateNote(keys, epoch, counter, assetId, units)`. The keys come from a
 * signature and the counter is a small integer, but **`assetId` and `units` are not derivable
 * from anything** — so a browser that lost its local deposit records could not reconstruct its
 * own notes, and the vault would scan the tree and honestly report nothing. The money was never
 * gone; the coordinates were.
 *
 * They are on chain, and they always were. `Shielded` carries the asset, the amount and the
 * commitment, and `shield` is an ordinary public transfer — so the depositor is the transaction
 * sender. Reading those back gives a client everything it needs to find the counter by trying
 * a few, and rebuild the records it lost.
 *
 * **This links an address to its deposits, and that is not a new leak.** It is the one linkage a
 * shielded pool cannot hide and never claimed to: `shield` moves tokens from a known address in
 * public. What stays private is everything after — which notes are whose, what they traded, and
 * who crossed with whom. Anyone reading the chain can already build this; serving it only saves
 * a user from needing an archive node to recover their own money.
 */

const SHIELDED = {
  type: "event",
  name: "Shielded",
  inputs: [
    { name: "assetId", type: "uint16", indexed: true },
    { name: "commitment", type: "bytes32", indexed: true },
    { name: "leafIndex", type: "uint32" },
    { name: "units", type: "uint128" },
    { name: "ciphertext", type: "bytes" },
  ],
} as const;

/** Queued deposits enter the tree later, but the note is identical — same asset, same units. */
const SHIELD_QUEUED = {
  type: "event",
  name: "ShieldQueued",
  inputs: [
    { name: "assetId", type: "uint16", indexed: true },
    { name: "commitment", type: "bytes32", indexed: true },
    { name: "units", type: "uint128" },
  ],
} as const;

export const Route = createFileRoute("/api/notes/deposits")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const address = url.searchParams.get("address")?.toLowerCase();
        if (!address || !/^0x[0-9a-f]{40}$/.test(address)) {
          return Response.json({ error: "address is required" }, { status: 400 });
        }

        const chainId = resolveChainId();
        const deployed = ARCLITE[chainId];

        // `?pool=` recovers from a retired pool too, validated against the ones this venue
        // knows rather than trusted — this reads chain logs, and an arbitrary address would
        // make it a log-scanning proxy for anything on the network.
        const asked = url.searchParams.get("pool")?.toLowerCase();
        const known = [deployed.pool, ...deployed.retiredPools].filter(Boolean) as string[];
        if (asked && !known.some((p) => p.toLowerCase() === asked)) {
          return Response.json({ error: "not a pool this venue knows" }, { status: 400 });
        }
        const pool = (asked ?? deployed.pool) as Address | null;
        if (!pool) {
          return Response.json(
            { chainId, deployed: false, deposits: [] },
            { headers: { "cache-control": "no-store" } },
          );
        }

        try {
          const client = createPublicClient({ chain: CHAINS[chainId], transport: http() });
          const fromBlock = BigInt(
            asked && asked !== deployed.pool?.toLowerCase() ? 0 : (deployed.deployBlock ?? 0),
          );

          const [shielded, queued] = await Promise.all([
            client.getLogs({ address: pool, event: SHIELDED, fromBlock, toBlock: "latest" }),
            client.getLogs({ address: pool, event: SHIELD_QUEUED, fromBlock, toBlock: "latest" }),
          ]);

          // The event names the note; the transaction names the depositor. One receipt lookup
          // per deposit, and a wallet has few — this is not a hot path, it is the path someone
          // takes once after losing a browser.
          const all = [...shielded, ...queued];
          const mine: {
            assetId: number;
            units: string;
            commitment: string;
            blockNumber: string;
          }[] = [];

          for (const log of all) {
            const tx = await client.getTransaction({ hash: log.transactionHash }).catch(() => null);
            if (tx?.from?.toLowerCase() !== address) continue;
            mine.push({
              assetId: Number(log.args.assetId),
              units: String(log.args.units),
              commitment: log.args.commitment as string,
              blockNumber: String(log.blockNumber),
            });
          }

          // Oldest first, which is the order the counters were assigned in — it makes the
          // client's search start where the answer usually is.
          mine.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)));

          // When each deposit landed, so the withdraw form can say how linkable the two would be.
          //
          // Fetched per distinct block rather than per deposit: several deposits in one block is
          // ordinary, and the timestamp is the block's. A wallet has few deposits and this is not
          // a hot path, but there is no reason to ask the same question twice.
          const blocks = [...new Set(mine.map((d) => d.blockNumber))];
          const times = new Map<string, number>();
          for (const b of blocks) {
            const block = await client.getBlock({ blockNumber: BigInt(b) }).catch(() => null);
            if (block) times.set(b, Number(block.timestamp) * 1000);
          }

          return Response.json(
            {
              chainId,
              pool,
              deposits: mine.map((d) => ({ ...d, at: times.get(d.blockNumber) ?? null })),
            },
            { headers: { "cache-control": "no-store" } },
          );
        } catch (error) {
          return Response.json(
            { chainId, pool, error: (error as Error).message, deposits: [] },
            { status: 503, headers: { "cache-control": "no-store" } },
          );
        }
      },
    },
  },
});
