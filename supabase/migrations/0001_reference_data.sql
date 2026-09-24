-- ArcLite RH — migration 0001: reference data, price history, guards.
--
-- Scope is deliberately Phase 1 only: everything needed to put real Robinhood Chain prices and
-- real deferral state on the dashboard. Windows, orders, commitments and proofs arrive in later
-- migrations, once shielding exists to put anything in them.
--
-- Conventions, applied throughout:
--   * raw on-chain amounts are numeric(78,0) — uint256-safe. Never float, never bigint.
--   * prices are stored raw alongside their scale, with a generated column for display.
--   * addresses are citext and normalised to lowercase by trigger. The format CHECK alone is
--     not enough: citext makes `~` case-insensitive, so it accepts mixed case silently.
--   * every table lives in schema `arclite`, so PostgREST exposure is an explicit choice.

create schema if not exists arclite;
create extension if not exists citext;

-- ---------------------------------------------------------------------------------------------
-- enums
-- ---------------------------------------------------------------------------------------------

create type arclite.asset_kind   as enum ('STOCK', 'TREASURY', 'STABLE');
create type arclite.asset_status as enum ('ACTIVE', 'PAUSED', 'DELISTED', 'INELIGIBLE');
create type arclite.feed_category as enum ('EQUITY', 'CRYPTO', 'NAV');
create type arclite.session_kind as enum ('PRE', 'MARKET', 'POST', 'OVERNIGHT', 'CLOSED');

-- Guard reasons are the vocabulary the dashboard's two indicators collapse into:
--   stale <- STALE_PRICE, ORACLE_PAUSED, SEQUENCER_SUSPECT
--   event <- EVENT_WINDOW, MULTIPLIER_PENDING, NAV_STALE
-- SESSION_CLOSED is deliberately neither: "the market is shut" is not "something is wrong",
-- and showing it as staleness is the single most likely source of false alarms.
create type arclite.guard_reason as enum (
  'STALE_PRICE', 'EVENT_WINDOW', 'NAV_STALE', 'ORACLE_PAUSED', 'SEQUENCER_SUSPECT',
  'MULTIPLIER_PENDING', 'SESSION_CLOSED', 'TOKEN_PAUSED', 'BLOCKLISTED', 'REGISTRY', 'MANUAL'
);

create type arclite.corp_action as enum (
  'EX_DIVIDEND', 'SPLIT', 'REVERSE_SPLIT', 'MERGER', 'SPINOFF', 'HALT', 'MULTIPLIER_UPDATE'
);

-- ---------------------------------------------------------------------------------------------
-- assets — mirrors https://api.robinhood.com/rhj/assets, plus arclite-owned eligibility
-- ---------------------------------------------------------------------------------------------

create table arclite.assets (
  id                   uuid primary key default gen_random_uuid(),
  chain_id             integer not null,
  contract_address     citext  not null check (contract_address ~ '^0x[0-9a-f]{40}$'),

  -- mirrored from the registry API, field names kept aligned with it
  rhj_id               text,
  token_symbol         text    not null,
  token_name           text    not null,
  token_decimals       smallint not null check (token_decimals between 0 and 36),
  isin                 text,
  logo_url             text,
  rhj_status           text,
  current_multiplier   numeric(78,0),            -- uiMultiplier(), 1e18-scaled
  pending_multiplier   numeric(78,0),            -- newUIMultiplier()
  multiplier_effective_at timestamptz,           -- effectiveAt()
  oracle_paused        boolean not null default false,
  trading_capabilities jsonb   not null default '{}'::jsonb,

  -- arclite-owned
  kind                 arclite.asset_kind   not null,
  status               arclite.asset_status not null default 'INELIGIBLE',
  is_quote             boolean not null default false,
  -- An asset is tradable only if the registry lists it AND a Chainlink feed exists. 194 assets
  -- are registered; only 35 have feeds. A venue that cannot derive a guarded reference for an
  -- asset has no business crossing it, so this is the concrete form of the spec's
  -- "registry rejects non-RWA assets".
  eligible             boolean not null default false,
  nav_max_age_seconds  integer,                  -- TREASURY only
  min_order_raw        numeric(78,0) not null default 0,
  sort_order           integer not null default 100,

  first_seen_at        timestamptz not null default now(),
  refreshed_at         timestamptz not null default now(),

  constraint assets_unique_address unique (chain_id, contract_address),
  constraint assets_unique_symbol  unique (chain_id, token_symbol),
  constraint assets_treasury_needs_nav_age
    check (kind <> 'TREASURY' or nav_max_age_seconds is not null)
);

comment on column arclite.assets.eligible is
  'Registry-listed AND has a price feed. Orders on ineligible assets are rejected at submit.';

create index assets_tradable_idx on arclite.assets (chain_id, sort_order)
  where status = 'ACTIVE' and eligible;

-- At most one quote asset per chain.
create unique index assets_one_quote_idx on arclite.assets (chain_id) where is_quote;

-- ---------------------------------------------------------------------------------------------
-- price_feeds — Chainlink aggregators
-- ---------------------------------------------------------------------------------------------

