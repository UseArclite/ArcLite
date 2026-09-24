"use client";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleDot, Circle, Info } from "lucide-react";
import { useAccount } from "wagmi";
import { useVault } from "./vault-provider";
import { onboarding } from "../lib/onboarding";
import { useT } from "../lib/i18n";

/**
 * Where you are on the way to your first trade.
 *
 * The empty states were honest and disorienting at the same time: *"No shielded notes found for
 * this vault"* is true, is the expected state on arrival, and says nothing about what to do. The
 * sequence — connect, unlock, deposit, submit — was written down nowhere on the page.
 *
 * ## What it is careful not to do
 *
 * It disappears permanently once the path has been walked once, rather than sitting on the
 * dashboard as a nag for somebody who has been trading for a month. It shows the explanation only
 * for the step actually in hand, because four paragraphs of guidance is the density problem this
 * dashboard was just rebuilt to fix. And on a network with no pool it says so instead of
 * instructing somebody to deposit into something that does not exist — a confidently wrong
 * checklist would be worse than the bare empty state it replaced.
 *
 * "Has ever ordered" comes from the receipts query under the key the receipts panel already uses,
 * so the two share one response. It is `enabled` only when there are commitments to ask about,
 * which means a brand-new vault costs nothing at all.
 */
export function FirstRun() {
  const t = useT();
  const { isConnected } = useAccount();
  const vault = useVault();

  const commitments = [...vault.notes, ...vault.legacyNotes]
    .map((n) => n.commitment)
    .filter((c, i, all) => all.indexOf(c) === i)
    .reverse();

  const { data: receipts } = useQuery({
    // The receipts panel's key, deliberately: mounting this must not double the request.
    queryKey: ["order-receipts", commitments.join(",")],
    enabled: commitments.length > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<unknown[]> => {
      const res = await fetch("/api/orders/receipts", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commitments }),
      });
      const body = (await res.json()) as { receipts?: unknown[] };
      return body.receipts ?? [];
    },
  });

  const guide = onboarding({
    connected: isConnected,
    unlocked: vault.status === "unlocked",
    hasNotes: vault.notes.some((n) => !n.spent),
    hasOrdered: (receipts?.length ?? 0) > 0,
    deployed: vault.deployed,
  });

  if (guide.complete) return null;

  if (guide.unavailable) {
    return (
      <div className="first-run is-unavailable" role="note">
        <Info size={15} />
        <span>
          {t(
            "There is no pool on this network, so there is nothing to deposit into here. Your keys still derive and the vault still scans — it finds nothing because nothing exists yet.",
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="first-run">
      <span className="eyebrow">{t("YOUR FIRST TRADE")}</span>
      <ol>
        {guide.steps.map((step) => (
          <li key={step.key} className={`is-${step.state}`}>
            <span className="first-run-mark" aria-hidden="true">
              {step.state === "done" ? (
                <Check size={13} />
              ) : step.state === "current" ? (
                <CircleDot size={13} />
              ) : (
                <Circle size={13} />
              )}
            </span>
            <span className="first-run-body">
              <b>{t(step.title)}</b>
              {/* Only the step in hand explains itself. */}
              {step.state === "current" && <small>{t(step.detail)}</small>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
