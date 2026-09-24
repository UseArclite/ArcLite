import { createPublicClient, defineChain, http, type PublicClient } from "viem";

/**
 * Robinhood Chain — an Arbitrum Orbit L2 settling to Ethereum, gas token ETH.
 *
 * Both networks are probed and live (see docs/week1-check1-transfer-restrictions.md).
 * The chain is selected by ARCLITE_CHAIN_ID so mainnet is a config flip, not a code change.
 */

export const rhcMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  contracts: {
    // Deployed at the same address across Orbit chains; confirmed present on RHC by the
    // multicall reads in this module succeeding.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const rhcTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  testnet: true,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const CHAINS = { 4663: rhcMainnet, 46630: rhcTestnet } as const;

export type SupportedChainId = keyof typeof CHAINS;

export function isSupportedChainId(id: number): id is SupportedChainId {
  return id in CHAINS;
}

/** Known contracts, per chain. Stock tokens come from the registry, not from here. */
export const CONTRACTS = {
  4663: {
    /**
     * Beacon, pause authority and blocklist registry for every Robinhood tokenized asset — all
     * three responsibilities in one contract, so `paused()` here freezes all 194 tokens at once
     * and `isBlocked(pool)` can halt us unilaterally. Both are read every guard cycle.
     */
    tokenControl: "0xe10b6f6B275de231345c20D14Ab812db62151b00",
    usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    /** USDG/USD — a crypto-category feed, so it updates 24/7 unlike the equity feeds. */
    usdgUsdFeed: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2",
    /**
     * syrupUSDG/USDG exchange rate, 18dp, accumulating. Structurally the {issuerNAV, asOf}
     * treasury reference the spec wants, and the best USDY-class candidate on RHC today.
     * Dormant until the treasury lane opens.
     */
    syrupUsdgRateFeed: "0xDd194C66aDcb422F188a04434e4824D70c151cF0",
  },
  46630: {
    tokenControl: null,
    // tUSDG, the testnet stand-in. Six decimals, like the real USDG, because the equities are
    // eighteen and converting between them is the quote leg's whole job — a stand-in that
    // matched the equities would let a decimal bug through unnoticed.
    usdg: "0x3d62863D523027d8bC5A362Bd99186fa1eb39A14",
    weth: null,
    usdgUsdFeed: "0xFD8a6ca25B32285A89A8fF82831C7d5feC0bDB41",
    syrupUsdgRateFeed: null,
  },
} as const;

/**
 * ArcLite's own deployed contracts, per chain. Mirrors `deployments/<chainId>.json`, which also
 * records the deploy block and transaction hashes.
 *
 * Both networks are live as of 2026-09-22. Where a contract is genuinely absent the entry stays
 * null rather than holding a placeholder, because a placeholder address is indistinguishable
 * from a real one at a call site.
 */
export const ARCLITE = {
  4663: {
    eligibleRegistry: "0x9c4004d59f97b7993D621D867262f91745C594C7",
    eventCalendar: "0x336F7b0A26845Fb7Cd479A3e0C14A90Fa309AE5F",
    priceCommitter: "0xcB0165Ac908B4758C2790BC2DeB59ECa20b432F6",
    pool: "0xE14B341d854354C767abdb634fC7B85652018222",
    /**
     * These are not typos and not copied from the testnet block below.
     *
     * The first three are *the same strings* on both chains, and this screening verifier shares
     * an address with testnet's unshield verifier. Same deployer, same nonce, same CREATE
     * address — nothing disambiguates them but the chain id. Which means reading one of these
     * on the wrong RPC returns a real contract that answers plausibly and is the wrong one, so
     * the deployment table is the only thing that should ever decide which chain an address
     * belongs to.
     *
     * The screening verifier is deployed and deliberately **not** wired to the pool, whose
     * `shieldVerifier` is `address(0)`: the screening circuit has never been compiled and no
     * issuer exists to sign the attestation it verifies, so a verifier on that path rejects
     * every honest deposit and screens nobody. The first mainnet pool had it set, and every
     * deposit reverted.
     */
    screeningVerifier: "0x59fF64533400A6605CCdA9Dd10d5AC1E5FF3Cc15",
    unshieldVerifier: "0x1870F3D4a7D91B4dC3d735939dbec9538096Dc77",
    /**
     * Redeployed 2026-09-24. The circuit it verifies was corrected — the price-table selector
     * did not prove the chosen row was inside the committed range — and a new verification key
     * means the old verifier rejects every proof the fixed circuit produces. The retired one
     * stays at 0x54c62F55…C411D01 and is still a real contract, which is why the deployment
     * table rather than an address is what decides which verifier is current.
     */
    batchVerifier: "0xe829a754DabD82738197D725a943AcDc148AEd88",
    /** Not deployed on mainnet yet — the tape and disclosure lanes are Phase 5. */
    tapeRegistry: null,
    disclosureRegistry: null,
    deployBlock: 70575648,
    /**
     * The asset a buy is funded with and a sell is paid in, as the registry numbers it.
     *
     * Not a constant and not 0: `EligibleRegistry.assetIdOf` returns 0 for *unregistered* and
     * `nextAssetId` starts at 1, so no registered asset can ever be 0. The pool holds this in an
     * immutable and supplies it as a public input of every crossing proof, so a settler cannot
     * name a traded asset and pay sellers in it.
     *
     * USDG, registered before the pool existed so this could be the id the registry returned.
     */
    quoteAssetId: 1,
    /**
     * Pools this venue has retired, newest first.
     *
     * `RwaDarkPool` is immutable by design, so a fix is a new address rather than an upgrade —
     * and notes shielded into an older one stay there. They are not lost: `unshield` carries no
     * pause, no role and no window check, and the retired pool's verifier is untouched, so
     * anyone holding a note can still withdraw it. But only if something still knows the address
     * to look at, which is what this list is for.
     *
     * v1 held a note when v2 replaced it. `pricer` is immutable, so correcting the price
     * committer's multiplier guard — which deferred 13 of 35 assets forever — meant a new pool
     * rather than an upgrade.
     */
    retiredPools: ["0x16B2578e48b835F7C04F8a68Ce88D07a798e58b2"] as readonly `0x${string}`[],
  },
  46630: {
    eligibleRegistry: "0x9c4004d59f97b7993D621D867262f91745C594C7",
    eventCalendar: "0x336F7b0A26845Fb7Cd479A3e0C14A90Fa309AE5F",
    priceCommitter: "0x478D11836CdFdDD60941Ffe08a02b2C2cc70E824",
    pool: "0x83572a4d1F0Aac4199caC26CCD59f6D25A717ca7",
    screeningVerifier: "0x2E9585C91CAD9f0B0528bF18654Ae94B27de052E",
    unshieldVerifier: "0x59fF64533400A6605CCdA9Dd10d5AC1E5FF3Cc15",
    batchVerifier: "0x94D05E9c34DaC3022d94896298675EFB73e4c5b3",
    tapeRegistry: "0x368Fa1c2F43B7b51a5e1Ef5fF6eB1f23CffD3136",
    disclosureRegistry: "0x71A82F3a511e57bA9B130575c28169238711236f",
    /**
     * Log scans start here rather than block 0 — the chain is past 122 M blocks. This is pool
     * v4's block, not the registry's: the tree is the pool's, and scanning from before it exists
     * only reads leaves belonging to a pool whose notes these are not.
     */
    deployBlock: 122742512,
    /** tUSDG, six decimals — testnet has no USDG, and `EligibleRegistry.usdg` is immutable. */
    quoteAssetId: 4,
    /** v3 held notes when v4 replaced it; v1 and v2 were retired before anyone deposited. */
    retiredPools: [
      "0x12721fBdB261Eeb5e4227f0C4f5C68d27c6b5668",
      "0xE14B341d854354C767abdb634fC7B85652018222",
      "0x54c62F552449FD7031ddA89B978eC2925C411D01",
    ] as readonly `0x${string}`[],
  },
} as const;

/**
 * The chain the *browser* is configured for.
 *
 * `resolveChainId` reads `process.env`, which is the server's answer and is not available in a
 * page. The client had its own answer hardcoded to 46630 in half a dozen places — pool address,
 * retired pools, quote asset, token map — so a switch to mainnet would have moved the server
 * while leaving every deposit, order and withdrawal pointed at testnet contracts. One value,
 * read from the same build-time variable the wallet uses.
 */
export function clientChainId(): SupportedChainId {
  const raw = Number(import.meta.env?.VITE_ARCLITE_CHAIN_ID ?? 46630);
  if (!isSupportedChainId(raw)) {
    throw new Error(`VITE_ARCLITE_CHAIN_ID=${raw} is not a Robinhood Chain network`);
  }
  return raw;
}

/** The deployment the browser should be talking to. */
export function clientDeployment() {
  return ARCLITE[clientChainId()];
}

/**
 * A read-only client for the configured chain, independent of any wallet.
 *
 * Reading public contract state is not a wallet operation, and tying it to one is how a page ends
 * up unable to answer a question the chain would happily answer. `usePublicClient()` resolves
 * through wagmi's connection lifecycle: it is undefined before a connector settles and undefined
 * again whenever the wallet sits on a chain the config does not carry. Code that treated that
 * absence as an answer reported every note unspent for the first moments after the vault
 * unlocked — which is precisely when the first scan runs.
 *
 * So public reads use this instead. It needs no wallet, no connection and no permission, and it
 * is the same RPC the rest of the site reads from.
 *
 * Memoised because a client per call would rebuild the transport on every scan.
 */
let cachedReadClient: PublicClient | undefined;

export function readClient(): PublicClient {
  if (!cachedReadClient) {
    const chain = CHAINS[clientChainId()];
    cachedReadClient = createPublicClient({ chain, transport: http() });
  }
  return cachedReadClient;
}

export function resolveChainId(): SupportedChainId {
  const raw = Number(process.env.ARCLITE_CHAIN_ID ?? 46630);
  if (!isSupportedChainId(raw)) {
    throw new Error(
      `ARCLITE_CHAIN_ID=${raw} is not a Robinhood Chain network (expected 4663 or 46630)`,
    );
  }
  return raw;
}
