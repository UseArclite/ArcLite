"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWriteContract } from "wagmi";
import { Copy, ExternalLink, Eye, FileSignature, ShieldCheck } from "lucide-react";
import { CHAINS, clientChainId, clientDeployment, readClient } from "@/lib/chain/chains";
import { useVault } from "./vault-provider";
import { useWindow } from "./market-provider";
import { Detail } from "./panel-detail";
import { useT } from "../lib/i18n";

/**
 * Handing one epoch to an auditor, and nothing else.
 *
 * `/proofs` has described controlled auditor disclosure as a property of this system since before
 * there was any way to perform it. The cryptography has been written and tested that whole time —
 * this is the control that uses it.
 *
 * What a grant hands over is `ivk_epoch = poseidon2(ivk, epoch)`. Every note's randomness derives
 * from the epoch key rather than the master one, so that key reconstructs exactly one epoch and
 * cannot walk backwards. **The scope is the key**, not a flag on a contract that somebody could
 * flip later — which is the whole difference between a disclosure boundary and a promise to
 * respect one.
 *
 * ## Two halves that fail independently
 *
 * Sealing is client-side and needs nothing deployed. The registry is the public, revocable,
 * timestamped record that a grant happened, and `grant` reverts with `UnknownAuditor` until
 * governance has registered the recipient — which on a venue with no auditors is every time.
 *
 * So the panel treats them separately. The box is always produced and always usable; the on-chain
 * record is offered only when the chain would actually accept it, because a button that reverts
 * teaches people that the feature is broken rather than that the step is missing.
 */

const registryAbi = [
  {
    type: "function",
    name: "grant",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint64" }, { type: "bytes" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "auditorList",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    // Field order matches the struct, which is not the order you would guess from the docs.
    type: "function",
    name: "auditors",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "encryptionKey", type: "bytes32" },
      { name: "name", type: "string" },
      { name: "active", type: "bool" },
      { name: "registeredAt", type: "uint64" },
    ],
  },
] as const;

interface Auditor {
  address: `0x${string}`;
  name: string;
  encryptionKey: `0x${string}`;
  active: boolean;
}

