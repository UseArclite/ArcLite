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
import { useAccount, useSignMessage, useWriteContract, usePublicClient } from "wagmi";
import { clientChainId, clientDeployment, readClient } from "@/lib/chain/chains";
import { vaultMessage, type NoteOrigin } from "@/lib/notes/vault";
import { preflight } from "../lib/order-preflight";
import { readSpent, type SpentResult } from "../lib/spent-check";
import { useMarket } from "./market-provider";
import type { ProofPhase, VaultRequest, VaultResponse } from "@/workers/vault.worker";

/**
 * The shielded vault, main-thread half.
 *
 * This component never sees a key. It sends the signature into a worker and receives balances
 * back; `npk`, `pkX`, `pkY` and `ivk` exist only inside that worker's module scope. Anything
 * here — React state, a devtools inspection, a script that ends up in the bundle later — is
 * therefore one boundary away from the material that reads someone's position.
 *
 * Unlocking is an explicit act, separate from both connecting and signing in. It is a third
 * prompt, and that is the point: the message being signed grants the ability to *see* a private
 * balance, so it should not ride along with a login someone clicked past.
 */

export type VaultStatus = "locked" | "unlocking" | "unlocked" | "unavailable";

export interface VaultBalance {
  assetId: string;
  units: string;
}

/**
 * A note this vault created, once found in the pool's tree.
 *
 * `leafIndex` is the part that matters: a note's nullifier is bound to its position, and the
 * spend signature is bound to the nullifier. An order signed against the wrong index produces a
 * signature the circuit rejects — which is exactly what the hardcoded `leafIndex: "0"` here used
 * to do, silently, for every order submitted from this page.
 */
export interface VaultNote {
  epoch: number;
  counter: number;
  assetId: string;
  units: string;
  leafIndex: number;
  /** Also the handle any order spending this note was submitted under. */
  commitment: string;
  /** Published on chain when the note is spent. */
  nullifier: string;
  /**
   * How this note was made, and therefore how to rebuild it.
   *
   * A settlement output carries its parent's `(epoch, counter)` — those are the only handle it
   * has — so the pair alone cannot distinguish the two derivations. Spending a note without this
   * rebuilt the parent instead, and the parent had already been spent settling the very order
   * that produced this note, so the venue refused it: "this note has already been offered".
   */
  origin: NoteOrigin;
  /**
   * True once the pool has recorded the nullifier.
   *
   * The tree is append-only, so a spent note's commitment stays in it forever and a scan finds
   * it exactly as it finds a live one. Without asking the pool there is no difference between
   * money you have and money you already moved.
   */
  spent: boolean;
}

/**
 * What the client has to remember for itself.
 *
 * Note secrets regenerate from the viewing key, but only if the client knows *which* notes it
 * made: `(epoch, counter, assetId, units)`. That record is the one thing no server holds and no
 * ciphertext carries, so it lives here — per vault fingerprint, so two accounts on one browser
 * never see each other's.
 */
interface DepositRecord {
  epoch: number;
  counter: number;
  assetId: string;
  units: string;
}

const depositsKey = (fingerprint: string) => `arclite-deposits-v1:${fingerprint}`;

function loadDeposits(fingerprint: string): DepositRecord[] {
  try {
    const raw = localStorage.getItem(depositsKey(fingerprint));
    return raw ? (JSON.parse(raw) as DepositRecord[]) : [];
  } catch {
    // Private windows and blocked site data both land here. Losing the record means losing
    // sight of the notes, not the notes themselves — they are still in the tree and still
    // regenerable by anyone who knows the counters.
    return [];
  }
}

function saveDeposits(fingerprint: string, records: DepositRecord[]) {
  try {
    localStorage.setItem(depositsKey(fingerprint), JSON.stringify(records));
  } catch {
    /* see loadDeposits */
  }
}

/**
 * One write this vault sent, as the panels report it.
 *
 * `kind` rather than a free-text label so the UI decides the wording and the provider only
 * records what happened — a string assembled here would need translating in two places.
 */
export interface VaultTransaction {
  id: string;
  kind: "approve" | "deposit" | "withdraw";
  status: "pending" | "confirmed" | "failed";
  hash?: `0x${string}`;
  /** Registry asset id, for naming the asset without the panel having to remember it. */
  assetId?: string;
  units?: string;
  at: number;
  /** Set only on failure, and already reduced to something worth reading. */
  error?: string;
  /** Proving time in ms, for a withdrawal. The one number that shows where the seconds went. */
  provingMs?: number;
}