create table arclite.price_feeds (
  id             uuid primary key default gen_random_uuid(),
  asset_id       uuid not null references arclite.assets(id) on delete cascade,
  chain_id       integer not null,
  aggregator     citext not null check (aggregator ~ '^0x[0-9a-f]{40}$'),
  feed_name      text   not null,
  category       arclite.feed_category not null,
  decimals       smallint not null,
  heartbeat_seconds integer not null,
  deviation_bps  integer,
  -- Equity feeds stop updating when the market closes; crypto feeds run 24/7. One staleness
  -- rule cannot serve both, so the feed declares which regime it is in.
  session_aware  boolean not null default true,
  -- Flat bound used when session_aware is false.
  max_age_seconds integer not null default 3600,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),

  constraint price_feeds_unique unique (chain_id, aggregator)
);

create unique index price_feeds_primary_idx on arclite.price_feeds (asset_id) where enabled;

-- ---------------------------------------------------------------------------------------------
-- address normalisation
-- ---------------------------------------------------------------------------------------------

-- citext comparison is case-insensitive, which is what we want for lookups, but it also makes
-- the `~` format check case-insensitive — so a mixed-case address passes validation and is
-- stored as-is. That value is wrong the moment it leaves Postgres for an RPC call or a registry
-- comparison. Canonicalise here rather than relying on every writer to remember.
create or replace function arclite.normalise_address()
returns trigger
language plpgsql
as $$
begin
  if tg_table_name = 'assets' then
    new.contract_address := lower(new.contract_address::text)::citext;
  elsif tg_table_name = 'price_feeds' then
    new.aggregator := lower(new.aggregator::text)::citext;
  end if;
  return new;
end;
$$;

create trigger assets_normalise_address
  before insert or update of contract_address on arclite.assets
  for each row execute function arclite.normalise_address();

create trigger price_feeds_normalise_address
  before insert or update of aggregator on arclite.price_feeds
  for each row execute function arclite.normalise_address();

-- ---------------------------------------------------------------------------------------------
-- market sessions
-- ---------------------------------------------------------------------------------------------

create table arclite.market_calendar (
  d              date primary key,
  mic            text not null default 'XNYS',
  is_trading_day boolean not null,
  open_utc       timestamptz,
  close_utc      timestamptz,
  early_close    boolean not null default false,
  note           text,
  constraint market_calendar_hours check (
    not is_trading_day or (open_utc is not null and close_utc is not null and close_utc > open_utc)
  )
);

create table arclite.session_policy (
  session          arclite.session_kind primary key,
  max_price_age_seconds integer not null,
  allow_crossing   boolean not null,
  note             text
);

-- A Sunday probe found NVDA's feed 44 hours stale — correct behaviour, not a fault: equity
-- markets were shut. A flat age bound would defer every asset all weekend and make the venue
-- look broken for most of the week. CLOSED therefore gets a wide bound and simply does not
-- cross, rather than being reported as stale.
insert into arclite.session_policy (session, max_price_age_seconds, allow_crossing, note) values
  ('MARKET',     3600,   true,  'Regular hours. Tight bound; a stale feed here is a real fault.'),
  ('PRE',        14400,  true,  'Pre-market: thinner updates are expected.'),
  ('POST',       14400,  true,  'Post-market: thinner updates are expected.'),
  ('OVERNIGHT',  43200,  true,  'Overnight session, only for assets whose registry entry allows it.'),
  ('CLOSED',     259200, false, 'Market shut. Feeds are stale by design; do not cross, do not alarm.');

-- ---------------------------------------------------------------------------------------------
-- price history
-- ---------------------------------------------------------------------------------------------

create table arclite.price_observations (
  id              bigint generated always as identity,
  feed_id         uuid not null references arclite.price_feeds(id) on delete cascade,
  round_id        numeric(78,0) not null,
  answer_raw      numeric(78,0) not null,
  feed_decimals   smallint not null,
  -- normalised to 1e18 so every consumer reads one scale
  price_1e18      numeric(78,0) not null,
  multiplier_1e18 numeric(78,0),
  feed_updated_at timestamptz not null,       -- latestRoundData().updatedAt
  observed_at     timestamptz not null default now(),
  session         arclite.session_kind not null,
  stale           boolean not null default false,
  primary key (feed_id, round_id)
);

comment on table arclite.price_observations is
  'One row per NEW Chainlink round. With an 86400s heartbeat a poller sees the same roundId all '
  'day, so the primary key does the deduplication and the table stays small.';

create index price_observations_recent_idx
  on arclite.price_observations (feed_id, feed_updated_at desc);

-- Evenly spaced series for the dashboard chart. Observations alone are too sparse and too
-- irregular to plot: a 24h heartbeat means long gaps with no rows at all.
create table arclite.price_candles (
  feed_id     uuid not null references arclite.price_feeds(id) on delete cascade,
  bucket      text not null check (bucket in ('5m', '1h', '1d')),
  ts          timestamptz not null,
  open_1e18   numeric(78,0) not null,
  high_1e18   numeric(78,0) not null,
  low_1e18    numeric(78,0) not null,
  close_1e18  numeric(78,0) not null,
  n_obs       integer not null default 1,
  session     arclite.session_kind not null,
  primary key (feed_id, bucket, ts)
);

