import { db } from "./db";
import type { SupportedChainId } from "@/lib/chain/chains";
import { getMarketSnapshot } from "@/lib/chain/market";
import { getEligibleAssets, getQuoteAsset } from "@/lib/chain/registry";

/**
 * Persist reference data and price observations.
 *
 * The read API deliberately does not depend on this — it reads the chain live, so the dashboard
 * works whether or not the database is reachable. This exists for what the chain cannot give
 * cheaply: history beyond an aggregator's current phase, guard transitions for audit, and a
 * cached series that does not cost an RPC round trip per request.
 *
 * Every function here issues **one statement per table**, passing the whole batch as JSON and
 * letting `json_to_recordset` expand it server-side. The database is a long way from the
 * functions (ap-southeast-1 vs iad1, ~230-260ms), so a row-at-a-time loop over 35 assets would
 * cost ~9s in latency alone; this costs one round trip.
 */

// postgres.js types `sql.json()` narrowly; these rows are plain JSON by construction.
type Json = Parameters<ReturnType<typeof db>["json"]>[0];

export interface SyncResult {
  assets: number;
  feeds: number;
  observations: number;
  guards: number;
}

export async function syncRegistry(
  chainId: SupportedChainId,
): Promise<{ assets: number; feeds: number }> {
  const sql = db();
  const eligible = await getEligibleAssets(chainId, true);
  const quote = getQuoteAsset(chainId);

  const assetRows: Record<string, unknown>[] = eligible.map((a) => ({
    contract_address: a.address,
    token_symbol: a.symbol,
    token_name: a.name,
    token_decimals: a.decimals,
    isin: a.isin ?? null,
    logo_url: a.logoUrl ?? null,
    trading_capabilities: a.tradingCapabilities ?? {},
    kind: "STOCK",
    is_quote: false,
    aggregator: a.feed.address,
    feed_decimals: a.feed.decimals,
    heartbeat_seconds: a.feed.heartbeatSeconds,
    deviation_bps: a.feed.deviationBps,
  }));

  if (quote) {
    assetRows.push({
      contract_address: quote.address.toLowerCase(),
      token_symbol: quote.symbol,
      token_name: quote.name,
      token_decimals: quote.decimals,
      isin: null,
      logo_url: null,
      trading_capabilities: {},
      kind: "STABLE",
      is_quote: true,
      // The quote's own feed is crypto-category: it updates 24/7, so it must not be judged
      // against the equity session calendar.
      aggregator: quote.feedAddress?.toLowerCase() ?? null,
      feed_decimals: 8,
      heartbeat_seconds: 86400,
      deviation_bps: 50,
    });
  }

  await sql`
    insert into arclite.assets
      (chain_id, contract_address, token_symbol, token_name, token_decimals, isin, logo_url,
       rhj_status, trading_capabilities, kind, status, is_quote, eligible)
    select ${chainId}, r.contract_address::citext, r.token_symbol, r.token_name,
           r.token_decimals, r.isin, r.logo_url, 'ASSET_STATUS_ACTIVE',
           r.trading_capabilities, r.kind::arclite.asset_kind, 'ACTIVE', r.is_quote, true
      from jsonb_to_recordset(${sql.json(assetRows as unknown as Json)}) as r(
        contract_address text, token_symbol text, token_name text, token_decimals smallint,
        isin text, logo_url text, trading_capabilities jsonb, kind text, is_quote boolean)
    on conflict (chain_id, contract_address) do update set
      token_name = excluded.token_name,
      token_decimals = excluded.token_decimals,
      isin = excluded.isin,
      logo_url = excluded.logo_url,
      trading_capabilities = excluded.trading_capabilities,
      status = excluded.status,
      eligible = excluded.eligible,
      refreshed_at = now()
  `;

  const feedRows = assetRows.filter((r) => r.aggregator);
  await sql`
    insert into arclite.price_feeds
      (asset_id, chain_id, aggregator, feed_name, category, decimals,
       heartbeat_seconds, deviation_bps, session_aware)
    select a.id, ${chainId}, r.aggregator::citext,
           concat('Robinhood ', r.token_symbol, ' / USD'),
           (case when r.kind = 'STABLE' then 'CRYPTO' else 'EQUITY' end)::arclite.feed_category,
           r.feed_decimals, r.heartbeat_seconds, r.deviation_bps,
           r.kind <> 'STABLE'
      from jsonb_to_recordset(${sql.json(feedRows as unknown as Json)}) as r(
        token_symbol text, aggregator text, kind text, feed_decimals smallint,
        heartbeat_seconds int, deviation_bps int)
      join arclite.assets a on a.chain_id = ${chainId} and a.token_symbol = r.token_symbol
    on conflict (chain_id, aggregator) do update set
      feed_name = excluded.feed_name,
      decimals = excluded.decimals,
      heartbeat_seconds = excluded.heartbeat_seconds,
      deviation_bps = excluded.deviation_bps,
      category = excluded.category,
      session_aware = excluded.session_aware
  `;

  return { assets: assetRows.length, feeds: feedRows.length };
}

