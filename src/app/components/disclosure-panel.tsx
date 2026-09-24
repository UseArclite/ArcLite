"use client";
import { useState } from "react";
import { Copy, Eye, ShieldCheck } from "lucide-react";
import { clientDeployment } from "@/lib/chain/chains";
import { useVault } from "./vault-provider";
import { useWindow } from "./market-provider";
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
 * ## Why this does not write to the chain here
 *
 * `DisclosureRegistry` is deployed on testnet and not on mainnet, and its `grant` requires the
 * auditor to have been registered by governance first. Neither is true on the network this
 * dashboard talks to, and no auditor exists to register.
 *
 * Sealing does not need any of that. The box is produced in the vault worker and handed over
 * however the two parties already communicate; the registry adds a public, revocable, timestamped
 * record of a grant that has happened. So the sealing works now and the panel says plainly which
 * half is missing, rather than offering a button that would revert.
 */
export function DisclosurePanel() {
  const t = useT();
  const vault = useVault();
  const { window: live } = useWindow();

  const [auditorKey, setAuditorKey] = useState("");
  const [epoch, setEpoch] = useState("");
  const [sealed, setSealed] = useState<{ epoch: number; hex: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const registry = clientDeployment().disclosureRegistry;
  const currentEpoch = live?.epochSeq ?? null;
  const chosen = epoch === "" ? currentEpoch : Number(epoch);

  async function seal() {
    setError(null);
    setSealed(null);
    if (chosen == null || !Number.isFinite(chosen) || chosen < 0) {
      setError("Choose which epoch to disclose.");
      return;
    }
    const result = await vault.sealDisclosure(chosen, auditorKey.trim());
    if (!result.ok || !result.sealed) {
      setError(result.reason ?? "The vault could not seal that.");
      return;
    }
    setSealed({ epoch: chosen, hex: result.sealed });
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
        {t(
          "A grant hands over one epoch's viewing key. It reconstructs that epoch's notes and no others, because every note's randomness derives from the epoch key rather than your master key — so the scope is the key itself, not a setting anyone can change afterwards.",
        )}
      </p>

      <div className="sealed-order-fields">
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

      <button
        className="seal-order-button"
        onClick={() => void seal()}
        disabled={!auditorKey.trim()}
      >
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
          <button className="reset-demo" onClick={() => void copy()}>
            <Copy size={13} /> {copied ? t("Copied") : t("Copy the sealed key")}
          </button>
        </div>
      )}

      {/* What this cannot do here, said rather than implied by a button that would revert. */}
      <div className="guard-result" role="note">
        <ShieldCheck size={16} />
        <span>
          {registry
            ? t(
                "A public, revocable record of this grant can also be written to the disclosure registry on this network — once governance has registered the auditor.",
              )
            : t(
                "There is no disclosure registry deployed on this network, so there is no on-chain record of the grant. The sealed key above works regardless: the registry publishes that a grant happened and lets you revoke its standing, it is not what makes the disclosure possible.",
              )}
        </span>
      </div>

      <p className="ticket-note">
        {t(
          "Revocation is forward-only, wherever it is recorded. An auditor who has opened an epoch keeps what they learned — what a revocation changes is that the grant stops reading as current.",
        )}
      </p>
    </div>
  );
}
