"use client";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { useVault } from "./vault-provider";
import { migrationPlan, MIGRATION_STEPS } from "../lib/migration";
import { displayAmount } from "../lib/units";
import { Detail } from "./panel-detail";
import { useT } from "../lib/i18n";

/**
 * Notes stranded one pool generation back, and what moving them costs.
 *
 * `RwaDarkPool` is immutable, so a fix is a new address and the old pool honours withdrawals
 * forever. Nothing told a holder their notes were in a retired pool at venue level, and nothing
 * said what moving them would cost — the Withdraw form labels them and stops there.
 *
 * There is no migration function and there should not be: an entry point that could mint a
 * commitment on another contract's word could mint one on anything. So this is two public
 * transactions, and the panel leads with that rather than offering a button that hides it.
 *
 * It deliberately does **not** automate the move. Both controls already exist a few rows below,
 * they work, and driving them from here would produce exactly the back-to-back withdrawal and
 * deposit that is the worst version of this — same amount, seconds apart. Somebody who has read
 * the cost should choose the gap themselves.
 */
export function PoolMigration() {
  const t = useT();
  const vault = useVault();

  const legacy = vault.legacyNotes.filter((n) => !n.spent);
  const plan = migrationPlan({
    legacy: legacy.map((n) => ({ pool: n.pool, assetId: n.assetId, units: n.units })),
    // The same figure the privacy meter uses: your own notes hide you from nobody.
    liveCrowd: Math.max(0, vault.commitmentCount - vault.notes.length),
    deployed: vault.deployed,
  });

  if (plan.idle) return null;

  const symbolOf = (assetId: string) =>
    vault.poolAssets.find((a) => String(a.assetId) === assetId)?.symbol ?? `asset ${assetId}`;
  const decimalsOf = (assetId: string) =>
    vault.poolAssets.find((a) => String(a.assetId) === assetId)?.decimals ?? 18;

  return (
    <div className={`pool-migration is-${plan.privacy}`}>
      <div className="pool-migration-top">
        <AlertTriangle size={15} />
        <span className="eyebrow">
          {plan.noteCount === 1
            ? t("1 NOTE IN A RETIRED POOL")
            : `${plan.noteCount} ${t("NOTES IN RETIRED POOLS")}`}
        </span>
      </div>

      <ul className="pool-migration-notes">
        {legacy.map((n) => (
          <li key={`${n.pool}-${n.leafIndex}`}>
            <b>
              {displayAmount(BigInt(n.units), decimalsOf(n.assetId))} {symbolOf(n.assetId)}
            </b>
            <small>
              {t("in")} {n.pool.slice(0, 10)}…
            </small>
          </li>
        ))}
      </ul>

      <p className="pool-migration-headline">{plan.headline}</p>
      <p className="ticket-note">{plan.reason}</p>
      {plan.advice && <p className="ticket-note">{plan.advice}</p>}

      <Detail label={t("How to move one, if you want to")}>
        <ol className="pool-migration-steps">
          {MIGRATION_STEPS.map((s, i) => (
            <li key={s.key}>
              <span aria-hidden="true">{i + 1}</span>
              <span>
                <b>{t(s.title)}</b>
                <small>{t(s.detail)}</small>
              </span>
            </li>
          ))}
        </ol>
        <p>
          {t(
            "Both controls are below: pick the retired note in Withdraw, then deposit into the live pool. They are not wired together on purpose — doing them back to back produces the same amount moving twice within a minute, which is the most linkable version of this. The gap is yours to choose.",
          )}
        </p>
      </Detail>

      <p className="pool-migration-foot">
        <ArrowRight size={12} aria-hidden="true" />
        {t("Your notes are safe where they are. A retired pool honours withdrawals forever.")}
      </p>
    </div>
  );
}
