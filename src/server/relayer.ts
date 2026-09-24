import { createWalletClient, createPublicClient, http, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, resolveChainId, type SupportedChainId } from "@/lib/chain/chains";

/**
 * The server's signing identity.
 *
 * This is the custody-adjacent part of the system: a key in an environment variable that can
 * send transactions. Three things keep that honest.
 *
 * **1. It cannot become the mainnet signer by accident.** `assertKeyPolicy` refuses to produce a
 * relayer on chain 4663 from a plaintext key unless `ARCLITE_MAINNET_PLAINTEXT_RELAYER` says so
 * in words. A checklist is not a control; this is the control. It throws rather than warning,
 * because a warning in a serverless log is a warning nobody reads.
 *
 * That variable is the honest shape of a decision that has been taken: this venue runs on
 * mainnet with a hot key held by Vercel, because there is no hardware module behind it. The
 * gate's job is to make that something somebody typed on purpose — not something that happened
 * because an environment variable got copied from one project to another.
 *
 * `KMS_KEY_ID` used to satisfy the gate on its own, and that was worse than having no gate.
 * Nothing in this file has ever signed through KMS, so setting it switched the check off while
 * changing nothing whatsoever about how transactions are signed — a control that reads as "the
 * key is in a hardware module" and means "somebody typed a variable name". It now means what it
 * says: set it, and the relayer refuses to start until there is a KMS account to honour it.
 *
 * **2. It can do far less than the deployer.** The relayer only needs `SEALER_ROLE` and
 * `PRICER_ROLE` — sealing a window and pricing it. It is deliberately not the pool's admin, so a
 * leaked relayer key cannot change verifiers, pause the venue, or delist an asset. On testnet the
 * two are the same account, which is a real weakening and is recorded as such rather than
 * glossed over.
 *
 * **3. Nonces are serialised by the tick lock, not by the RPC.** `plan.md` is right that
 * `eth_getTransactionCount('pending')` is racy across concurrent stateless invocations — but the
 * tick holds `tryLock('tick', 55)` for its whole run, so only one invocation is ever sending.
 * That lock *is* the mutual exclusion. The Postgres nonce authority the plan describes is still
 * needed once anything sends outside the tick, and that is not yet true.
 */

export class RelayerUnavailable extends Error {}

/** The phrase `ARCLITE_MAINNET_PLAINTEXT_RELAYER` has to carry to unlock a hot mainnet key. */
export const PLAINTEXT_ACK = "i-accept-a-hot-key-on-mainnet";

/** True when mainnet signing runs on a plaintext key by deliberate configuration. */
export function plaintextRelayerAccepted(): boolean {
  return process.env.ARCLITE_MAINNET_PLAINTEXT_RELAYER === PLAINTEXT_ACK;
}

/** Throws unless it is safe to sign on this chain with the key material configured. */
export function assertKeyPolicy(chainId: number, hasPlaintextKey: boolean): void {
  const isMainnet = chainId === 4663;
  if (!isMainnet) return;

  // Set-but-unimplemented is the one combination that has to fail loudly. Whoever set this
  // believes the key is in a hardware module. It is not, and they should learn that here rather
  // than from a leak.
  if (process.env.KMS_KEY_ID) {
    throw new RelayerUnavailable(
      "KMS_KEY_ID is set, but this build has no KMS account — it would still sign with " +
        "RELAYER_PRIVATE_KEY. Unset KMS_KEY_ID, or wire a KMS signer before setting it.",
    );
  }

  if (hasPlaintextKey && !plaintextRelayerAccepted()) {
    throw new RelayerUnavailable(
      "refusing to sign on Robinhood Chain mainnet with a plaintext RELAYER_PRIVATE_KEY. " +
        `Set ARCLITE_MAINNET_PLAINTEXT_RELAYER=${PLAINTEXT_ACK} to accept a hot key, ` +
        "or do not run the relayer on mainnet.",
    );
  }
}

export interface Relayer {
  address: Address;
  chainId: SupportedChainId;
  /** Send and wait. Throws on revert — a receipt is returned for failures too. */
  send: (args: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    gas?: bigint;
  }) => Promise<Hash>;
  read: ReturnType<typeof createPublicClient>;
}

let cached: Relayer | null = null;

export function hasRelayer(): boolean {
  return Boolean(process.env.RELAYER_PRIVATE_KEY);
}

export function relayer(): Relayer {
  if (cached) return cached;

  const key = process.env.RELAYER_PRIVATE_KEY;
  if (!key) throw new RelayerUnavailable("RELAYER_PRIVATE_KEY is not set");

  const chainId = resolveChainId();
  assertKeyPolicy(chainId, true);

  const chain = CHAINS[chainId];
  const account = privateKeyToAccount(key as `0x${string}`);
  const wallet = createWalletClient({ account, chain, transport: http() });
  const read = createPublicClient({ chain, transport: http() });

  cached = {
    address: account.address,
    chainId,
    read,
    send: async (args) => {
      const hash = await wallet.writeContract({
        ...args,
        abi: args.abi as never,
        args: (args.args ?? []) as never,
        account,
        chain,
      } as never);
      const receipt = await read.waitForTransactionReceipt({ hash });
      // A reverted transaction still returns a receipt. Awaiting it without checking `status`
      // reports success for a failed call — which hid three queued deposits during the first
      // live settlement run and cost an hour chasing the wrong bug.
      if (receipt.status !== "success") {
        throw new Error(`${args.functionName} reverted on chain: ${hash}`);
      }
      return hash;
    },
  };
  return cached;
}
