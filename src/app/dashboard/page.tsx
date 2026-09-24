"use client";
import { useEffect, useState } from "react";
import Link from "@/app/components/site-link";
import { Footer } from "../components/chrome";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { cash, type Asset } from "../lib/format";
import {
  GUARD_COPY,
  useMarket,
  useSeries,
  useWindow,
  type Range,
} from "../components/market-provider";
import { AssetMark } from "../components/asset-mark";
import { WindowRitual } from "../components/window-ritual";
import { SettlementWatch } from "../components/settlement-watch";
import { PrivacyMeter } from "../components/privacy-meter";
import { MarketChart } from "../components/market-chart";
import { CrossingLine } from "../components/crossing-line";
import { DisclosurePanel } from "../components/disclosure-panel";
import { feature } from "../lib/features";
import { SESSION_POLICY, type SessionKind } from "@/lib/chain/sessions";
import { ConnectButton } from "../components/connect-button";
import { VaultPanel } from "../components/vault-panel";
import { SolvencyRecord } from "../components/solvency-panel";
import { ReceiptsPanel } from "../components/receipts-panel";
import { SealedOrderPanel } from "../components/sealed-order-panel";
import { ShieldCheck, Info } from "lucide-react";
import { Detail } from "../components/panel-detail";
import { useT } from "../lib/i18n";

/**
 * The dashboard, with the simulation taken out of it.
 *
 * Every panel here now reads the chain or the vault. What used to sit alongside them — a ticket
 * that built a local draft, a five-phase batch animation on `setTimeout`, a holdings table seeded
 * with 60 NVDA and $10,000, a receipts list in `sessionStorage` — was the Phase 1–2 product
 * preview, and it was labelled as such throughout. It still has to go, because on a live venue
 * the labelling is not the problem: two portfolios on one page, one real and one invented, is a
 * page you cannot test against. A balance you cannot explain is indistinguishable from a bug,
 * and the demo guaranteed there would always be one.
 *
 * So the Trade tab is the reference market and the sealed order panel, Portfolio is the vault,
 * and Proofs is the on-chain solvency check. If a number appears on this page, something
 * answered for it.
 *
 * The asset `<Select>` moved into the market panel, which is where it belonged once the ticket
 * that used to own it was gone: it chooses what you are *looking at*, not what you are buying.
 *
 * The landing page's asset explorer is deliberately untouched. It is an illustration on a
 * marketing page, it says so, and it is not somewhere anybody tests a deposit.
 */

