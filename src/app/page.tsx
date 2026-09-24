"use client";
import Link from "@/app/components/site-link";
import { Footer } from "./components/chrome";
import { ContractAddress } from "./components/contract-address";
import { useT } from "./lib/i18n";
import { ScrollReveals, StoryFrame, ChapterLinks, NextChapter } from "./components/editorial";
import { ArrowDown, ArrowUpRight } from "lucide-react";
export default function Home() {
  const t = useT();
  return (
    <main data-route="/" id="top">
      <ScrollReveals />
      <section className="hero" id="experience">
        <div className="hero-sky" />
        <div className="hero-grain" />
        <div className="hero-title">
          <ContractAddress />
          <p>{t("THE AGE OF")}</p>
          <h1>ARCLITE</h1>
          <span>{t("PRIVATE EXECUTION. REAL-WORLD VALUE.")}</span>
        </div>
        <div className="hero-art-layer">
          <img
            loading="eager"
            decoding="sync"
            className="hero-messenger"
            src="/assets/hermes.webp"
            alt="Engraved winged Greek messenger carrying a sealed orb"
          />
        </div>
        <div className="hero-bottom">
          <p>
            {t("A NEW CHAPTER")}
            <br />
            {t("IN PRIVATE RWA TRADING")}
          </p>
          <a href="#journey" className="scroll-cue">
            {t("Scroll to enter")} <ArrowDown size={23} />
          </a>
          <p>
            {t("STOCKS. TREASURIES.")}
            <br />
            {t("A SHARED HORIZON.")}
          </p>
        </div>
        <div className="paper-edge" />
      </section>
      <section id="journey" className="intro-panel">
        <span className="eyebrow reveal">{t("I — THE THRESHOLD")}</span>
        <h2 className="reveal">
          {t("Real-world assets.")}
          <br />
          <em>{t("Beyond the visible.")}</em>
        </h2>
        <p className="reveal">
          {t("Every order begins with an intention.")}
          <br />
          {t("Some things are better kept to yourself.")}
        </p>
        <div className="comic-spread reveal">
          <div className="comic-clouds" />
          <img
            loading="eager"
            decoding="sync"
            className="comic-hero"
            src="/assets/hermes.webp"
            alt="Winged messenger crossing a celestial landscape"
          />
          <div className="caption caption-one">
            <span>01 / A PRIVATE INTENTION</span>
            {t(
              "ArcLite is designed for tokenized stocks and ETFs to meet treasury assets in a screened private pool.",
            )}
          </div>
          <div className="caption caption-two">
            {t("Your order enters sealed.")}
            <br />
            <strong>{t("The market sees no individual intent.")}</strong>
          </div>
          <span className="panel-number">I.</span>
        </div>
      </section>
      <section className="landing-context">
        <div className="context-heading reveal">
          <span className="eyebrow">{t("THE MARKET, RECONSIDERED")}</span>
          <h2>
            {t("Real-world value.")}
            <br />
            <em>{t("On both sides.")}</em>
          </h2>
        </div>
        <div className="context-copy reveal">
          <p>
            {t(
              "ArcLite is a private trading protocol designed around real-world assets. Tokenized stocks and ETFs cross against tokenized treasuries, so the quote side of a trade can remain invested in a treasury asset.",
            )}
          </p>
          <p>
            {t(
              "Orders gather in sealed batches. Matched size crosses at guarded reference prices, while public proofs and controlled disclosure support accountability.",
            )}
          </p>
          <Link href="/protocol" className="text-button">
            {t("READ THE PROTOCOL")} <ArrowUpRight size={16} />
          </Link>
        </div>
      </section>
      <StoryFrame
        eager
        chapter={t("II — THE CROSSING")}
        title={t("Intent stays private.")}
        figure="/assets/campaign-veil.webp"
        poster="/assets/campaign-veil.webp"
        theme="cyan"
        copy={t(
          "Orders enter a sealed batch. The protocol matches eligible size against a common reference, without exposing individual orders in a public order book.",
        )}
        caption={t(
          "Stocks reference oracle prices and issuer adjustments. Treasuries reference published fund NAV.",
        )}
      />
      <section className="editorial-strip">
        <article>
          <span>01 / ENTER</span>
          <h3>{t("A screened pool.")}</h3>
          <p>
            {t(
              "Eligible assets enter through a registry. Access is subject to screening, asset rules and jurisdiction eligibility.",
            )}
          </p>
        </article>
        <article>
          <span>02 / CROSS</span>
          <h3>{t("A guarded price.")}</h3>
          <p>
            {t(
              "Stale references, multiplier changes and relevant corporate actions can defer an asset’s trading window.",
            )}
          </p>
        </article>
        <article>
          <span>03 / HOLD</span>
          <h3>{t("A treasury balance.")}</h3>
          <p>
            {t(
              "Resting treasury notes track published fund value. Raw units stay constant as NAV updates their reference value.",
            )}
          </p>
        </article>
      </section>
      <StoryFrame
        eager
        chapter={t("III — THE RESERVE")}
        title={t("Value does not stand still.")}
        figure="/assets/campaign-flight.webp"
        poster="/assets/campaign-horizon.webp"
        theme="pink"
        reverse
        copy={t(
          "The treasury is the quote asset. A resting balance is valued as raw units multiplied by published NAV, inside the private pool.",
        )}
        caption={t(
          "No fixed APY. No projected yield. Published fund value provides the reference.",
        )}
      />
      <section className="asset-editorial">
        <div className="asset-editorial-heading reveal">
          <span className="eyebrow">{t("THE ASSET COLLECTION")}</span>
          <h2>
            {t("Stocks.")}
            <br />
            {t("Treasuries.")}
            <br />
            <em>{t("One private venue.")}</em>
          </h2>
          <p>
            {t(
              "The proposed core pairs tokenized equities with a treasury quote asset. Each side has its own reference source and eligibility requirements.",
            )}
          </p>
          <Link href="/assets" className="text-button">
            {t("EXPLORE THE ASSETS")} <ArrowUpRight size={16} />
          </Link>
        </div>
        <div className="approved-poster reveal">
          <img
            loading="eager"
            decoding="sync"
            src="/assets/campaign-horizon.webp"
            alt="Engraved wings opening over a pink cloud horizon"
          />
          <span>{t("ARCLITE / REAL-WORLD ASSETS")}</span>
        </div>
      </section>
      <StoryFrame
        chapter={t("IV — THE REVELATION")}
        title={t("Prove. Don’t reveal.")}
        figure="/assets/campaign-revelation.webp"
        poster="/assets/campaign-horizon.webp"
        theme="lavender"
        copy={t(
          "Public epoch proofs demonstrate the pool’s solvency. Individual orders remain private, with view keys available for controlled auditor disclosure.",
        )}
        caption={t(
          "A delayed aggregate tape reports the wider activity. Individual order intentions remain sealed.",
        )}
      />
      <section className="landing-details">
        <div>
          <span className="eyebrow">{t("PRIVATE ≠ UNACCOUNTABLE")}</span>
          <h2>
            {t("Privacy, with")}
            <br />
            <em>clear boundaries.</em>
          </h2>
        </div>
        <div className="detail-list">
          <article>
            <h3>{t("Public solvency")}</h3>
            <p>
              {t(
                "Epoch-level proofs are designed to demonstrate the pool’s solvency without publishing every order.",
              )}
            </p>
            <Link href="/proofs">
              {t("Explore public proofs")} <ArrowUpRight size={15} />
            </Link>
          </article>
          <article>
            <h3>{t("Asset-aware windows")}</h3>
            <p>
              {t(
                "The scheduler accounts for reference freshness, issuer multiplier updates, ex-dates and NAV publication times.",
              )}
            </p>
            <Link href="/protocol#guards">
              {t("Understand the guards")} <ArrowUpRight size={15} />
            </Link>
          </article>
          <article>
            <h3>{t("A staged rollout")}</h3>
            <p>
              {t(
                "Core stock–treasury crossing comes first. Stock pairs, bounded backstop liquidity and RFQ blocks are described as later stages.",
              )}
            </p>
            <Link href="/protocol#roadmap">
              {t("Read the roadmap")} <ArrowUpRight size={15} />
            </Link>
          </article>
        </div>
      </section>
      <ChapterLinks />
      <NextChapter number="V" title={t("Inside the protocol.")} href="/protocol" />
      <Footer />
    </main>
  );
}
