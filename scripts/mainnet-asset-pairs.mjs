/**
 * The token/feed pairs to register on mainnet, derived rather than typed.
 *
 * `RegisterAssets.s.sol` deliberately takes explicit addresses: registration is a governance act
 * and the registry's probe is defence-in-depth against a mistake, not a substitute for knowing
 * what you are registering. But "explicit" should not mean "hand-copied from a planning
 * document" — 35 pairs of 42-character addresses is exactly the input a human transposes, and a
 * transposed feed address registers an asset priced by the wrong stock.
 *
 * So the list comes from the same two sources the dashboard reads: Robinhood's asset registry
 * and Chainlink's feed directory, intersected the same way, through the same module. If the
 * dashboard will price it, this registers it; if it will not, this does not.
 *
 *   bun scripts/mainnet-asset-pairs.mjs            # human-readable table
 *   bun scripts/mainnet-asset-pairs.mjs --env      # TOKENS=... FEEDS=... for the forge script
 */

import { getEligibleAssets } from "../src/lib/chain/registry.ts";

const assets = await getEligibleAssets(4663, true);
assets.sort((a, b) => a.symbol.localeCompare(b.symbol));

if (process.argv.includes("--env")) {
  // One line each so a shell can `eval` or a human can read the diff between two runs.
  process.stdout.write(`TOKENS=${assets.map((a) => a.address).join(",")}\n`);
  process.stdout.write(`FEEDS=${assets.map((a) => a.feed.address).join(",")}\n`);
} else {
  console.log(`${assets.length} eligible assets on Robinhood Chain mainnet\n`);
  for (const a of assets) {
    console.log(
      `${a.symbol.padEnd(6)} ${a.address}  feed ${a.feed.address}  ${a.feed.decimals}dp  ` +
        `heartbeat ${a.feed.heartbeatSeconds}s  deviation ${a.feed.deviationBps}bps`,
    );
  }
  // Every equity feed on RHC is 8 decimals and the registry rejects anything else. A directory
  // change would otherwise be discovered as a revert partway through a broadcast, with some
  // assets registered and some not.
  const odd = assets.filter((a) => a.feed.decimals !== 8);
  if (odd.length) {
    console.log(`\nWARNING: ${odd.map((a) => a.symbol).join(", ")} do not have 8-decimal feeds.`);
    console.log("The registry will reject them. Check the feed directory before broadcasting.");
    process.exitCode = 1;
  }
}
