"use client";
import { useMemo, type ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { rhcMainnet, rhcTestnet } from "@/lib/chain/chains";

/**
 * Wallet connection — MetaMask, and nothing else.
 *
 * ## What was wrong
 *
 * A plain `injected()` reads `window.ethereum`, which with several extensions installed is
 * whichever one won the race to assign it — and Phantom and Coinbase Wallet both set
 * `isMetaMask: true` for compatibility, so checking that flag does not save you. Worse, wagmi's
 * EIP-6963 discovery is on by default and **adds every announced wallet as its own connector**,
 * so `connectors[0]` was whichever extension announced first. The button said "Connect MetaMask"
 * and opened Coinbase.
 *
 * ## What this does instead
 *
 * EIP-6963 is the mechanism that actually solves this: every wallet announces itself with a
 * stable reverse-DNS name and *its own provider object*, so there is no shared global to fight
 * over. We listen for those announcements, keep the one whose `rdns` is MetaMask's, and hand
 * that exact provider to the connector.
 *
 * Auto-discovery is turned off so wagmi adds nothing of its own — there is exactly one connector,
 * bound to one provider.
 *
 * The `target` is a **function**, evaluated at connect time rather than at config time. That
 * distinction matters: an earlier attempt used the string form `injected({ target: "metaMask" })`
 * and hung the renderer outright whenever MetaMask was absent — the tab stopped responding to
 * clicks, navigation, even close, while SSR kept returning a healthy 200. A lazy target that
 * resolves to `undefined` simply reports the wallet as unavailable.
 *
 * Mounted inside `MarketProvider`: market data is public, so prices, guards and the window clock
 * render for anyone, and only balances and order submission need a wallet.
 */

const CHAIN_ID = Number(import.meta.env.VITE_ARCLITE_CHAIN_ID ?? 46630);

export const ACTIVE_CHAIN = CHAIN_ID === rhcMainnet.id ? rhcMainnet : rhcTestnet;
const OTHER_CHAIN = ACTIVE_CHAIN.id === rhcMainnet.id ? rhcTestnet : rhcMainnet;

interface Eip1193 {
  isMetaMask?: boolean;
  isPhantom?: boolean;
  isCoinbaseWallet?: boolean;
  isBraveWallet?: boolean;
  isRabby?: boolean;
  providers?: Eip1193[];
  request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
}

/** MetaMask's EIP-6963 identifiers. Flask is the developer build and announces separately. */
const METAMASK_RDNS = ["io.metamask", "io.metamask.flask"];

interface AnnounceEvent extends Event {
  detail: { info: { rdns: string; name: string }; provider: Eip1193 };
}

/**
 * Providers that announced themselves over EIP-6963, keyed by their reverse-DNS name.
 *
 * Populated at module load and kept live: extensions can announce late, and a wallet unlocked
 * after the page loaded announces then. Missing an announcement means the wallet looks absent,
 * so the listener is never removed.
 */
const announced = new Map<string, Eip1193>();

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } = (event as AnnounceEvent).detail;
    announced.set(info.rdns, provider);
  });
  // Wallets announce on request as well as at injection, so ask — a page that loads after the
  // extension has already announced would otherwise see nothing.
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/**
 * `isMetaMask` is not proof of MetaMask.
 *
 * Several wallets set it true for compatibility with sites that only check that flag — Phantom
 * and Coinbase Wallet both do. So a positive `isMetaMask` is necessary but not sufficient, and
 * the impersonators have to be excluded by their own flags.
 *
 * This is best-effort by nature: a wallet that sets `isMetaMask` and nothing else is
 * indistinguishable from here. It is the right trade anyway — connecting to a wallet that went
 * out of its way to look like MetaMask is a better outcome than refusing to connect at all.
 */
function isGenuineMetaMask(p: Eip1193 | undefined): boolean {
  if (!p?.isMetaMask) return false;
  return !p.isPhantom && !p.isCoinbaseWallet && !p.isBraveWallet && !p.isRabby;
}

/**
 * MetaMask's provider, or nothing. Never waits.
 *
 * EIP-6963 first, because it is the only source that identifies a wallet rather than letting one
 * claim to be another: the `rdns` comes from the extension's own manifest and Phantom cannot
 * announce itself as `io.metamask`.
 *
 * The `window.ethereum` fallback is for wallets too old to announce. It is genuinely
 * best-effort — a wallet that sets `isMetaMask` and none of the tell-tale flags is
 * indistinguishable there — which is exactly why it is the fallback and not the primary.
 */
export function findMetaMask(): Eip1193 | undefined {
  if (typeof window === "undefined") return undefined;

  for (const rdns of METAMASK_RDNS) {
    const provider = announced.get(rdns);
    if (provider) return provider;
  }

  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) return undefined;
  if (Array.isArray(eth.providers)) return eth.providers.find(isGenuineMetaMask);
  return isGenuineMetaMask(eth) ? eth : undefined;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const config = useMemo(
    () =>
      createConfig({
        // Both networks are declared so a wallet pointed at the wrong one can be switched
        // rather than rejected; the venue itself only ever acts on ACTIVE_CHAIN.
        chains: [ACTIVE_CHAIN, OTHER_CHAIN],
        // Off, deliberately. Left on, wagmi adds a connector for every wallet that announces —
        // Phantom, Coinbase, whatever else is installed — and the button ends up connecting to
        // whichever one happened to be first in the list.
        multiInjectedProviderDiscovery: false,
        connectors: [
          injected({
            // A function, so it resolves when the user clicks rather than when the config is
            // built. Returning a provider of `undefined` reports MetaMask as unavailable, which
            // is what the button already renders an install link for.
            target: () => ({
              id: "metaMask",
              name: "MetaMask",
              provider: findMetaMask() as never,
            }),
          }),
        ],
        transports: {
          [rhcMainnet.id]: http(),
          [rhcTestnet.id]: http(),
        },
        ssr: true,
      }),
    [],
  );

  return <WagmiProvider config={config}>{children}</WagmiProvider>;
}
