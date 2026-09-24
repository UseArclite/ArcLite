import { ExecutionPlayer } from "../components/protocol-controls";
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
  title: "The Protocol — ArcLite",
  description:
    "How ArcLite’s proposed private pool screens assets, seals orders, crosses at guarded references and proves solvency.",
};
export default function Protocol() {
  const t = useT();
  return (
    <main data-route="/protocol" className="editorial-page" id="top">
      <ScrollReveals />
      <ArticleOpening
        number="02"
        title={t("The protocol.")}
        subtitle={t("A private path from intention to settlement.")}
        figure="/assets/campaign-protocol-ascent.webp"
        caption={t(
          "Sealed orders. Guarded references. Public pool-solvency proofs. Three parts of one proposed trading architecture.",
        )}
      />
      <ChapterLinks current="/protocol" />
      <ExecutionPlayer />
      <section className="article-body">
        <div className="article-lead">
          <span className="eyebrow">{t("THE ORDER’S JOURNEY")}</span>
          <h2>
            {t("From the world.")}
            <br />
            <em>{t("Into the private.")}</em>
          </h2>
          <p>
            {t(
              "ArcLite brings eligible real-world assets into a private pool, then crosses matched orders in batches. Each stage has a distinct responsibility.",
            )}
          </p>
        </div>
        <div className="numbered-editorial">
          {[
            [
              "01",
              "Enter the screened pool",
              "Eligible stock, ETF and treasury tokens are checked against the asset registry. Screening and jurisdiction requirements apply before an asset enters the pool.",
            ],
            [
              "02",
              "Commit a sealed order",
              "The order is represented privately. Stock references combine oracle prices with issuer multipliers; treasury references use published fund NAV.",
            ],
            [
              "03",
              "Cross the batch",
              "A trading window gathers sealed orders. Matched size crosses at the relevant guarded reference. A match is not guaranteed; residual orders may continue resting.",
            ],
            [
              "04",
              "Keep raw units",
              "Private notes record raw asset units. Issuer adjustments and treasury NAV update their reference values without rewriting every note.",
            ],
            [
              "05",
              "Publish the proof",
              "Epoch solvency proofs, controlled auditor disclosure and a delayed aggregate tape support accountability without exposing individual orders publicly.",
            ],
          ].map(([n, t, p]) => (
            <article key={n} className="reveal">
              <span>{n}</span>
              <div>
                <h3>{t}</h3>
                <p>{p}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
      <StoryFrame
        chapter={t("THE REFERENCE")}
        title={t("A price with a source.")}
        figure="/assets/campaign-protocol-messenger.webp"
        poster="/assets/bust.webp"
        theme="cyan"
        copy={t(
          "The proposed pricing commitment includes a stock oracle round and issuer multiplier, or a treasury NAV and its publication time.",
        )}
        caption={t(
          "A common reference informs the crossing. Freshness and event guards determine whether an asset can participate.",
        )}
      />
      <section className="article-body guards-explained" id="guards">
        <div className="article-lead">
          <span className="eyebrow">{t("ASSET-AWARE WINDOWS")}</span>
          <h2>
            {t("Know when")}
            <br />
            <em>to wait.</em>
          </h2>
          <p>{t("A valid price is more than a number. The surrounding asset state matters.")}</p>
        </div>
        <div className="numbered-editorial">
          {[
            [
              "I",
              "Reference freshness",
              "A stale oracle reference or an out-of-date NAV can defer the affected asset. Other assets do not need to share the same event schedule.",
            ],
            [
              "II",
              "Corporate actions",
              "Windows are designed to pause around relevant issuer multiplier activations and ex-dates, then resume when the updated reference is available.",
            ],
            [
              "III",
              "Fund publications",
              "Treasury valuation follows published NAV. Distributing funds need an adapter that accounts for distributions in raw units and epoch solvency.",
            ],
          ].map(([n, t, p]) => (
            <article key={n}>
              <span>{n}</span>
              <div>
                <h3>{t}</h3>
                <p>{p}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="roadmap-paper" id="roadmap">
        <span className="eyebrow">{t("PROPOSED ROADMAP / IN DEVELOPMENT")}</span>
        <h2>
          {t("One chapter")}
          <br />
          <em>at a time.</em>
        </h2>
        <div>
          {[
            [
              "A1",
              "The core",
              "Stock–treasury crossing, pool-solvency proofs and delayed aggregate reporting.",
            ],
            ["A2", "More crossing paths", "Stock pairs and bounded backstop liquidity."],
            ["A3", "Larger blocks", "ARCL-related mechanisms and RFQ block execution."],
            [
              "A4",
              "Planned expansion",
              "A treasury desk, baskets, an Arc/USYC lane, lending against shielded positions, agent execution and analytics.",
            ],
          ].map(([n, t, p]) => (
            <article key={n}>
              <span>{n}</span>
              <h3>{t}</h3>
              <p>{p}</p>
            </article>
          ))}
        </div>
        <p className="source-note">
          {t(
            "The source documents describe proposed architecture and staged plans. Features and integrations are not presented as live deployments.",
          )}
        </p>
      </section>
      <NextChapter number="03" title={t("The asset collection.")} href="/assets" />
      <Footer />
    </main>
  );
}