export async function syncPrices(
  chainId: SupportedChainId,
): Promise<{ observations: number; guards: number }> {
  const sql = db();
  const snapshot = await getMarketSnapshot(chainId);
  if (snapshot.assets.length === 0) return { observations: 0, guards: 0 };

  const rows: Record<string, unknown>[] = snapshot.assets.map((a) => ({
    symbol: a.symbol,
    price_1e18: a.priceRaw,
    multiplier_1e18: a.multiplierRaw,
    feed_updated_at: a.priceUpdatedAt,
    session: a.session,
    stale: a.guard.stale,
    deferred: a.guard.deferred,
    event: a.guard.event,
    reasons: a.guard.reasons,
    detail: { detail: a.guard.detail },
    price_age_seconds: a.priceAgeSeconds,
  }));
  const payload = sql.json(rows as unknown as Json);

  // Keyed on (feed_id, round_id), so a minute-by-minute poller against a 24h-heartbeat feed
  // inserts nothing until a genuinely new round appears. No dedup logic of our own needed.
  const observations = await sql`
    insert into arclite.price_observations
      (feed_id, round_id, answer_raw, feed_decimals, price_1e18, multiplier_1e18,
       feed_updated_at, session, stale)
    select pf.id,
           extract(epoch from r.feed_updated_at)::numeric,
           r.price_1e18::numeric, pf.decimals, r.price_1e18::numeric, r.multiplier_1e18::numeric,
           r.feed_updated_at, r.session::arclite.session_kind, r.stale
      from jsonb_to_recordset(${payload}) as r(
        symbol text, price_1e18 text, multiplier_1e18 text, feed_updated_at timestamptz,
        session text, stale boolean)
      join arclite.assets a on a.chain_id = ${chainId} and a.token_symbol = r.symbol
      join arclite.price_feeds pf on pf.asset_id = a.id
    on conflict (feed_id, round_id) do nothing
    returning 1
  `;

  const guards = await sql`
    insert into arclite.asset_guards
      (asset_id, deferred, stale, event, reasons, detail, price_age_seconds, session, deferred_since)
    select a.id, r.deferred, r.stale, r.event,
           coalesce((select array_agg(x::arclite.guard_reason)
                       from jsonb_array_elements_text(r.reasons) x), '{}'),
           r.detail, r.price_age_seconds, r.session::arclite.session_kind,
           case when r.deferred then now() end
      from jsonb_to_recordset(${payload}) as r(
        symbol text, deferred boolean, stale boolean, event boolean, reasons jsonb,
        detail jsonb, price_age_seconds int, session text)
      join arclite.assets a on a.chain_id = ${chainId} and a.token_symbol = r.symbol
    on conflict (asset_id) do update set
      deferred = excluded.deferred,
      stale = excluded.stale,
      event = excluded.event,
      reasons = excluded.reasons,
      detail = excluded.detail,
      price_age_seconds = excluded.price_age_seconds,
      session = excluded.session,
      -- hold the original timestamp for as long as the asset stays deferred, so the UI can say
      -- how long it has been down rather than resetting the clock every poll
      deferred_since = case
        when excluded.deferred and arclite.asset_guards.deferred
          then arclite.asset_guards.deferred_since
        when excluded.deferred then now()
      end,
      evaluated_at = now()
    returning 1
  `;

  return { observations: observations.length, guards: guards.length };
}