export interface VaultValue {
  status: VaultStatus;
  /** Identifies which vault is open, without disclosing anything that could read it. */
  fingerprint: string | null;
  balances: VaultBalance[];
  /** Notes found in the on-chain tree, with their leaf positions. */
  noteCount: number;
  notes: VaultNote[];
  /** Shield tokens into the pool, creating a note only this vault can spend. */
  shield: (
    assetId: string,
    units: string,
  ) => Promise<{ ok: boolean; reason?: string; txHash?: string }>;
  shielding: boolean;
  /**
   * Withdraw a note, proving it in this browser.
   *
   * The proof is generated in the vault worker, where the secrets already are — a server that
   * could prove your withdrawal could also spend your note. It takes a few seconds and needs no
   * operator at all, which is what makes "unshield is always open" a property rather than a
   * promise.
   */
  withdraw: (request: {
    note: VaultNote;
    units: string;
    recipient: `0x${string}`;
    pool?: `0x${string}`;
  }) => Promise<{ ok: boolean; reason?: string; txHash?: string; provingMs?: number }>;
  withdrawing: boolean;
  /** Which stage the running withdrawal is at, or null when none is. */
  proofPhase: ProofPhase | null;
  /** Notes stranded in a pool the venue has retired. Withdrawable, not tradable. */
  legacyNotes: LegacyNote[];
  /** What `shield` will accept on this network, from the registry. Empty until it loads. */
  poolAssets: PoolAsset[];
  /**
   * Rebuild this vault's deposit records from the chain. Safe to re-run.
   *
   * With `dryRun` it performs the whole recovery — the log scan, the counter search, the
   * regeneration inside the worker — and declines to write the result. That is the rehearsal:
   * a real recovery that is not saved, rather than a simulation of one.
   */
  recover: (options?: { dryRun?: boolean }) => Promise<{
    ok: boolean;
    /** Deposits this address made, as the chain reports them. */
    onChain?: number;
    /** How many of those the vault could regenerate from its keys. */
    found?: number;
    /** How many it already had records for. */
    alreadyKnown?: number;
    reason?: string;
  }>;
  /**
   * Seal one epoch's viewing key to an auditor's published key.
   *
   * What comes back is a sealed box, not a key: `ivk_epoch = poseidon2(ivk, epoch)` reconstructs
   * exactly that epoch's notes and cannot walk backwards to the master. The scope *is* the key
   * rather than a flag someone could flip, which is the difference between a disclosure boundary
   * and a promise to respect one.
   */
  sealDisclosure: (
    epoch: number,
    auditorPublicKey: string,
  ) => Promise<{ ok: boolean; sealed?: string; reason?: string }>;
  /** True only on testnet, where the tokens have an open faucet and no issuer to ask. */
  faucetAvailable: boolean;
  /** Minutes of no interaction before the vault locks itself. Zero disables it. */
  idleMinutes: number;
  setIdleMinutes: (minutes: number) => void;
  /** When the vault will lock if untouched, as epoch ms. Null when locked or disabled. */
  locksAt: number | null;
  /** Size of the whole commitment set — the anonymity set this vault hides in. */
  leafCount: number;
  /**
   * Distinct commitments in the tree, which is the crowd rather than the count.
   *
   * `leafCount` is `nextLeafIndex`, and a settlement splices a span-aligned block of 32 — so it
   * counts the zero leaves alignment skipped over, which hide nobody. Describing privacy needs
   * the number of real notes, not the height of the tree.
   */
  commitmentCount: number;
  /**
   * The 1e18-scaled reference for a registry asset id, or 0n when the market has not answered.
   *
   * Exposed so the order panel can run the same affordability arithmetic the submit path runs.
   * It is public data — the join between the registry's asset ids and the market snapshot's
   * symbols — and holds nothing the vault knows.
   */
  priceE18: (assetId: string) => bigint;
  /**
   * Writes this vault has sent, newest first, with their hashes.
   *
   * Kept because the panels used to throw them away: `shield` and `withdraw` both held a hash and
   * a receipt and returned `{ ok }`. On a live venue somebody who cannot retrieve their own
   * transaction hash has lost the only thing that lets them check what happened.
   *
   * Session-scoped and in memory. Persisting it would be a second record of this vault's activity
   * sitting in storage next to the one that already matters, for no gain — the chain has the
   * authoritative copy and the receipts panel reads the venue's.
   */
  transactions: VaultTransaction[];
  /** False until the pool is deployed. A zero balance then means "nothing exists yet". */
  deployed: boolean;
  /**
   * True while the pool could not be asked which notes are already spent.
   *
   * Notes are hidden rather than offered in that case, which is the safe direction — offering a
   * spent note costs its owner gas and a refused order. But a hidden balance and an empty one
   * look identical, and on a venue holding real money that is the worst thing a panel can be, so
   * it is said out loud and retried rather than left to be inferred.
   */
  spentUnknown: boolean;
  scanning: boolean;
  error: string | null;
  unlock: () => Promise<void>;
  lock: () => void;
  /**
   * Build and seal an order inside the worker, then submit it.
   *
   * The plaintext order never exists on the main thread: the worker derives the note from the
   * vault keys, seals the payload to the window's key, and returns only what the intake API is
   * allowed to see. Submission is fetched with `credentials: 'omit'` so no cookie ties the order
   * to a wallet address in our own request logs.
   */
  submitOrder: (order: {
    assetId: string;
    units: string;
    side: "buy" | "sell";
  }) => Promise<{ ok: boolean; reason?: string }>;
}

const Context = createContext<VaultValue | null>(null);

/**
 * What the pool will accept, read from `EligibleRegistry` rather than hardcoded.
 *
 * This used to be a literal map of testnet token addresses. A map like that survives a network
 * switch silently — the chain id changes, the addresses do not, and a mainnet deposit points at
 * a testnet stand-in. The registry is the contract `shield` itself consults, so asking it is the
 * only way the two cannot disagree.
 */
/** What `/api/orders/receipts` answers about one commitment. */
interface OrderReceipt {
  commitment: string;
  chainWindowId: string | null;
  fill: {
    reason: string;
    filledRaw: string;
    quoteRaw: string;
    assetId: number;
    side: string;
  } | null;
}

