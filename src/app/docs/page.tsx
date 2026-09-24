import Link from "@/app/components/site-link";
import { Footer } from "../components/chrome";
import {
  ArticleOpening,
  ScrollReveals,
  StoryFrame,
  ChapterLinks,
  NextChapter,
} from "../components/editorial";
import { ARCLITE, CONTRACTS } from "@/lib/chain/chains";
import { useT } from "../lib/i18n";

/**
 * The reference page.
 *
 * The other chapters are written to persuade; this one is written to be checked. Every claim it
 * makes is either verifiable against the chain or stated as a limitation, and the addresses are
 * here so a reader can go and confirm the solvency figures rather than take them from us.
 *
 * Deliberately absent: anything operational. No relayer or deployer addresses, no infrastructure,
 * no environment. Contract addresses belong on a page like this — they are the handles the whole
 * accountability argument rests on — and an operator's signing account does not.
 */

export const metadata = {
  title: "Documentation — ArcLite",
  description:
    "How ArcLite's private batch auction works on Robinhood Chain: sealed orders, committed references, on-chain settlement and withdrawals that need no operator.",
};

const MAINNET = ARCLITE[4663];

export default function Docs() {
  const t = useT();
  return (
    <main data-route="/docs" className="editorial-page" id="top">
      <ScrollReveals />
      <ArticleOpening
        number="05"
        title={t("Documentation.")}
        subtitle={t("How the venue works, what it guarantees, and what it does not.")}
        figure="/assets/campaign-horizon.webp"
        caption={t(
          "A reference for reading the venue, not a description of it. Every figure below can be checked against Robinhood Chain.",
        )}
      />
      <ChapterLinks current="/docs" />

      <section className="article-body">
        <div className="article-lead">
          <span className="eyebrow">{t("WHAT IT IS")}</span>
          <h2>
            {t("A private")}
            <br />
            <em>batch auction.</em>
          </h2>
          <p>
            {t(
              "ArcLite crosses tokenized real-world assets in sealed batches on Robinhood Chain. Orders are encrypted until the book closes, priced from references the contract reads itself, matched, proved, and settled on chain — with nothing per-order published.",
            )}
          </p>
        </div>
        <div className="numbered-editorial">
          <article>
            <span>I</span>
            <div>
              <h3>{t("Orders are sealed")}</h3>
              <p>
                {t(
                  "An order is built and encrypted inside your browser and sent without a cookie or an address. What reaches the venue is a commitment and a ciphertext. Nothing in the request links it to your wallet.",
                )}
              </p>
            </div>
          </article>
          <article>
            <span>II</span>
            <div>
              <h3>{t("The book closes before prices are read")}</h3>
              <p>
                <code>sealWindow</code> freezes the set of orders on chain. Only then does the price
                committer read each feed and publish the table the window will cross at. The
                ordering is the point: nobody, operator included, can see the book and then choose
                the reference.
              </p>
            </div>
          </article>
          <article>
            <span>III</span>
            <div>
              <h3>{t("Everyone crosses at one price")}</h3>
              <p>
                {t(
                  "Within a window an asset has a single reference, taken from Chainlink and the issuer’s multiplier. There is no queue to be early in and no spread to be on the wrong side of. Where demand and supply do not match, fills are pro-rata.",
                )}
              </p>
            </div>
          </article>
          <article>
            <span>IV</span>
            <div>
              <h3>{t("Settlement proves the crossing")}</h3>
              <p>
                {t(
                  "A zero-knowledge proof shows the batch was consistent — notes existed, nothing was spent twice, value was conserved at the committed reference, no guarded asset crossed — without revealing a single order. The contract verifies it before anything moves.",
                )}
              </p>
            </div>
          </article>
        </div>
      </section>

      <StoryFrame
        chapter={t("THE GUARANTEE THAT MATTERS")}
        title={t("You can always leave.")}
        figure="/assets/campaign-descent.webp"
        poster="/assets/campaign-veil.webp"
        theme="cyan"
        copy={t(
          "Withdrawal carries no pause, no role and no window check. The pool accepts a valid proof from anyone, so a holder can exit while the venue is stopped, the asset is delisted, and the operator is gone.",
        )}
        caption={t(
          "The proof is generated in your browser, from keys that never leave it. A server that could prove your withdrawal could also spend your note — which is why no server has one.",
        )}
      />

      <section className="article-body">
        <div className="article-lead">
          <span className="eyebrow">{t("WHAT IS PRIVATE")}</span>
          <h2>
            {t("Private is not")}
            <br />
            <em>a synonym for hidden.</em>
          </h2>
          <p>
            {t(
              "Full zero-knowledge does not make a venue unaccountable, and it does not hide everything from everyone. This is who sees what, stated plainly, including the parts that are less private than the word suggests.",
            )}
          </p>
        </div>
        <div className="numbered-editorial">
          <article>
            <span>01</span>
            <div>
              <h3>{t("The public sees commitments")}</h3>
              <p>
                {t(
                  "On chain: note commitments, nullifiers, Merkle roots, and the fact that a window settled. No asset, no size, no side, no counterparty, no address.",
                )}
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <h3>{t("Deposits are visible, and always were")}</h3>
              <p>
                {t(
                  "Shielding is an ordinary token transfer from a known address, so the link between a wallet and",
                )}{" "}
                <em>having deposited</em> is public in every shielded pool including this one. What
                stays private is everything after: which notes are whose, what they traded, and who
                crossed with whom.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <h3>{t("The matcher sees one window")}</h3>
              <p>
                {t(
                  "Orders are decrypted to be matched, so the venue sees that window’s book in plaintext. It cannot see it before the book closes, and it cannot link your orders across windows — the account handle is salted per window by construction. Removing the single-window view entirely needs threshold decryption, which is not built.",
                )}
              </p>
            </div>
          </article>
          <article>
            <span>04</span>
            <div>
              <h3>{t("Your own history needs your keys")}</h3>
              <p>
                {t(
                  "Because orders are unlinkable across windows, there is no query for “this person’s trades”. Only the holder of the keys can assemble it — which is also why the vault can rebuild itself from the chain and a signature alone, on any browser.",
                )}
              </p>
            </div>
          </article>
        </div>
      </section>

      <section className="proof-disclosure-paper">
        <span className="eyebrow">{t("WHAT THE CHAIN ENFORCES")}</span>
        <h2>{t("Checks, not promises.")}</h2>
        <div className="disclosure-grid">
          <article>
            <span>{t("SOLVENCY")}</span>
            <h3>{t("Repeatable by anyone")}</h3>
            <p>
              {t(
                "Crossing moves no tokens — every unit a buyer receives comes from a seller in the same window — so the pool’s obligations change only on deposit and withdrawal. Solvency reduces to comparing its token balance against what it owes, per asset, directly on chain.",
              )}
            </p>
          </article>
          <article>
            <span>{t("GUARDS")}</span>
            <h3>{t("Read, not set")}</h3>
            <p>
              {t(
                "An asset is deferred when its reference is stale, its oracle is paused, or a corporate action is in progress. The contract derives that itself from the feeds and the token, and a deferred asset rests while every other asset keeps crossing.",
              )}
            </p>
          </article>
          <article>
            <span>{t("EXIT")}</span>
            <h3>{t("Unconditional")}</h3>
            <p>
              {t(
                "Withdrawal is the one path with no pause, no role and no window check. It is also the smallest circuit in the system, deliberately, so that proving it stays something a laptop can do in seconds.",
              )}
            </p>
          </article>
        </div>
      </section>

      <section className="article-body">
        <div className="article-lead">
          <span className="eyebrow">{t("REFERENCE")}</span>
          <h2>
            {t("Where to")}
            <br />
            <em>check it.</em>
          </h2>
          <p>
            {t(
              "The venue runs on Robinhood Chain, an Arbitrum Orbit L2. These are the contracts the dashboard reads, published so the solvency figures can be verified against the chain rather than taken from this page.",
            )}
          </p>
        </div>
        <div className="asset-chapter-copy">
          <dl>
            <div>
              <dt>{t("Network")}</dt>
              <dd>{t("Robinhood Chain · 4663")}</dd>
            </div>
            <div>
              <dt>{t("Quote asset")}</dt>
              <dd>{t("USDG · 6 decimals")}</dd>
            </div>
            <div>
              <dt>{t("Eligible universe")}</dt>
              <dd>{t("Tokenized equities with a Chainlink feed")}</dd>
            </div>
            <div>
              <dt>{t("Window length")}</dt>
              <dd>5 minutes</dd>
            </div>
            <div>
              <dt>{t("Pool")}</dt>
              <dd>
                <code>{MAINNET.pool}</code>
              </dd>
            </div>
            <div>
              <dt>{t("Asset registry")}</dt>
              <dd>
                <code>{MAINNET.eligibleRegistry}</code>
              </dd>
            </div>
            <div>
              <dt>{t("Price committer")}</dt>
              <dd>
                <code>{MAINNET.priceCommitter}</code>
              </dd>
            </div>
            <div>
              <dt>{t("Quote token")}</dt>
              <dd>
                <code>{CONTRACTS[4663].usdg}</code>
              </dd>
            </div>
          </dl>
          <p>
            Every contract is source-verified. The dashboard&rsquo;s{" "}
            <Link href="/proofs" className="text-button">
              solvency record
            </Link>{" "}
            reads these live and links each address to the explorer.
          </p>
        </div>
      </section>

      <section className="roadmap-paper">
        <span className="eyebrow">{t("LIMITS")}</span>
        <h2>
          {t("What this is")}
          <br />
          <em>not.</em>
        </h2>
        <div>
          <article>
            <span>01</span>
            <h3>{t("Unaudited")}</h3>
            <p>
              {t(
                "The contracts and circuits have not been through an external audit. They are source-verified and tested, which is not the same thing.",
              )}
            </p>
          </article>
          <article>
            <span>02</span>
            <h3>{t("A thin anonymity set")}</h3>
            <p>
              {t(
                "Privacy comes from the crowd you hide in. Early on that crowd is small, and timing alone can correlate a deposit with a withdrawal. This improves only with use.",
              )}
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>{t("Issuer powers remain")}</h3>
            <p>
              {t(
                "The tokens are issued by a third party who can pause transfers globally, blocklist an address, or restate a multiplier. No venue can hold these assets and remove that.",
              )}
            </p>
          </article>
          <article>
            <span>04</span>
            <h3>{t("Proved consistent, not optimal")}</h3>
            <p>
              {t(
                "The settlement proof shows a crossing was valid at the committed reference. It does not prove the matcher found the best possible crossing, and this page will not pretend otherwise.",
              )}
            </p>
          </article>
        </div>
        <p className="source-note">
          {t(
            "References come from Chainlink feeds, which update on a deviation threshold rather than continuously, so a window can legitimately cross slightly away from the live mid. An asset whose reference has gone stale is deferred rather than crossed on an old price. Access is subject to asset availability, screening and jurisdiction eligibility.",
          )}
        </p>
      </section>

      <NextChapter number="06" title={t("Open the dashboard.")} href="/dashboard" />
      <Footer />
    </main>
  );
}
