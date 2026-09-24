import { NavLab } from "../components/protocol-controls";
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
  title: "Real-World Assets — ArcLite",
  description:
    "Tokenized equities, treasury quote assets and published NAV inside ArcLite’s proposed private market.",
};
export default function Assets() {
  const t = useT();
  return (
    <main data-route="/assets" className="editorial-page" id="top">
      <ScrollReveals />
      <ArticleOpening
        number="03"
        title={t("Real-world assets.")}
        subtitle={t("The asset. The reference. The other side of the trade.")}
        figure="/assets/campaign-flight.webp"
        caption={t(
          "ArcLite’s proposed core brings tokenized stocks and ETFs together with tokenized treasury quote assets.",
        )}
      />
      <ChapterLinks current="/assets" />
      <section className="asset-chapter">
        <div className="approved-poster reveal">
          <img
            loading="eager"
            decoding="sync"
            src="/assets/campaign-archway.webp"
            alt="Engraved angel statue framed in a stone archway against a pink and blue sky, fully framed"
          />
        </div>
        <div className="asset-chapter-copy">
          <span className="eyebrow">01 / TOKENIZED EQUITIES</span>
          <h2>
            {t("Stocks, carried")}
            <br />
            <em>into the pool.</em>
          </h2>
          <p>
            {t(
              "Eligible tokenized stocks and ETFs enter through an asset registry. Their reference values depend on an oracle price and the issuer’s applicable multiplier.",
            )}
          </p>
          <dl>
            <div>
              <dt>{t("Reference")}</dt>
              <dd>{t("Oracle × issuer multiplier")}</dd>
            </div>
            <div>
              <dt>{t("Private representation")}</dt>
              <dd>{t("Raw-unit asset notes")}</dd>
            </div>
            <div>
              <dt>{t("Event controls")}</dt>
              <dd>{t("Ex-dates and multiplier updates")}</dd>
            </div>
          </dl>
          <p>
            {t(
              "The venue lists every Robinhood tokenized equity that carries a Chainlink price feed — 35 of them today. An asset it cannot derive a guarded reference for is not eligible, however real it is.",
            )}
          </p>
        </div>
      </section>
      <StoryFrame
        chapter={t("02 / TOKENIZED TREASURIES")}
        title={t("A different kind of quote.")}
        figure="/assets/campaign-flight.webp"
        poster="/assets/campaign-veil.webp"
        theme="pink"
        reverse
        copy={t(
          "The intended quote asset is a treasury token. A stock sale can therefore receive treasury units, while resting quote balances remain valued against published fund NAV.",
        )}
        caption={t(
          "An accumulating treasury balance is valued as raw units × published NAV. Its unit count and reference value are different measures.",
        )}
      />
      <section className="nav-paper">
        <div>
          <span className="eyebrow">{t("UNDERSTANDING TREASURY VALUE")}</span>
          <h2>
            {t("Units × NAV.")}
            <br />
            <em>{t("Nothing invented.")}</em>
          </h2>
          <p>
            {t(
              "Published NAV is the valuation input. ArcLite does not need to invent a projected yield or fixed APY to show the reference value of treasury notes.",
            )}
          </p>
        </div>
        <NavLab />
      </section>
      <section className="article-body">
        <div className="article-lead">
          <span className="eyebrow">{t("AVAILABILITY & ACCESS")}</span>
          <h2>
            {t("Defined assets.")}
            <br />
            <em>{t("Defined boundaries.")}</em>
          </h2>
        </div>
        <div className="numbered-editorial">
          <article>
            <span>I</span>
            <div>
              <h3>{t("Registry first")}</h3>
              <p>
                {t(
                  "The proposed venue screens and registry-gates eligible assets. It is designed around securities-form RWAs, with jurisdiction restrictions including non-US eligibility in the source plans.",
                )}
              </p>
            </div>
          </article>
          <article>
            <span>II</span>
            <div>
              <h3>{t("Treasury availability")}</h3>
              <p>
                {t(
                  "The proposed primary deployment is Robinhood Chain. Treasury contracts, NAV sources and price feeds require verification before the intended lane is available.",
                )}
              </p>
            </div>
          </article>
          <article>
            <span>III</span>
            <div>
              <h3>{t("The fallback quote")}</h3>
              <p>
                {t(
                  "USDG is the documented fallback if the intended treasury lane is unavailable at launch. Treasury NAV accrual should not be assumed for that fallback.",
                )}
              </p>
            </div>
          </article>
        </div>
      </section>
      <NextChapter number="04" title={t("Public proofs. Private orders.")} href="/proofs" />
      <Footer />
    </main>
  );
}
