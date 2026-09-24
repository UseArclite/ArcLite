"use client";
import { useState } from "react";
import { Check, ChevronDown, Minus } from "lucide-react";
import { useVault } from "./vault-provider";
import { assessPrivacy, LEVEL_LABEL } from "../lib/privacy";
import { Detail } from "./panel-detail";
import { useT } from "../lib/i18n";

/**
 * How private this position actually is, said plainly.
 *
 * The dashboard reported the anonymity set as a bare integer beside the words "Anonymity set",
 * which tells nobody whether 47 is a lot. It is not. The number that matters is how many notes
 * are *not yours*, and at launch that number is often zero — a state in which the pool hides
 * nothing at all and the old display said so only to someone who already knew.
 *
 * A panel that says "your privacy is currently weak" is an unusual thing to ship, and it is the
 * only version of this worth shipping. `plan.md` is explicit that the thin anonymity set must not
 * be oversold, and a venue whose entire pitch is that you can verify its claims cannot have its
 * privacy display be the one place that flatters.
 *
 * So the two structural limits are stated as limits and never scored away: `shield` is a public
 * transfer, and this venue reads a window's book after it seals. Neither improves with scale, and
 * the highest verdict available is "meaningful" rather than "strong" because of them.
 */
export function PrivacyMeter() {
  const t = useT();
  const vault = useVault();
  const [open, setOpen] = useState(false);

  if (vault.status !== "unlocked") return null;

  const assessment = assessPrivacy({
    commitments: vault.commitmentCount,
    // Spent notes still sit in the tree and still pad the crowd for everyone else, so they count
    // as the vault's own either way.
    yours: vault.notes.length,
    hasPosition: vault.balances.length > 0,
  });

  return (
    <section className={`privacy-meter is-${assessment.level}`}>
      <div className="privacy-top">
        <div>
          <span className="eyebrow">{t("PRIVACY, RIGHT NOW")}</span>
          <strong>{t(LEVEL_LABEL[assessment.level])}</strong>
        </div>
        <span className="privacy-set">
          <b>{assessment.setSize.toLocaleString("en-US")}</b>
          <small>{t("notes that are not yours")}</small>
        </span>
      </div>

      <p className="privacy-headline">{t(assessment.headline)}</p>

      <button className="privacy-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? t("Hide what this is made of") : t("What this is made of")}
        <ChevronDown size={13} className={open ? "is-open" : ""} />
      </button>

      {open && (
        <ul className="privacy-factors">
          {assessment.factors.map((f) => (
            <li key={f.title} className={f.good ? "is-good" : "is-limit"}>
              <span aria-hidden="true">{f.good ? <Check size={13} /> : <Minus size={13} />}</span>
              <span>
                <b>{t(f.title)}</b>
                <small>{t(f.detail)}</small>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Detail label={t("How this is measured")}>
        <p>
          {t(
            "Measured from this pool's commitment tree, which anyone can read. Two of these limits do not improve with scale, so there is no rating above “meaningful” here.",
          )}
        </p>
      </Detail>
    </section>
  );
}
