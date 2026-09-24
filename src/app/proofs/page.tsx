import { ProofLens } from "../components/protocol-controls";
import { useT } from "../lib/i18n";
import Link from "@/app/components/site-link";
import { Footer } from "../components/chrome";
import {
  ArticleOpening,
  ScrollReveals,
  StoryFrame,
  ChapterLinks,
  NextChapter,
} from "../components/editorial";
export const metadata = {
  title: "Public Proofs — ArcLite",
  description:
    "Pool solvency, auditor view keys and delayed aggregate reporting in ArcLite’s proposed privacy architecture.",
};
export default function Proofs() {
  const t = useT();
  return (
    <main data-route="/proofs" className="editorial-page" id="top">
      <ScrollReveals />
      <ArticleOpening
        number="04"
        title={t("Prove. Don’t reveal.")}
        subtitle={t("Accountability in the open. Individual orders kept private.")}
        figure="/assets/campaign-veil.webp"
        caption={t(
          "Privacy in ArcLite includes screening, solvency proofs and controlled disclosure. It does not mean exemption from asset rules or accountability.",
        )}
      />
      <ChapterLinks current="/proofs" />
      <ProofLens />
      <section className="article-body">
        <div className="article-lead">
          <span className="eyebrow">{t("THREE VIEWS OF ONE POOL")}</span>
          <h2>
            {t("What is public.")}
            <br />
            <em>{t("What is private.")}</em>
          </h2>
          <p>
            {t(
              "Different audiences need different information. ArcLite’s proposed architecture separates individual intentions from the evidence used to assess the pool.",
            )}
          </p>
        </div>
        <div className="numbered-editorial">
          <article>
            <span>01</span>
            <div>
              <h3>{t("Public epoch solvency")}</h3>
              <p>
                {t(
                  "Epoch-level solvency proofs demonstrate the pool’s solvency. Their role is accountability at the pool level, not publication of an individual trader’s order.",
                )}
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <h3>{t("Controlled disclosure")}</h3>
              <p>
                {t(
                  "Auditor view keys support scoped access for the parties entitled to inspect relevant information. Privacy and permitted disclosure coexist.",
                )}
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <h3>{t("Delayed aggregate tape")}</h3>
              <p>
                {t(
                  "Published aggregates provide a delayed view of crossed activity. This differs from a public live order book that reveals individual trading intentions.",
                )}
              </p>
            </div>
          </article>
        </div>
      </section>
      <StoryFrame
        chapter={t("THE PUBLIC RECORD")}
        title={t("The proof leaves.<br/>The order stays.")}
        figure="/assets/campaign-descent.webp"
        poster="/assets/campaign-horizon.webp"
        theme="lavender"
        copy={t(
          "The public record concerns pool solvency and delayed aggregate activity. Individual orders stay within the private execution process.",
        )}
        caption={t(
          "The dashboard checks pool solvency live against Robinhood Chain: balanceOf(pool) against the units it owes, per asset. That is an on-chain check anyone can repeat, not a zero-knowledge proof, and the page says which it is.",
        )}
      />
      <section className="proof-disclosure-paper">
        <span className="eyebrow">{t("A CLEARER VIEW")}</span>
        <h2>{t("Visibility, by purpose.")}</h2>
        <div className="disclosure-grid">
          <article>
            <span>{t("PUBLIC")}</span>
            <h3>{t("Pool-level evidence")}</h3>
            <p>{t("Epoch solvency proofs and delayed aggregate trade activity.")}</p>
          </article>
          <article>
            <span>{t("CONTROLLED")}</span>
            <h3>{t("Auditor disclosure")}</h3>
            <p>{t("Information made available through authorized view keys.")}</p>
          </article>
          <article>
            <span>{t("PRIVATE")}</span>
            <h3>{t("Individual intentions")}</h3>
            <p>{t("Sealed order details inside the private trading process.")}</p>
          </article>
        </div>
        <p className="source-note">
          {t(
            "The architecture is in development. These descriptions are drawn from the ArcLite product and backend specifications, not a claim of a completed audit or deployed proof system.",
          )}
        </p>
      </section>
      <NextChapter number="05" title={t("Enter the dashboard.")} href="/dashboard" />
      <Footer />
    </main>
  );
}
