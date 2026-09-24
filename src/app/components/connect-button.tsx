"use client";
import { useEffect, useState } from "react";
import { ArrowUpRight, LockKeyhole, LogOut, PenLine, ShieldCheck } from "lucide-react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { ACTIVE_CHAIN, findMetaMask } from "./wallet-provider";
import { useSession } from "./session-provider";
import { useT } from "../lib/i18n";

/**
 * Connect / account control — MetaMask only.
 *
 * Replaces the "Live access" button that opened a Coming Soon dialog. Styled with the existing
 * `.access-button` class so it inherits the page's design.
 *
 * With one wallet there is no chooser: the button connects directly. Each state is handled
 * explicitly rather than collapsing into a generic failure, because each needs a different
 * action from the person — install MetaMask, switch network, connect, or sign in.
 *
 * Connecting and signing in are kept apart on purpose. Connecting is how you look at the venue;
 * signing is how you assert an identity to it. Nothing here asks for a signature until someone
 * asks for one, because prompting on connect teaches people to sign without reading.
 */
export function ConnectButton() {
  const t = useT();
  const { address, chain, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const session = useSession();
  const [menuOpen, setMenuOpen] = useState(false);

  const metaMask = connectors[0];

  // The server cannot know whether an extension is installed, so render a stable label until
  // after mount. Branching on wallet presence during hydration would mismatch the server's HTML.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <span className="access-button" aria-hidden="true">
        {t("Wallet")} <ArrowUpRight size={15} />
      </span>
    );
  }

  // MetaMask is enforced here rather than in the connector config, because the connector's
  // `target` option hangs the renderer when the wallet is absent. Checking the resolved provider
  // gives the same guarantee — we only ever connect to MetaMask — without that failure mode.
  const installed = Boolean(metaMask) && findMetaMask() !== undefined;

  if (!isConnected) {
    if (!installed) {
      return (
        <a
          className="access-button"
          href="https://metamask.io/download/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("Install MetaMask")} <ArrowUpRight size={15} />
        </a>
      );
    }
    return (
      <button
        className="access-button"
        onClick={() => connect({ connector: metaMask })}
        disabled={isPending}
      >
        {isPending ? t("Check MetaMask…") : error ? t("Retry connect") : t("Connect MetaMask")}
        <ArrowUpRight size={15} />
      </button>
    );
  }

  if (chain?.id !== ACTIVE_CHAIN.id) {
    // Both the current and the wanted chain id are shown, because the *names* collide: a wallet
    // may hold "Robinhood Chain" for either network, and mainnet 4663 and testnet 46630 look
    // alike at a glance. The number is the only unambiguous thing here.
    return (
      <span className="wallet-chip">
        <button
          className="access-button"
          onClick={() => switchChain({ chainId: ACTIVE_CHAIN.id })}
          disabled={switching}
        >
          {switching ? "Switching…" : `Switch to chain ${ACTIVE_CHAIN.id}`}
          <ArrowUpRight size={15} />
        </button>
        {/* A failed switch used to be silent: the button simply returned to its old label and
            the wallet stayed where it was, which reads as "I clicked it and nothing happened".
            MetaMask rejects for reasons worth seeing — the network not being added yet, or the
            request being declined. */}
        {switchError && (
          <span className="wallet-error" role="alert">
            {/^user rejected|denied/i.test(switchError.message)
              ? "Network switch declined in MetaMask."
              : switchError.message}
          </span>
        )}
        <span className="wallet-note">
          {chain
            ? `MetaMask is on chain ${chain.id}. The venue runs on ${ACTIVE_CHAIN.id}.`
            : `MetaMask is on a network this app does not know. The venue runs on chain ${ACTIVE_CHAIN.id}.`}
        </span>
      </span>
    );
  }

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
  const signedIn = session.status === "authenticated";

  return (
    <span className="wallet-chip">
      <button
        className="access-button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-expanded={menuOpen}
        // The lock is filled once a signature has proven the address, so the chip distinguishes
        // "a wallet is attached" from "this account has been authenticated".
        title={signedIn ? "Signed in" : "Connected, not signed in"}
      >
        {signedIn ? <ShieldCheck size={15} /> : <LockKeyhole size={15} />} {short}
      </button>
      {menuOpen && (
        <div className="wallet-menu">
          {signedIn ? (
            <button
              className="access-button"
              onClick={() => {
                void session.signOut();
                setMenuOpen(false);
              }}
            >
              <LogOut size={14} /> {t("Sign out")}
            </button>
          ) : (
            <button
              className="access-button"
              onClick={() => void session.signIn()}
              disabled={session.status === "signing"}
            >
              <PenLine size={14} />{" "}
              {session.status === "signing"
                ? "Check MetaMask…"
                : session.mismatched
                  ? "Sign in as this address"
                  : "Sign in"}
            </button>
          )}
          <button
            className="access-button"
            onClick={() => {
              disconnect();
              setMenuOpen(false);
            }}
          >
            <LogOut size={14} /> {t("Disconnect")}
          </button>
          {session.error && <span className="wallet-error">{session.error}</span>}
        </div>
      )}
    </span>
  );
}