export function DisclosurePanel() {
  const t = useT();
  const vault = useVault();
  const { window: live } = useWindow();
  const { writeContractAsync } = useWriteContract();

  const [auditorKey, setAuditorKey] = useState("");
  const [chosenAuditor, setChosenAuditor] = useState("");
  const [epoch, setEpoch] = useState("");
  const [sealed, setSealed] = useState<{ epoch: number; hex: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<string | null>(null);

  const registry = clientDeployment().disclosureRegistry as `0x${string}` | null;
  const explorer = CHAINS[clientChainId()].blockExplorers.default.url;
  const currentEpoch = live?.epochSeq ?? null;
  const chosen = epoch === "" ? currentEpoch : Number(epoch);

  // Who the registry will accept a grant for. Read with `readClient` rather than the wallet's,
  // for the same reason the spent-note check is: this is public state and should not depend on a
  // connection lifecycle.
  const { data: auditors } = useQuery({
    queryKey: ["disclosure-auditors", registry, clientChainId()],
    enabled: Boolean(registry),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Auditor[]> => {
      const client = readClient();
      const list = (await client.readContract({
        address: registry!,
        abi: registryAbi,
        functionName: "auditorList",
      })) as readonly `0x${string}`[];
      const out: Auditor[] = [];
      for (const address of list) {
        const a = (await client.readContract({
          address: registry!,
          abi: registryAbi,
          functionName: "auditors",
          args: [address],
        })) as readonly [`0x${string}`, string, boolean, bigint];
        out.push({ address, encryptionKey: a[0], name: a[1], active: a[2] });
      }
      return out.filter((a) => a.active);
    },
  });

  const registered = auditors ?? [];
  const picked = registered.find((a) => a.address === chosenAuditor);
  // A registered auditor's key comes from the registry rather than from the field: it is the key
  // the contract itself published, so sealing to anything else would produce a box the recorded
  // grant does not match.
  const keyToUse = picked ? picked.encryptionKey : auditorKey.trim();

  async function seal() {
    setError(null);
    setSealed(null);
    setRecorded(null);
    if (chosen == null || !Number.isFinite(chosen) || chosen < 0) {
      setError("Choose which epoch to disclose.");
      return;
    }
    const result = await vault.sealDisclosure(chosen, keyToUse);
    if (!result.ok || !result.sealed) {
      setError(result.reason ?? "The vault could not seal that.");
      return;
    }
    setSealed({ epoch: chosen, hex: result.sealed });
  }

  async function record() {
    if (!sealed || !picked || !registry) return;
    setRecording(true);
    setError(null);
    try {
      const hash = await writeContractAsync({
        address: registry,
        abi: registryAbi,
        functionName: "grant",
        args: [picked.address, BigInt(sealed.epoch), sealed.hex as `0x${string}`],
      });
      setRecorded(hash);
    } catch (e) {
      const message = (e as Error).message ?? "The grant failed.";
      setError(/user rejected|denied/i.test(message) ? "Transaction declined." : message);
    } finally {
      setRecording(false);
    }
  }

  async function copy() {
    if (!sealed) return;
    try {
      await navigator.clipboard.writeText(sealed.hex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // The value is on screen either way; a dialog over it would be worse than silence.
    }
  }

  if (vault.status !== "unlocked") {
    return (
      <div className="receipt">
        <span>{t("CONTROLLED DISCLOSURE")}</span>
        <p className="ticket-note">
          {t("Open your vault to grant an auditor a scoped view of one epoch.")}
        </p>
      </div>
    );
  }

  return (
    <div className="disclosure-panel">
      <span className="eyebrow">{t("CONTROLLED DISCLOSURE")}</span>
      <p className="ticket-note">
        {t("A grant hands over one epoch's viewing key, and nothing else of yours.")}
      </p>

      <div className="sealed-order-fields">
        {registered.length > 0 ? (
          <label>
            <span>{t("Auditor")}</span>
            <select value={chosenAuditor} onChange={(e) => setChosenAuditor(e.target.value)}>
              <option value="">{t("Someone not on the registry…")}</option>
              {registered.map((a) => (
                <option key={a.address} value={a.address}>
                  {a.name} — {a.address.slice(0, 8)}…
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {!picked && (
          <label>
            <span>{t("Auditor's public key")}</span>
            <input
              value={auditorKey}
              placeholder="0x… (32 bytes)"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setAuditorKey(e.target.value)}
            />
          </label>
        )}
        <label>
          <span>{t("Epoch")}</span>
          <input
            value={epoch}
            inputMode="numeric"
            placeholder={currentEpoch != null ? String(currentEpoch) : "0"}
            onChange={(e) => setEpoch(e.target.value.replace(/\D/g, ""))}
          />
        </label>
      </div>

      <button className="seal-order-button" onClick={() => void seal()} disabled={!keyToUse}>
        <Eye size={16} />
        {t("Seal this epoch to that auditor")}
      </button>

      {error && (
        <p role="alert" className="ticket-error">
          {error}
        </p>
      )}

      {sealed && (
        <div className="disclosure-sealed" role="status">
          <p>
            <b>
              {t("Epoch")} {sealed.epoch} {t("sealed.")}
            </b>{" "}
            {t(
              "Only that auditor's secret key opens this, and it opens nothing else of yours. Hand it over however you already talk to them.",
            )}
          </p>
          <code title={sealed.hex}>{sealed.hex}</code>
          <div className="vault-deposit-actions">
            <button className="reset-demo" onClick={() => void copy()}>
              <Copy size={13} /> {copied ? t("Copied") : t("Copy the sealed key")}
            </button>
            {/* Offered only where the chain would accept it. */}
            {registry && picked && !recorded && (
              <button
                className="seal-order-button"
                onClick={() => void record()}
                disabled={recording}
              >
                <FileSignature size={15} />
                {recording ? t("Recording…") : t("Record this grant on chain")}
              </button>
            )}
          </div>
          {recorded && (
            <p className="ticket-note">
              {t("Recorded.")}{" "}
              <a href={`${explorer}/tx/${recorded}`} target="_blank" rel="noreferrer">
                {t("See the grant on chain")} <ExternalLink size={11} />
              </a>
            </p>
          )}
        </div>
      )}

      {/* What this can and cannot do here, said rather than implied by a button that reverts. */}
      <div className="guard-result" role="note">
        <ShieldCheck size={16} />
        <span>
          {!registry
            ? t(
                "There is no disclosure registry on this network, so there is no on-chain record of the grant. The sealed key works regardless: the registry publishes that a grant happened and lets you revoke its standing — it is not what makes the disclosure possible.",
              )
            : registered.length === 0
              ? t(
                  "The disclosure registry is deployed here, but no auditor is registered on it yet — so a grant cannot be recorded on chain and the sealed key is handed over directly. Registering an auditor publishes the key disclosures are sealed to, which is worth doing only for an auditor who actually holds the secret.",
                )
              : t(
                  "Grants to a registered auditor can be recorded on chain, where they are public, timestamped and revocable.",
                )}
        </span>
      </div>

      <Detail label={t("How scoping and revocation work")}>
        <p>
          {t(
            "A grant hands over one epoch's viewing key. It reconstructs that epoch's notes and no others, because every note's randomness derives from the epoch key rather than your master key — so the scope is the key itself, not a setting anyone can change afterwards.",
          )}
        </p>
        <p>
          {t(
            "Revocation is forward-only, wherever it is recorded. An auditor who has opened an epoch keeps what they learned — what a revocation changes is that the grant stops reading as current.",
          )}
        </p>
      </Detail>
    </div>
  );
}