comment on column arclite.price_candles.session is
  'Lets the chart dim closed-market spans instead of drawing a misleading flat line.';

-- ---------------------------------------------------------------------------------------------
-- guards
-- ---------------------------------------------------------------------------------------------

create table arclite.asset_guards (
  asset_id       uuid primary key references arclite.assets(id) on delete cascade,
  deferred       boolean not null default false,
  -- the two booleans the dashboard already renders
  stale          boolean not null default false,
  event          boolean not null default false,
  reasons        arclite.guard_reason[] not null default '{}',
  detail         jsonb not null default '{}'::jsonb,
  price_age_seconds integer,
  session        arclite.session_kind,
  deferred_since timestamptz,
  evaluated_at   timestamptz not null default now()
);

create table arclite.asset_guard_events (
  id        bigint generated always as identity primary key,
  asset_id  uuid not null references arclite.assets(id) on delete cascade,
  reason    arclite.guard_reason not null,
  active    boolean not null,
  detail    jsonb not null default '{}'::jsonb,
  at        timestamptz not null default now()
);

create index asset_guard_events_recent_idx on arclite.asset_guard_events (asset_id, at desc);

create table arclite.corporate_action_calendar (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references arclite.assets(id) on delete cascade,
  kind          arclite.corp_action not null,
  effective_at  timestamptz not null,
  -- the pause window, not the event instant
  window_start  timestamptz not null,
  window_end    timestamptz not null,
  old_multiplier_1e18 numeric(78,0),
  new_multiplier_1e18 numeric(78,0),
  source        text not null,
  source_ref    text,
  tx_hash       text,
  created_at    timestamptz not null default now(),
  constraint corp_action_window check (window_end > window_start)
);

create index corp_action_active_idx
  on arclite.corporate_action_calendar (asset_id, window_start, window_end);

-- ---------------------------------------------------------------------------------------------
-- operations
-- ---------------------------------------------------------------------------------------------

create table arclite.cron_locks (
  name        text primary key,
  holder      text not null,
  acquired_at timestamptz not null default now(),
  lease_until timestamptz not null,
  last_ok_at  timestamptz,
  last_error  text,
  run_count   bigint not null default 0
);

-- Returns true only if the lock was free or its lease had expired. A duplicate cron invocation
-- gets false and should exit 200 immediately — never 500, or Vercel retries and floods the logs.
create or replace function arclite.try_lock(p_name text, p_holder text, p_ttl_seconds integer)
returns boolean
language sql
as $$
  insert into arclite.cron_locks (name, holder, lease_until)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
     set holder      = excluded.holder,
         acquired_at = now(),
         lease_until = excluded.lease_until,
         run_count   = arclite.cron_locks.run_count + 1
   where arclite.cron_locks.lease_until < now()
  returning true;
$$;

create table arclite.cron_runs (
  id          bigint generated always as identity primary key,
  name        text not null,
  holder      text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  actions     jsonb not null default '{}'::jsonb,
  error       text
);

create index cron_runs_recent_idx on arclite.cron_runs (name, started_at desc);

-- ---------------------------------------------------------------------------------------------
-- RLS — default deny, then open only what the dashboard genuinely needs unauthenticated
-- ---------------------------------------------------------------------------------------------

alter table arclite.assets                     enable row level security;
alter table arclite.price_feeds                enable row level security;
alter table arclite.price_observations         enable row level security;
alter table arclite.price_candles              enable row level security;
alter table arclite.market_calendar            enable row level security;
alter table arclite.session_policy             enable row level security;
alter table arclite.asset_guards               enable row level security;
alter table arclite.asset_guard_events         enable row level security;
alter table arclite.corporate_action_calendar  enable row level security;
alter table arclite.cron_locks                 enable row level security;
alter table arclite.cron_runs                  enable row level security;

grant usage on schema arclite to anon, authenticated;

-- Public market data. Server functions use the service role and bypass all of this; these
-- policies exist so Supabase Realtime and any direct browser read stay safe.
create policy anon_read on arclite.assets            for select to anon, authenticated
  using (status in ('ACTIVE', 'PAUSED'));
create policy anon_read on arclite.price_feeds       for select to anon, authenticated using (enabled);
create policy anon_read on arclite.price_observations for select to anon, authenticated using (true);
create policy anon_read on arclite.price_candles     for select to anon, authenticated using (true);
create policy anon_read on arclite.market_calendar   for select to anon, authenticated using (true);
create policy anon_read on arclite.session_policy    for select to anon, authenticated using (true);
create policy anon_read on arclite.asset_guards      for select to anon, authenticated using (true);
create policy anon_read on arclite.corporate_action_calendar
  for select to anon, authenticated using (true);

grant select on arclite.assets, arclite.price_feeds, arclite.price_observations,
                arclite.price_candles, arclite.market_calendar, arclite.session_policy,
                arclite.asset_guards, arclite.corporate_action_calendar
  to anon, authenticated;

-- cron_locks, cron_runs and asset_guard_events get RLS with NO policy: service role only.