export interface PoolAsset {
  assetId: number;
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  isQuote: boolean;
}

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const poolAbi = [
  {
    type: "function",
    name: "nullifierSpent",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "shield",
    stateMutability: "nonpayable",
    inputs: [
      { type: "uint16" },
      { type: "uint128" },
      { type: "bytes32" },
      { type: "bytes" },
      { type: "bytes32[]" },
      { type: "bytes" },
    ],
    outputs: [{ type: "uint32" }],
  },
  {
    type: "function",
    name: "unshield",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          { name: "proof", type: "bytes" },
          { name: "root", type: "bytes32" },
          { name: "nullifier", type: "bytes32" },
          { name: "changeCommitment", type: "bytes32" },
          { name: "assetId", type: "uint16" },
          { name: "units", type: "uint128" },
          { name: "recipient", type: "address" },
          { name: "relayerFeeUnits", type: "uint128" },
          { name: "relayer", type: "address" },
          { name: "ciphertext", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

export { erc20Abi };

/**
 * `Omit<Union, K>` collapses a union to the keys its members share, which for `VaultRequest`
 * leaves only `type` — so the compiler rejects every real request. Distributing over the union
 * first keeps each variant's own fields.
 */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

interface LeavesResponse {
  deployed: boolean;
  pool?: string;
  retired?: boolean;
  leaves: string[];
  leafCount: number;
  reason?: string;
  error?: string;
}

/**
 * A note found in a pool the venue has retired.
 *
 * `RwaDarkPool` is immutable, so every fix is a new address and notes shielded into an older
 * pool stay there. They are not lost — `unshield` has no pause, no role and no window check, and
 * the retired pool's verifier is untouched — but nothing would ever show them again unless the
 * vault deliberately looked. A holder finding their balance silently gone is the worst version
 * of this, so they are surfaced and withdrawable, and only withdrawable: a retired pool takes no
 * new deposits and crosses nothing.
 */
export interface LegacyNote extends VaultNote {
  pool: `0x${string}`;
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();

  const worker = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, (r: VaultResponse) => void>());
  // `recover` is declared before `scan` and has to rescan once it has rebuilt the records.
  const scanRef = useRef<(() => Promise<void>) | null>(null);

  /**
   * Ask the pool which of these nullifiers it has already recorded.
   *
   * Read straight from `nullifierSpent` rather than from an indexer, because this decides
   * whether the app offers somebody money it believes they still have. A stale index here shows
   * a balance that is not there, and the correction arrives as a reverted transaction.
   */
  const nullifiersSpentIn = useCallback(
    async (pool: `0x${string}` | null, nullifiers: `0x${string}`[]): Promise<SpentResult> =>
      readSpent(nullifiers, {
        poolDeployed: Boolean(pool),
        // `readClient()`, not the wallet's client. This is a public read of a public mapping on a
        // known contract, and routing it through the wallet's connection meant it could not be
        // made at all during the moments wagmi had not resolved one — which is exactly when the
        // first scan runs, the instant the vault unlocks. `readSpent` then had to guess, and the
        // guess it used to make was "unspent", so a note already consumed by a settlement was
        // offered back to its owner and the venue refused it as already offered.
        read: pool
          ? async (list) =>
              (await readClient().multicall({
                contracts: list.map((n) => ({
                  address: pool,
                  abi: poolAbi,
                  functionName: "nullifierSpent" as const,
                  args: [n],
                })),
                allowFailure: false,
              })) as boolean[]
          : null,
      }),
    [],
  );
  const nextId = useRef(1);

  const [status, setStatus] = useState<VaultStatus>("locked");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [balances, setBalances] = useState<VaultBalance[]>([]);
  const [noteCount, setNoteCount] = useState(0);
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [shielding, setShielding] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  /**
   * Which stage a withdrawal is at, or null when none is running.
   *
   * A single field rather than a map because only one withdrawal can be in flight — `withdrawing`
   * is already a single boolean and the button is disabled while it is set.
   */
  const [proofPhase, setProofPhase] = useState<ProofPhase | null>(null);
  const [legacyNotes, setLegacyNotes] = useState<LegacyNote[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<VaultTransaction[]>([]);
  /**
   * True when the last scan could not reach the pool to ask which notes are spent.
   *
   * Every note is hidden while this holds, because offering a spent note costs its owner gas and
   * a refused order. That is only a defensible trade if it ends, so it drives a retry.
   */
  const [spentUnknown, setSpentUnknown] = useState(false);

  /**
   * Record a write, and hand back a function that closes it out.
   *
   * Two calls rather than one at the end, because the interesting state is the middle: a deposit
   * is two transactions and a wait, and a panel that only learns the outcome has nothing to show
   * for the thirty seconds in between except a disabled button.
   *
   * Capped at twenty. This is a session trail, not an archive — the ledger of record is the
   * chain, and an unbounded array in a provider that re-renders on every scan is a slow leak.
   */
  const recordTx = useCallback(
    (kind: VaultTransaction["kind"], detail: Partial<VaultTransaction>) => {
      const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setTransactions((prior) =>
        [{ id, kind, status: "pending" as const, at: Date.now(), ...detail }, ...prior].slice(
          0,
          20,
        ),
      );
      return (update: Partial<VaultTransaction>) =>
        setTransactions((prior) => prior.map((t) => (t.id === id ? { ...t, ...update } : t)));
    },
    [],
  );

  // Public data, so it loads whether or not the vault is open: the anonymity-set size is worth
  // showing even to someone who has not unlocked.
  const { data: tree } = useQuery({
    queryKey: ["note-leaves"],
    queryFn: async (): Promise<LeavesResponse> => {
      const res = await fetch("/api/notes/leaves", { credentials: "omit" });
      return (await res.json()) as LeavesResponse;
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: false,
  });

  // Retired pools, scanned separately. Their trees have stopped growing, so this is cheap and
  // rarely changes — but without it a holder whose notes predate a redeploy sees a balance of
  // zero and no explanation, which is the worst possible way to present funds that are fine.
  // What the pool accepts, straight from `EligibleRegistry` on the configured chain.
  const market = useMarket();

  const { data: poolAssets } = useQuery({
    queryKey: ["pool-assets", clientChainId()],
    queryFn: async (): Promise<PoolAsset[]> => {
      const res = await fetch("/api/pool/assets", { credentials: "omit" });
      const body = (await res.json()) as { assets?: PoolAsset[] };
      return body.assets ?? [];
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  /**
   * The 1e18-scaled reference for a registry asset id, or 0 when the market has not answered.
   *
   * `poolAssets` names assets by registry id and the market snapshot names them by symbol, so
   * this is the join between the two. `priceRaw` and not `price`: the float is for display and
   * rounds, and this number decides whether an order can be paid for.
   */
  const priceE18 = useCallback(
    (assetId: string): bigint => {
      const symbol = (poolAssets ?? []).find((a) => String(a.assetId) === assetId)?.symbol;
      const raw = market.snapshot?.assets.find((a) => a.symbol === symbol)?.priceRaw;
      return raw ? BigInt(raw) : 0n;
    },
    [poolAssets, market.snapshot],
  );

  const { data: legacyTrees } = useQuery({
    queryKey: ["note-leaves-legacy"],
    queryFn: async () => {
      const pools = clientDeployment().retiredPools;
      return Promise.all(
        pools.map(async (pool) => {
          const res = await fetch(`/api/notes/leaves?pool=${pool}`, { credentials: "omit" });
          return { pool, ...((await res.json()) as LeavesResponse) };
        }),
      );
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const ensureWorker = useCallback((): Worker | null => {
    if (worker.current) return worker.current;
    if (typeof Worker === "undefined") return null;
    // `new URL(..., import.meta.url)` is the form Vite compiles into a real worker chunk; a bare
    // string path would ship as an unresolved request that 404s only in production.
    const instance = new Worker(new URL("../../workers/vault.worker.ts", import.meta.url), {
      type: "module",
    });
    instance.addEventListener("message", (event: MessageEvent<VaultResponse>) => {
      // A progress message is not a reply. The same request still owes its real result, so the
      // pending handler has to survive — deleting it here would resolve `ask` with a phase name
      // and leave the actual proof with nowhere to go.
      if (event.data.type === "progress") {
        setProofPhase(event.data.phase);
        return;
      }
      pending.current.get(event.data.id)?.(event.data);
      pending.current.delete(event.data.id);
    });
    worker.current = instance;
    return instance;
  }, []);

  const ask = useCallback(
    (request: WithoutId<VaultRequest>): Promise<VaultResponse> => {
      const instance = ensureWorker();
      if (!instance) return Promise.reject(new Error("Web Workers are unavailable"));
      const id = nextId.current++;
      return new Promise((resolve) => {
        pending.current.set(id, resolve);
        instance.postMessage({ ...request, id } as VaultRequest);
      });
    },
    [ensureWorker],
  );

  /**
   * How long an unlocked vault stays unlocked with nobody touching it.
   *
   * Held here rather than in the panel so the timer survives a tab change — the dashboard
   * unmounts the Portfolio view when you look at the market, and a countdown owned by that view
   * would reset every time somebody checked a price, which is the opposite of what an idle
   * timeout is for.
   *
   * Persisted per browser rather than per vault: the setting is about the machine you are
   * sitting at, and the vault it protects is the one you have not opened yet.
   */
  const [idleMinutes, setIdleMinutesState] = useState(15);
  const [locksAt, setLocksAt] = useState<number | null>(null);

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem("arclite-idle-lock-minutes"));
      if (Number.isFinite(stored) && stored >= 0) setIdleMinutesState(stored);
    } catch {
      // Blocked storage. Fifteen minutes is a working default, not a failure.
    }
  }, []);

  const setIdleMinutes = useCallback((minutes: number) => {
    setIdleMinutesState(minutes);
    try {
      localStorage.setItem("arclite-idle-lock-minutes", String(minutes));
    } catch {
      /* the choice holds for this session either way */
    }
  }, []);

  const lock = useCallback(() => {
    // Terminate rather than only sending `lock`: destroying the worker discards its heap, which
    // is the one thing that reliably removes the key material from the process.
    void worker.current?.postMessage({ id: nextId.current++, type: "lock" } as VaultRequest);
    worker.current?.terminate();
    worker.current = null;
    pending.current.clear();
    setStatus("locked");
    setFingerprint(null);
    setBalances([]);
    setNoteCount(0);
    setNotes([]);
    setError(null);
    setLocksAt(null);
  }, []);

  /**
   * Rebuild this vault's deposit records from the chain.
   *
   * A note is found by regenerating it from (epoch, counter, assetId, units). The keys give the
   * first two; the last two exist only in the records this browser keeps — so a browser that has
   * never seen this vault, or one whose storage was cleared, scans the tree and honestly finds
   * nothing while the money sits there.
   *
   * The chain has the missing half. `Shielded` names the asset, the amount and the commitment,
   * and `shield` is a public transfer, so the depositor is the transaction sender. Given those,
   * the counter is the only unknown and it is a small integer — the worker tries them until the
   * commitment matches.
   *
   * Runs against retired pools too. A note left in one is still withdrawable from it, and a
   * holder recovering on a new browser has no way to know it is there.
   */
  const recover = useCallback(
    async (
      options: { dryRun?: boolean } = {},
    ): Promise<{
      ok: boolean;
      found?: number;
      onChain?: number;
      alreadyKnown?: number;
      reason?: string;
    }> => {
      if (status !== "unlocked" || !fingerprint) {
        return { ok: false, reason: "Open your vault first." };
      }
      if (!address) return { ok: false, reason: "Connect the wallet that made the deposits." };

      setScanning(true);
      try {
        const pools = [null, ...clientDeployment().retiredPools];
        const deposits: { assetId: string; units: string; commitment: string }[] = [];
        for (const pool of pools) {
          const url = pool
            ? `/api/notes/deposits?address=${address}&pool=${pool}`
            : `/api/notes/deposits?address=${address}`;
          const res = await fetch(url, { credentials: "omit" });
          const body = (await res.json()) as {
            deposits?: { assetId: number; units: string; commitment: string }[];
          };
          for (const d of body.deposits ?? []) {
            deposits.push({ assetId: String(d.assetId), units: d.units, commitment: d.commitment });
          }
        }
        if (deposits.length === 0) {
          return { ok: false, reason: "No deposits from this address were found on chain." };
        }

        // Generous: counters are dense from zero, so the bound only has to exceed the number of
        // deposits, and the search costs a hash per try.
        const response = await ask({
          type: "recover",
          deposits,
          maxCounter: deposits.length + 32,
        });
        if (response.type === "error") return { ok: false, reason: response.error };
        if (response.type !== "recovered") return { ok: false, reason: "the vault did not answer" };

        const existing = loadDeposits(fingerprint);
        const seen = new Set(existing.map((r) => `${r.epoch}:${r.counter}`));
        const fresh = response.records.filter((r) => !seen.has(`${r.epoch}:${r.counter}`));

        // The rehearsal runs everything above — the same log scan, the same counter search, the
        // same regeneration inside the worker — and stops here. It is a real recovery that is not
        // written down, which is the only kind worth trusting: a drill that took a shortcut would
        // prove the shortcut works.
        if (options.dryRun) {
          return {
            ok: true,
            onChain: deposits.length,
            found: response.records.length,
            alreadyKnown: response.records.length - fresh.length,
          };
        }

        // Merge rather than replace: a browser that still holds records keeps any the chain scan
        // could not place, and re-running this is never destructive.
        saveDeposits(fingerprint, [...existing, ...fresh]);
        await scanRef.current?.();
        return {
          ok: true,
          onChain: deposits.length,
          found: response.records.length,
          alreadyKnown: response.records.length - fresh.length,
        };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      } finally {
        setScanning(false);
      }
    },
    [status, fingerprint, address, ask],
  );

  const scan = useCallback(async () => {
    setScanning(true);
    // Set when the pool could not be asked which notes are spent. Every note is hidden in that
    // case, and the retry below is what keeps "hidden" from meaning "gone".
    let inconclusive = false;
    try {
      const response = await ask({
        type: "scan",
        leaves: tree?.leaves ?? [],
        // The notes this client knows it made. The worker regenerates each one from the viewing
        // key and looks for its commitment in the tree, so a deposit the browser forgot is
        // invisible here even though it is still in the pool and still spendable by anyone who
        // knows its counter.
        expected: fingerprint ? loadDeposits(fingerprint) : [],
      });
      if (response.type === "error") throw new Error(response.error);
      if (response.type !== "scanned") return;
      setBalances(response.balances);
      setNoteCount(response.confirmed.length);
      // Notes a crossing gave back.
      //
      // Settlement derives its outputs from the spent note's secret and the window id, not from
      // a counter — so nothing in `expected` can reach them and a vault that scans only deposits
      // is blind to everything it has traded into. The money sits in the pool, owed, and the
      // withdraw panel simply empties.
      //
      // The receipts endpoint already knows which note was spent where and what the fill was, so
      // the two output notes follow from it: the residual the order did not spend, and the leg
      // it received.
      const outputs: {
        parentEpoch: number;
        parentCounter: number;
        windowId: string;
        slot: 0 | 1;
        assetId: string;
        units: string;
      }[] = [];
      try {
        const firstPass = response.confirmed;
        const res = await fetch("/api/orders/receipts", {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commitments: firstPass.map((c) => c.commitment) }),
        });
        const body = (await res.json()) as { receipts?: OrderReceipt[] };
        const byCommitment = new Map(
          (body.receipts ?? []).map((r) => [r.commitment.toLowerCase(), r]),
        );
        for (const c of firstPass) {
          const r = byCommitment.get(c.commitment.toLowerCase());
          if (!r?.chainWindowId || !r.fill) continue;
          const quoteId = String(clientDeployment().quoteAssetId ?? "");
          const isSell = r.fill.side === "sell";
          const spent = isSell ? BigInt(r.fill.filledRaw) : BigInt(r.fill.quoteRaw);
          const parent = { parentEpoch: c.epoch, parentCounter: c.counter };
          outputs.push({
            ...parent,
            windowId: r.chainWindowId,
            slot: 0,
            // The residual keeps the funding asset; what it received is the other leg.
            assetId: c.assetId,
            units: (BigInt(c.units) - spent).toString(),
          });
          outputs.push({
            ...parent,
            windowId: r.chainWindowId,
            slot: 1,
            assetId: isSell ? quoteId : String(r.fill.assetId),
            units: isSell ? r.fill.quoteRaw : r.fill.filledRaw,
          });
        }
      } catch {
        // A venue that cannot be reached costs visibility of traded notes until the next scan,
        // not the notes themselves.
      }

      if (outputs.length > 0) {
        const second = await ask({
          type: "scan",
          leaves: tree?.leaves ?? [],
          expected: fingerprint ? loadDeposits(fingerprint) : [],
          outputs,
        });
        if (second.type === "scanned") response.confirmed = second.confirmed;
      }

      // Which of these the pool has already seen spent.
      //
      // The tree is append-only: a note consumed by a settlement keeps its leaf, so the scan
      // finds it exactly as it finds a live one. Offering it to be withdrawn produces a
      // transaction that reverts with `NullifierAlreadySpent` and costs the holder gas to
      // discover what the pool could have been asked.
      const spent = await nullifiersSpentIn(
        clientDeployment().pool as `0x${string}` | null,
        response.confirmed.map((c) => c.nullifier as `0x${string}`),
      );
      // An inconclusive read hides every note, which is the safe direction but only bearable if
      // it corrects itself. The flag drives a retry below; without it a single RPC blip during
      // the scan would empty the vault until the tree next grew, which on a quiet venue is hours.
      inconclusive = inconclusive || !spent.conclusive;
      const spentFlags = spent.flags;

      setNotes(
        response.confirmed.map((c, i) => ({
          epoch: c.epoch,
          counter: c.counter,
          assetId: c.assetId,
          units: c.units,
          leafIndex: c.leafIndex,
          commitment: c.commitment,
          nullifier: c.nullifier,
          origin: c.origin,
          spent: spentFlags[i] ?? true,
        })),
      );
      // And the retired pools. Separate scans because each has its own tree; the notes are
      // tagged with where they live so a withdrawal goes to the right contract.
      const stranded: LegacyNote[] = [];
      for (const legacy of legacyTrees ?? []) {
        if (!legacy.deployed || legacy.leaves.length === 0) continue;
        const found = await ask({
          type: "scan",
          leaves: legacy.leaves,
          expected: fingerprint ? loadDeposits(fingerprint) : [],
        });
        if (found.type !== "scanned") continue;
        // Each retired pool keeps its own nullifier set, so the question has to be asked of the
        // contract the note lives in rather than the current one.
        const legacyRead = await nullifiersSpentIn(
          legacy.pool as `0x${string}`,
          found.confirmed.map((c) => c.nullifier as `0x${string}`),
        );
        inconclusive = inconclusive || !legacyRead.conclusive;
        const legacySpent = legacyRead.flags;
        for (const [i, c] of found.confirmed.entries()) {
          stranded.push({
            epoch: c.epoch,
            counter: c.counter,
            assetId: c.assetId,
            units: c.units,
            commitment: c.commitment,
            nullifier: c.nullifier,
            origin: c.origin,
            spent: legacySpent[i] ?? true,
            leafIndex: c.leafIndex,
            pool: legacy.pool as `0x${string}`,
          });
        }
      }
      setLegacyNotes(stranded);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
      setSpentUnknown(inconclusive);
    }
  }, [ask, tree?.leaves, fingerprint, legacyTrees, nullifiersSpentIn]);

  scanRef.current = scan;

  const unlock = useCallback(async () => {
    if (!address) {
      setError("Connect MetaMask first.");
      return;
    }
    if (typeof Worker === "undefined") {
      setStatus("unavailable");
      setError("This browser cannot run the vault worker, so balances cannot be decrypted here.");
      return;
    }
    setStatus("unlocking");
    setError(null);
    try {
      const signature = await signMessageAsync({ message: vaultMessage(address) });
      const response = await ask({ type: "unlock", signature });
      if (response.type === "error") throw new Error(response.error);
      if (response.type !== "unlocked") throw new Error("the vault worker did not unlock");
      setFingerprint(response.fingerprint);
      setStatus("unlocked");
      await scan();
    } catch (e) {
      const message = (e as Error).message ?? "Could not open the vault.";
      setStatus("locked");
      setError(/user rejected|denied/i.test(message) ? "Signature declined." : message);
    }
  }, [address, signMessageAsync, ask, scan]);

  // Re-scan when the tree grows. Keys stay in the worker, so this costs a message, not a prompt.
  useEffect(() => {
    if (status === "unlocked") void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree?.leafCount, status]);

  /**
   * Ask again when the pool could not be reached.
   *
   * Without this the safe answer is a trap. An unreachable pool hides every note, and the only
   * other thing that re-scans is the tree growing — which on a quiet venue can be hours, so one
   * momentary RPC failure would leave somebody staring at an empty vault with their money in it
   * and no way to tell that from a real zero.
   *
   * Five seconds, and it repeats while the condition holds. The scan is a worker message and a
   * multicall, not a wallet prompt, so retrying costs nothing anyone can see.
   */
  useEffect(() => {
    if (status !== "unlocked" || !spentUnknown) return;
    const timer = setTimeout(() => void scan(), 5_000);
    return () => clearTimeout(timer);
  }, [spentUnknown, status, scan]);

  /**
   * Lock an untouched vault.
   *
   * The worker holds the keys and `lock()` terminates it, which is the one thing that reliably
   * removes them from the process — a good property nobody was told about, attached to a vault
   * that stayed open forever. On a shared machine that is the whole exposure.
   *
   * Activity is anything the person does, not anything the app does. Polling the venue, scanning
   * the tree and refreshing the market all happen on their own every few seconds; counting those
   * would mean the timer never fires and the setting is decoration.
   *
   * `visibilitychange` is deliberately *not* treated as activity either. Coming back to a tab
   * after an hour is exactly when the vault should have locked.
   *
   * Zero disables it, for somebody on a machine only they use who would rather not re-sign.
   */
  useEffect(() => {
    if (status !== "unlocked" || idleMinutes <= 0) {
      setLocksAt(null);
      return;
    }
    const window_ = globalThis as unknown as Window;
    const span = idleMinutes * 60_000;
    let deadline = Date.now() + span;
    setLocksAt(deadline);

    // The deadline moves on every event; the *state* moves rarely. `wheel` fires dozens of times
    // in a single scroll, and setting provider state on each one would re-render the vault, the
    // holdings and the order panel while somebody is simply reading the page.
    let published = deadline;
    const touched = () => {
      deadline = Date.now() + span;
      if (deadline - published >= 5_000) {
        published = deadline;
        setLocksAt(deadline);
      }
    };
    // `pointerdown` and `keydown` rather than `pointermove`: a cursor crossing the window while
    // somebody reads on another screen is not use, and treating it as such is how an idle lock
    // quietly never fires.
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window_.addEventListener(e, touched, { passive: true });

    const timer = setInterval(() => {
      if (Date.now() >= deadline) lock();
    }, 1_000);

    return () => {
      for (const e of events) window_.removeEventListener(e, touched);
      clearInterval(timer);
    };
  }, [status, idleMinutes, lock]);

  // Disconnecting or switching account must close the vault. Leaving it open would show one
  // account's balance while the wallet is pointed at another — the worst kind of wrong number.
  const lastAddress = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (status === "locked") {
      lastAddress.current = address;
      return;
    }
    if (!isConnected || (lastAddress.current && lastAddress.current !== address)) lock();
    lastAddress.current = address;
  }, [address, isConnected, status, lock]);

  /**
   * Shield tokens into the pool.
   *
   * Two transactions the trader signs themselves: an ERC-20 approval, then `shield`. The note's
   * commitment is computed inside the worker, so what reaches the chain is a hash — the pool
   * learns how much was deposited and in what asset, and nothing about the note beyond that.
   *
   * The deposit is recorded locally *before* the transaction is sent. If the write fails the
   * record is harmless — the scan simply will not find that commitment in the tree and reports
   * it unconfirmed. Recording afterwards would risk a confirmed deposit the browser has no
   * memory of, which is a note the trader can no longer see.
   */
  const shield = useCallback(
    async (assetId: string, units: string) => {
      if (status !== "unlocked" || !fingerprint) {
        return { ok: false, reason: "Open your private vault first." };
      }
      const deployed = clientDeployment();
      if (!deployed.pool) return { ok: false, reason: "The pool is not deployed on this network." };

      setShielding(true);
      setError(null);
      try {
        const records = loadDeposits(fingerprint);
        // Counters must not repeat for a vault: two notes at the same counter are the same note,
        // and the second deposit would be a duplicate commitment the pool already holds.
        const counter = records.reduce((max, r) => Math.max(max, r.counter), -1) + 1;

        const prepared = await ask({
          type: "prepare-deposit",
          epoch: 1,
          counter,
          assetId,
          units,
        });
        if (prepared.type === "error") return { ok: false, reason: prepared.error };
        if (prepared.type !== "deposit-prepared") {
          return { ok: false, reason: "the vault did not prepare a deposit" };
        }

        const token = (poolAssets ?? []).find((a) => String(a.assetId) === assetId)?.token;
        if (!token) {
          return {
            ok: false,
            reason: `asset ${assetId} is not registered in this pool`,
          };
        }

        const closeApproval = recordTx("approve", { assetId, units });
        let approval: `0x${string}`;
        try {
          approval = await writeContractAsync({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [deployed.pool as `0x${string}`, BigInt(units)],
          });
        } catch (e) {
          closeApproval({ status: "failed", error: (e as Error).message });
          throw e;
        }
        closeApproval({ hash: approval });
        await publicClient?.waitForTransactionReceipt({ hash: approval });
        closeApproval({ status: "confirmed", hash: approval });

        saveDeposits(fingerprint, [...records, { epoch: 1, counter, assetId, units }]);

        const closeDeposit = recordTx("deposit", { assetId, units });
        let hash: `0x${string}`;
        try {
          hash = await writeContractAsync({
            address: deployed.pool as `0x${string}`,
            abi: poolAbi,
            functionName: "shield",
            args: [
              Number(assetId),
              BigInt(units),
              prepared.commitment as `0x${string}`,
              "0x",
              [],
              "0x",
            ],
          });
        } catch (e) {
          closeDeposit({ status: "failed", error: (e as Error).message });
          throw e;
        }
        closeDeposit({ hash });
        const receipt = await publicClient?.waitForTransactionReceipt({ hash });
        if (receipt && receipt.status !== "success") {
          closeDeposit({ status: "failed", hash, error: "reverted on chain" });
          return { ok: false, reason: "the deposit reverted on chain" };
        }
        closeDeposit({ status: "confirmed", hash });

        await queryClient.invalidateQueries({ queryKey: ["note-leaves"] });
        await scan();
        return { ok: true, txHash: hash };
      } catch (e) {
        const message = (e as Error).message ?? "The deposit failed.";
        return {
          ok: false,
          reason: /user rejected|denied/i.test(message) ? "Transaction declined." : message,
        };
      } finally {
        setShielding(false);
      }
    },
    [
      status,
      fingerprint,
      ask,
      writeContractAsync,
      publicClient,
      queryClient,
      scan,
      poolAssets,
      recordTx,
    ],
  );

  const withdraw = useCallback(
    async (request: {
      note: VaultNote;
      units: string;
      recipient: `0x${string}`;
      pool?: `0x${string}`;
    }) => {
      if (status !== "unlocked") return { ok: false, reason: "Open your private vault first." };
      const target = request.pool ?? (clientDeployment().pool as `0x${string}` | null);
      if (!target) return { ok: false, reason: "The pool is not deployed on this network." };

      setWithdrawing(true);
      setError(null);
      try {
        // The leaf set of whichever pool holds the note. A retired pool has its own tree, and a
        // proof against the wrong one names a root the contract has never heard of.
        const isLegacy = target.toLowerCase() !== clientDeployment().pool?.toLowerCase();
        const leaves = isLegacy
          ? ((legacyTrees ?? []).find((l) => l.pool.toLowerCase() === target.toLowerCase())
              ?.leaves ?? [])
          : (tree?.leaves ?? []);
        if (leaves.length === 0) {
          return { ok: false, reason: "That pool's commitment set could not be read." };
        }

        // Counters must not repeat: two notes at the same counter are the same note, and the
        // second is unspendable. Derived from what this vault already holds rather than a clock.
        const used = [...notes, ...legacyNotes].map((n) => n.counter);
        const changeCounter = Math.max(request.note.counter, ...used, 0) + 1;

        const prepared = await ask({
          type: "prepare-unshield",
          epoch: request.note.epoch,
          counter: request.note.counter,
          assetId: request.note.assetId,
          noteUnits: request.note.units,
          origin: request.note.origin,
          leaves,
          units: request.units,
          recipient: request.recipient,
          changeCounter,
        });
        if (prepared.type === "error") return { ok: false, reason: prepared.error };
        if (prepared.type !== "unshield-prepared") {
          return { ok: false, reason: "the vault did not produce a proof" };
        }

        // Remember the change note *before* broadcasting. The note exists the moment the
        // transaction lands, and a browser that forgot its counter between sending and
        // confirming could never regenerate it — the units would be in the pool with nothing
        // able to point at them.
        if (prepared.change && fingerprint) {
          saveDeposits(fingerprint, [
            ...loadDeposits(fingerprint),
            {
              epoch: request.note.epoch,
              counter: prepared.change.counter,
              assetId: prepared.change.assetId,
              units: prepared.change.units,
            },
          ]);
        }

        // The proof is done and the wallet is next. The worker cannot know this stage, so the
        // main thread sets it.
        setProofPhase("broadcasting");
        const closeWithdraw = recordTx("withdraw", {
          assetId: request.note.assetId,
          units: request.units,
          provingMs: prepared.provingMs,
        });
        const hash = await writeContractAsync({
          address: target,
          abi: poolAbi,
          functionName: "unshield",
          args: [
            {
              proof: prepared.proof as `0x${string}`,
              root: prepared.root as `0x${string}`,
              nullifier: prepared.nullifier as `0x${string}`,
              changeCommitment: prepared.changeCommitment as `0x${string}`,
              assetId: prepared.assetId,
              units: BigInt(prepared.units),
              recipient: prepared.recipient as `0x${string}`,
              relayerFeeUnits: BigInt(prepared.relayerFeeUnits),
              relayer: prepared.relayer as `0x${string}`,
              ciphertext: "0x" as `0x${string}`,
            },
          ],
          // 8M, not 5M.
          //
          // Verification alone is ~2.6M, and inserting the change note costs ~1.1M more as the
          // tree fills. A 5M cap failed on chain with `gasUsed` exactly 5,000,000 while
          // `cast run` — which replays with a generous limit — reported the same transaction
          // successful, proof verified and tokens transferred. That is the 63/64 rule: the
          // verifier sub-call takes 63/64 of what is left, runs out, and the outer frame still
          // has enough gas to revert, so it reads as a logic failure rather than a gas one.
          //
          // An estimate is not safe here either — one came in short before, for the same reason.
          gas: 8_000_000n,
        });
        closeWithdraw({ hash });
        const receipt = await publicClient?.waitForTransactionReceipt({ hash });
        if (receipt && receipt.status !== "success") {
          closeWithdraw({ status: "failed", hash, error: "reverted on chain" });
          return { ok: false, reason: "the withdrawal reverted on chain" };
        }
        closeWithdraw({ status: "confirmed", hash });

        await queryClient.invalidateQueries({ queryKey: ["note-leaves"] });
        await queryClient.invalidateQueries({ queryKey: ["note-leaves-legacy"] });
        await scan();
        return { ok: true, txHash: hash, provingMs: prepared.provingMs };
      } catch (e) {
        const message = (e as Error).message ?? "The withdrawal failed.";
        return {
          ok: false,
          reason: /user rejected|denied/i.test(message) ? "Transaction declined." : message,
        };
      } finally {
        setWithdrawing(false);
        setProofPhase(null);
      }
    },
    [
      status,
      ask,
      notes,
      legacyNotes,
      legacyTrees,
      tree?.leaves,
      fingerprint,
      writeContractAsync,
      publicClient,
      queryClient,
      scan,
      recordTx,
    ],
  );

  const sealDisclosure = useCallback(
    async (epoch: number, auditorPublicKey: string) => {
      if (status !== "unlocked") return { ok: false, reason: "Open your private vault first." };
      const response = await ask({ type: "seal-disclosure", epoch, auditorPublicKey });
      if (response.type === "error") return { ok: false, reason: response.error };
      if (response.type !== "disclosure-sealed") {
        return { ok: false, reason: "the vault did not seal the key" };
      }
      return { ok: true, sealed: response.sealed };
    },
    [status, ask],
  );

  const submitOrder = useCallback(
    async (order: { assetId: string; units: string; side: "buy" | "sell" }) => {
      if (status !== "unlocked") return { ok: false, reason: "Open your private vault first." };
      try {
        const windowRes = await fetch("/api/orders/window-key", { credentials: "omit" });
        const win = (await windowRes.json()) as {
          windowSeq?: string;
          chainWindowId?: string;
          publicKey?: string;
          reason?: string;
        };
        if (!win.publicKey || !win.windowSeq || !win.chainWindowId) {
          return { ok: false, reason: win.reason ?? "No window is open for orders right now." };
        }

        // Which note funds the order, and can it pay for it.
        //
        // The whole check lives in `lib/order-preflight.ts` so the order panel can run exactly
        // the same arithmetic as you type. That is not a convenience: a preview computed
        // separately from the check is a preview that can disagree with it, and this check exists
        // because a buy of 1 NVDA funded by a $1 note failed the whole window — ten settle
        // attempts, `assert_max_bit_size` on a shortfall that range-checks as an enormous Field,
        // and every other order in that batch as collateral damage.
        const { quoteAssetId } = clientDeployment();
        const check = preflight({
          side: order.side,
          assetId: order.assetId,
          units: order.units,
          notes,
          poolAssets: poolAssets ?? [],
          quoteAssetId: quoteAssetId ?? null,
          priceE18,
        });
        if (!check.ok || !check.note) {
          return { ok: false, reason: check.reason ?? "That order cannot be funded." };
        }
        const note = check.note;

        const prepared = await ask({
          type: "prepare-order",
          windowPublicKey: win.publicKey,
          // The id the *pool* knows, not `seq`. The circuit verifies the spend signature
          // against it, so signing `seq` produces an order that submits, seals, prices and
          // matches and then fails to prove — with the trader long gone.
          windowId: win.chainWindowId,
          // The note's position in the pool's tree, which its nullifier is bound to.
          leafIndex: String(note.leafIndex),
          epoch: note.epoch,
          counter: note.counter,
          noteAssetId: note.assetId,
          noteUnits: note.units,
          // Which derivation rebuilds this note. Without it the worker assumes a deposit and
          // silently rebuilds the parent of any note a crossing returned.
          origin: note.origin,
          assetId: order.assetId,
          quantity: order.units,
          side: order.side,
        });
        if (prepared.type === "error") return { ok: false, reason: prepared.error };
        if (prepared.type !== "order-prepared")
          return { ok: false, reason: "the vault did not seal the order" };

        const res = await fetch("/api/orders/submit", {
          method: "POST",
          // No cookie: a session here would put the address-to-order link in our own logs.
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            windowSeq: win.windowSeq,
            accountHash: prepared.accountHash,
            commitment: prepared.commitment,
            nonceHash: prepared.nonceHash,
            payloadCt: prepared.payloadCt,
          }),
        });
        const body = (await res.json()) as { ok?: boolean; reason?: string };
        if (!body.ok) return { ok: false, reason: body.reason ?? "The venue refused the order." };

        // Nothing to record. An order is submitted under its note's commitment, and the vault
        // already knows every commitment it owns — so the outcome is found by asking about those
        // rather than by keeping a second list that could disagree with the first.
        await scan();
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message };
      }
    },
    [status, ask, notes, poolAssets, priceE18, scan],
  );

  useEffect(() => () => worker.current?.terminate(), []);

  return (
    <Context.Provider
      value={{
        status,
        fingerprint,
        balances,
        noteCount,
        notes,
        shield,
        shielding,
        leafCount: tree?.leafCount ?? 0,
        commitmentCount: (tree?.leaves ?? []).filter((l) => l !== "0").length,
        deployed: tree?.deployed ?? false,
        scanning,
        error,
        unlock,
        lock,
        submitOrder,
        withdraw,
        withdrawing,
        proofPhase,
        legacyNotes,
        poolAssets: poolAssets ?? [],
        recover,
        sealDisclosure,
        priceE18,
        transactions,
        spentUnknown,
        faucetAvailable: clientChainId() === 46630,
        idleMinutes,
        setIdleMinutes,
        locksAt,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useVault(): VaultValue {
  const value = useContext(Context);
  if (!value) throw Error("useVault must be used inside VaultProvider");
  return value;
}
