"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { createSiweMessage } from "viem/siwe";
import { ACTIVE_CHAIN } from "./wallet-provider";

/**
 * Sign-In With Ethereum, client half.
 *
 * Signing in is an explicit act, never automatic on connect. Connecting a wallet is how you look
 * at the venue; signing is how you assert an identity to it, and prompting for a signature the
 * instant someone clicks Connect trains people to sign things they have not read. Market data —
 * prices, guards, the window clock — needs neither.
 *
 * The session deliberately does **not** authenticate order submission. That path carries a
 * Schnorr signature inside the sealed payload and is fetched with `credentials: 'omit'`, so no
 * cookie ties a shielded order to an address in our own request logs.
 */

export type SessionStatus = "loading" | "anonymous" | "signing" | "authenticated";

export interface SessionValue {
  status: SessionStatus;
  /** The signed-in address, lowercased. Null unless status is `authenticated`. */
  address: string | null;
  /**
   * Short-lived Supabase JWT for Realtime and direct reads under RLS. Kept in memory only —
   * localStorage would survive a shared machine, and this grants database access.
   */
  supabaseJwt: string | null;
  expiresAt: Date | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  /** True when a session exists but for a different address than the wallet now holds. */
  mismatched: boolean;
}

const Context = createContext<SessionValue | null>(null);

interface SessionResponse {
  address: string | null;
  chainId?: number;
  expiresAt?: string;
  supabaseJwt?: string | null;
}

async function fetchSession(): Promise<SessionResponse> {
  const res = await fetch("/api/auth/session", {
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!res.ok) return { address: null };
  return (await res.json()) as SessionResponse;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const { address: wallet, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isPending } = useQuery({
    queryKey: ["session"],
    queryFn: fetchSession,
    // The cookie is the authority; re-reading it on focus catches a session that expired or was
    // revoked in another tab, so the UI does not keep offering actions that will 401.
    refetchOnWindowFocus: true,
    staleTime: 30_000,
    retry: false,
  });

  const sessionAddress = data?.address?.toLowerCase() ?? null;
  const walletAddress = wallet?.toLowerCase() ?? null;
  const mismatched = Boolean(sessionAddress && walletAddress && sessionAddress !== walletAddress);

  const signOut = useCallback(async () => {
    setError(null);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // The cookie clear rides on the response, so a network failure leaves the session intact.
      // Say nothing and let the refetch below report the truth rather than a hopeful "signed out".
    }
    await queryClient.invalidateQueries({ queryKey: ["session"] });
  }, [queryClient]);

  const signIn = useCallback(async () => {
    if (!walletAddress) {
      setError("Connect MetaMask first.");
      return;
    }
    setSigning(true);
    setError(null);
    try {
      const nonceRes = await fetch("/api/auth/nonce", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!nonceRes.ok) {
        const body = (await nonceRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not start sign-in.");
      }
      const { nonce, statement } = (await nonceRes.json()) as { nonce: string; statement: string };

      // domain and uri come from the live location, and the server checks both against the host
      // the request actually arrived on. Hardcoding a domain here would break preview
      // deployments without making anything safer.
      const message = createSiweMessage({
        address: wallet!,
        chainId: ACTIVE_CHAIN.id,
        domain: window.location.host,
        nonce,
        statement,
        uri: window.location.origin,
        version: "1",
        issuedAt: new Date(),
      });

      const signature = await signMessageAsync({ message });

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
      });
      const body = (await verifyRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!verifyRes.ok || !body.ok) throw new Error(body.error ?? "Sign-in was rejected.");

      await queryClient.invalidateQueries({ queryKey: ["session"] });
    } catch (e) {
      const message = (e as Error).message ?? "Sign-in failed.";
      // MetaMask's rejection is a normal outcome, not an error worth shouting about.
      setError(/user rejected|denied/i.test(message) ? "Signature declined." : message);
    } finally {
      setSigning(false);
    }
  }, [wallet, walletAddress, signMessageAsync, queryClient]);

  // Disconnecting the wallet must end the session too. Leaving a live cookie behind means the
  // next person at the machine is still signed in as the last one.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (wasConnected.current && !isConnected && sessionAddress) void signOut();
    wasConnected.current = isConnected;
  }, [isConnected, sessionAddress, signOut]);

  const status: SessionStatus = signing
    ? "signing"
    : isPending
      ? "loading"
      : sessionAddress && !mismatched
        ? "authenticated"
        : "anonymous";

  return (
    <Context.Provider
      value={{
        status,
        address: status === "authenticated" ? sessionAddress : null,
        supabaseJwt: status === "authenticated" ? (data?.supabaseJwt ?? null) : null,
        expiresAt: data?.expiresAt ? new Date(data.expiresAt) : null,
        error,
        signIn,
        signOut,
        mismatched,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useSession(): SessionValue {
  const value = useContext(Context);
  if (!value) throw Error("useSession must be used inside SessionProvider");
  return value;
}