/** An age in seconds, said the way a person would say it. */
function ago(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

/**
 * How old the reference is, and whether that is a problem.
 *
 * This is the whole reason the field is worth showing. Chainlink's equity feeds carry an 86,400s
 * heartbeat and legitimately stop updating when the market shuts — `src/lib/chain/sessions.ts`
 * records a Sunday probe finding NVDA's feed 44 hours old, which is correct behaviour. A flat
 * "stale after N seconds" reading would therefore call every asset stale all weekend, and a venue
 * that shouts "stale" for two days a week has taught its users to ignore the word.
 *
 * So the bound comes from the session, the same table the guard evaluation uses, and a closed
 * market is reported as a closed market rather than as staleness.
 */
function describeFreshness(
  ageSeconds: number | undefined,
  session: SessionKind,
): { text: string; stale: boolean } | null {
  if (ageSeconds == null || !Number.isFinite(ageSeconds)) return null;
  const limit = SESSION_POLICY[session]?.maxPriceAgeSeconds ?? 3_600;
  if (session === "CLOSED") {
    return { text: `Updated ${ago(ageSeconds)} · market closed, which is expected`, stale: false };
  }
  const stale = ageSeconds > limit;
  const where =
    session === "MARKET" ? "market open" : `${session[0]}${session.slice(1).toLowerCase()} session`;
  return {
    text: stale
      ? `Updated ${ago(ageSeconds)} · older than this session allows`
      : `Updated ${ago(ageSeconds)} · ${where}`,
    stale,
  };
}

export default function Dashboard() {
  const t = useT();
  const market = useMarket();
  const stocks = market.stocks;
  const nav = market.nav;
  const symbols = market.symbols;
  const [asset, setAsset] = useState<Asset>("NVDA");
  const [tab, setTab] = useState("trade");
  const [range, setRange] = useState<Range>("1D");
  const { series, loading: seriesLoading } = useSeries(asset, range);
  const { window: liveWindow, secondsToSeal } = useWindow();
  const mmss = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  const liveGuard = market.guards[asset] ?? {
    stale: false,
    event: false,
    deferred: false,
    reasons: [],
  };
  const guard = liveGuard.stale;
  const eventGuard = liveGuard.event;
  // An asset can be undeferrable-by-guard yet still untradable because the market is shut —
  // SESSION_CLOSED is deliberately neither `stale` nor `event`, so read `deferred` for the verdict.
  const blocked = liveGuard.deferred;
  const live = market.live;
  const px = (n: number) => (live ? cash(n) : "—");
  const meta = stocks[asset];
  const price = meta?.price ?? 0;
  const multiplier = meta?.multiplier ?? 1;
  // The selected asset survives a change of universe. `asset` defaults to NVDA, but the live
  // registry decides what exists — on a network with no assets registered, or if NVDA is ever
  // delisted, the panel would otherwise sit on a symbol with no price and crash on a name that is
  // not there. Fall forward to whatever the venue actually lists.
  useEffect(() => {
    if (symbols.length && !symbols.includes(asset)) setAsset(symbols[0]);
  }, [symbols, asset]);

  // A read-only view of the venue for an agent on the page. The tool this replaces could start a
  // batch; on a live venue nothing exposed here should be able to move value, and answering
  // questions about the market carries no such risk.
  useEffect(() => {
    type MC = {
      registerTool: (tool: unknown, options: { signal: AbortSignal }) => void | Promise<void>;
    };
    const mc = (document as Document & { modelContext?: MC }).modelContext;
    if (!mc?.registerTool) return;
    const lifecycle = new AbortController();
    Promise.resolve(
      mc.registerTool(
        {
          name: "get_market_state",
          title: "Read the ArcLite reference market",
          description:
            "Returns the live reference price, issuer multiplier and guard state for eligible assets on Robinhood Chain. Read-only: it cannot place, seal or settle an order.",
          inputSchema: {
            type: "object",
            properties: { asset: { type: "string" } },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute(input: unknown) {
            const d = (input ?? {}) as Record<string, unknown>;
            const want = typeof d.asset === "string" ? [d.asset] : market.symbols;
            return {
              network: market.network,
              quote: market.quoteSymbol,
              session: market.session,
              assets: want
                .filter((s) => stocks[s])
                .map((s) => ({
                  symbol: s,
                  name: stocks[s]?.name,
                  price: stocks[s]?.price,
                  multiplier: stocks[s]?.multiplier,
                  deferred: market.guards[s]?.deferred ?? false,
                })),
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => {});
    return () => lifecycle.abort();
  }, [market, stocks]);
  const line = series?.polyline ?? "";
  const freshness = describeFreshness(meta?.priceAgeSeconds, market.session);

  return (
    <main
      data-route="/dashboard"
      className="dashboard"
      // The whole skin hangs off this one attribute, so the flag is a real off switch: with
      // it absent not a single rule in `terminal.css` matches and the editorial dashboard
      // renders exactly as it did.
      data-skin={feature("terminal") ? "terminal" : undefined}
      id="top"
    >
      {/* Mounted for the whole dashboard, not inside a tab: an outcome that only arrives while
          the Proofs tab happens to be open is one nobody sees. It shares the receipts panel's
          query key, so the two dedupe rather than polling the venue twice. */}
      {feature("settlement-alerts") && <SettlementWatch />}
      <div className="dashboard-shell">
        <div className="dashboard-title">
          <div>
            <Link href="/" className="back-link">
              {t("← Back to the experience")}
            </Link>
            <span className="terminal-kicker">{t("ARCLITE / PRIVATE EXECUTION TERMINAL")}</span>
            <h1>{t("The private market.")}</h1>
            <p>{t("Sealed orders. Reference prices. Public proofs.")}</p>
          </div>
          <div className="terminal-illustration">
            <img
              loading="eager"
              decoding="sync"
              src="/assets/bust.webp"
              alt="ArcLite halftone classical bust from the approved graphics"
            />
          </div>
          <div className="demo-badge">
            <span>
              {market.live
                ? market.network === "mainnet"
                  ? t("LIVE · ROBINHOOD CHAIN")
                  : t("LIVE · TESTNET")
                : t("CONNECTING")}
            </span>
            <p>
              {market.live
                ? t("Live references · Real settlement")
                : t("Connecting to Robinhood Chain…")}
            </p>
          </div>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <div className="terminal-status-strip">
            <span>
              {t("VENUE")} <b>{t("RWA × RWA")}</b>
            </span>
            <span>
              {t("EXECUTION")} <b>{t("SEALED BATCH")}</b>
            </span>
            <span>
              {t("QUOTE")} <b>{market.quoteSymbol || "—"}</b>
            </span>
            <span>
              {t("NETWORK")}{" "}
              <b>
                {market.live
                  ? market.network === "mainnet"
                    ? t("ROBINHOOD CHAIN")
                    : t("RHC TESTNET")
                  : t("CONNECTING…")}
              </b>
            </span>
          </div>
          <div className="dashboard-toolbar">
            <TabsList className="dashboard-tabs" aria-label="Dashboard views">
              <TabsTrigger value="trade">{t("Trade")}</TabsTrigger>
              <TabsTrigger value="portfolio">{t("Portfolio")}</TabsTrigger>
              <TabsTrigger value="proofs">{t("Proofs & activity")}</TabsTrigger>
            </TabsList>
            <ConnectButton />
          </div>
          <TabsContent value="trade">
            <div className="trade-grid">
              <section className="market-panel">
                {/* Two shapes rather than one with an optional wrapper: `.panel-top` lays its
                    children out as a row, so adding a div around the heading changes the layout
                    even when the mark inside it is not rendered. Off has to leave the markup it
                    found. */}
                <div className="panel-top">
                  {feature("logos") ? (
                    <div className="panel-identity">
                      <AssetMark symbol={asset} />
                      <div>
                        <span className="eyebrow">{t("REFERENCE MARKET")}</span>
                        <h2>
                          {stocks[asset]?.name ?? asset}
                          <span>
                            {asset} / {market.quoteSymbol}
                            {meta?.isin ? ` · ${meta.isin}` : ""}
                          </span>
                        </h2>
                      </div>
                    </div>
                  ) : (
                    <div>
                      <span className="eyebrow">{t("REFERENCE MARKET")}</span>
                      <h2>
                        {stocks[asset]?.name ?? asset}
                        <span>
                          {asset} / {market.quoteSymbol}
                        </span>
                      </h2>
                    </div>
                  )}
                  <span className="small-tag">
                    {liveWindow ? `WINDOW ${liveWindow.seq}` : "LIVE"}
                  </span>
                </div>
                <label className="field-label" id="asset-label">
                  {t("Tokenized asset")}
                </label>
                <Select value={asset} onValueChange={(v) => setAsset(v as Asset)}>
                  <SelectTrigger className="asset-select" aria-labelledby="asset-label">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {symbols.map((symbol) => (
                      <SelectItem key={symbol} value={symbol}>
                        {feature("logos") && <AssetMark symbol={symbol} />}
                        {symbol} — {stocks[symbol]?.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="price-row">
                  <strong>{px(price)}</strong>
                  <span>
                    {live ? "Chainlink reference × issuer multiplier" : "Loading live reference…"}
                  </span>
                </div>
                {feature("price-age") && live && freshness && (
                  <p className={"price-freshness" + (freshness.stale ? " is-stale" : "")}>
                    {freshness.text}
                  </p>
                )}
                {/* Beneath the price, because it qualifies the price: this is what an order at
                    that reference has historically done. */}
                {feature("crossing-history") && <CrossingLine symbol={asset} />}
                {feature("chart-scale") ? (
                  <MarketChart series={series} loading={seriesLoading} />
                ) : (
                  <div className="market-chart">
                    <svg
                      viewBox="0 0 400 160"
                      role="img"
                      aria-label={
                        series
                          ? `${series.symbol} reference price, ${series.axis.label.toLowerCase()}, ${series.changePct >= 0 ? "up" : "down"} ${Math.abs(series.changePct).toFixed(2)} percent`
                          : "Reference price chart loading"
                      }
                      preserveAspectRatio="none"
                    >
                      <defs>
                        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#00b9e4" stopOpacity=".22" />
                          <stop offset="100%" stopColor="#00ffff" stopOpacity="0" />
                        </linearGradient>
                      </defs>
                      {[25, 65, 105, 145].map((y) => (
                        <line key={y} x1="0" y1={y} x2="400" y2={y} stroke="#00008016" />
                      ))}
                      {line && (
                        <>
                          <polygon points={`0,160 ${line} 400,160`} fill="url(#chart-fill)" />
                          <polyline
                            points={line}
                            fill="none"
                            stroke="#0058aa"
                            strokeWidth="1.5"
                            vectorEffect="non-scaling-stroke"
                          />
                        </>
                      )}
                    </svg>
                    <div className="chart-axis">
                      <span>{series?.axis.left ?? ""}</span>
                      <span>
                        {seriesLoading
                          ? "LOADING HISTORY…"
                          : series
                            ? series.axis.label
                            : "HISTORY UNAVAILABLE"}
                      </span>
                      <span>{series?.axis.right ?? ""}</span>
                    </div>
                  </div>
                )}
                <div className="chart-bottom">
                  <div role="group" aria-label="Chart period" className="range-buttons">
                    {(["1D", "1W", "1M"] as Range[]).map((r) => (
                      <button
                        key={r}
                        aria-pressed={range === r}
                        className={range === r ? "selected" : ""}
                        onClick={() => setRange(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <span>
                    {series
                      ? `${series.changePct >= 0 ? "+" : ""}${series.changePct.toFixed(2)}% · ${series.rounds} oracle updates`
                      : "Oracle reference × issuer adjustment"}
                  </span>
                </div>
                <div className="price-details">
                  <div>
                    <span>{t("Issuer multiplier")}</span>
                    <strong>{live ? "× " + multiplier.toFixed(6) : "—"}</strong>
                  </div>
                  <div>
                    <span>{market.quoteSymbol} reference</span>
                    <strong>{live ? "$" + nav.toFixed(4) : "—"}</strong>
                  </div>
                  <div>
                    <span>{t("Price guard")}</span>
                    <strong className={blocked ? "rose-text" : "cyan-text"}>
                      {!live
                        ? "Loading…"
                        : market.session === "CLOSED"
                          ? "Market closed"
                          : blocked
                            ? "Asset deferred"
                            : "Reference accepted"}
                    </strong>
                  </div>
                </div>
                {/* The ritual replaces this line rather than sitting beside it: two window
                    clocks on one panel is two things to reconcile. */}
                {feature("window-ritual") ? (
                  <WindowRitual />
                ) : (
                  <div className="batch-status" role="status">
                    <p>
                      {liveWindow && liveWindow.status === "OPEN"
                        ? `Window ${liveWindow.seq} is open — sealing in ${mmss(secondsToSeal)}. Every participant is watching the same clock.`
                        : liveWindow
                          ? `Window ${liveWindow.seq} · ${liveWindow.status.toLowerCase()}.`
                          : "Waiting for the venue clock."}
                    </p>
                  </div>
                )}
              </section>
              <SealedOrderPanel />
              <section className="guards-panel">
                <div className="panel-top">
                  <h2>Guard {asset}</h2>
                  <ShieldCheck size={19} />
                </div>
                <div className="guard-row">
                  <span>{t("Reference freshness")}</span>
                  <b className={guard ? "rose-text" : "cyan-text"}>
                    {guard ? "Deferred" : "Accepted"}
                  </b>
                </div>
                <div className="guard-row">
                  <span>{t("Corporate action window")}</span>
                  <b className={eventGuard ? "rose-text" : "cyan-text"}>
                    {eventGuard ? "Active" : "Clear"}
                  </b>
                </div>
                <div className="guard-row">
                  <span>{t("Session")}</span>
                  <b>
                    {market.session === "MARKET"
                      ? "Open"
                      : market.session === "CLOSED"
                        ? "Closed"
                        : market.session[0] + market.session.slice(1).toLowerCase()}
                  </b>
                </div>
                {/* Every reason the chain gave, not the two the panel used to collapse them to.
                    `ORACLE_PAUSED`, `MULTIPLIER_PENDING` and `TOKEN_PAUSED` are materially
                    different situations with different expected durations, and "Asset deferred"
                    told a trader none of it. */}
                {feature("guard-reasons") && liveGuard.reasons.length > 0 && (
                  <ul className="guard-reasons">
                    {liveGuard.reasons.map((reason) => (
                      <li key={reason}>
                        <b>{GUARD_COPY[reason]?.title ?? reason}</b>
                        <span>{GUARD_COPY[reason]?.detail ?? ""}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className={"guard-result " + (blocked ? "deferred" : "")} role="status">
                  <Info size={16} />
                  <span>
                    {market.detail[asset] ?? (blocked ? "Asset deferred." : "Reference accepted.")}
                  </span>
                </div>
                <Detail label={t("What a guard is")}>
                  <p>
                    {t(
                      "Guards are read from Robinhood Chain, not set here. They defer one asset alone — every other asset keeps crossing.",
                    )}
                  </p>
                </Detail>
              </section>
            </div>
          </TabsContent>
          <TabsContent value="portfolio">
            {/* Above the balance, because it changes what the balance means. */}
            {feature("privacy-meter") && <PrivacyMeter />}
            <VaultPanel />
            <Detail label={t("Value moves. Units stay yours.")}>
              <p>
                {t(
                  "A note holds raw units. A reference price changes what those units are worth, not how many you have. Returns are not fixed or guaranteed.",
                )}
              </p>
            </Detail>
          </TabsContent>
          <TabsContent value="proofs">
            <div className="proofs-grid">
              <section className="proof-orbit-panel">
                <span className="eyebrow">{t("PUBLIC ACCOUNTABILITY")}</span>
                <div className="proof-engraving">
                  <img
                    loading="eager"
                    decoding="sync"
                    src="/assets/campaign-veil.webp"
                    alt="Engraved eyes and feathers filling the public record frame"
                  />
                  <span>
                    {liveWindow
                      ? `EPOCH ${String(liveWindow.epochSeq).padStart(3, "0")} / PUBLIC RECORD`
                      : "PUBLIC RECORD"}
                  </span>
                </div>
                <h2>
                  {t("Verify the pool.")}
                  <br />
                  <em>{t("Preserve the private.")}</em>
                </h2>
                <p>
                  {t("Solvency is a check you can repeat")}
                  <br />
                  against the chain yourself.
                </p>
              </section>
              <section className="proof-record">
                <div className="panel-top">
                  <h2>{t("Pool solvency")}</h2>
                  <span className="small-tag">{t("LIVE")}</span>
                </div>
                <SolvencyRecord />
                <Detail label={t("What this check is, and is not")}>
                  <p>
                    {t(
                      "Solvency is read live from Robinhood Chain and is a check anyone can repeat, not a proof we produced — crossing moves no tokens, so the pool’s obligations change only on deposit and withdrawal. The contracts are unaudited.",
                    )}
                  </p>
                </Detail>
                <ReceiptsPanel />
                {feature("disclosure") && <DisclosurePanel />}
              </section>
            </div>
          </TabsContent>
        </Tabs>
        <p className="dashboard-disclosure">
          {t(
            "Reference prices, issuer multipliers, asset eligibility and guard state are read live from Robinhood Chain. Deposits, sealed orders, settlement and withdrawals are real transactions against an unaudited contract. Access will be subject to screening and jurisdiction eligibility.",
          )}
        </p>
      </div>
      <Footer />
    </main>
  );
}
