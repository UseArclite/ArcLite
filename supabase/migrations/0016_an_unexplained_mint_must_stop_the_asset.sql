-- An unexplained mint must stop the asset.
--
-- A tokenized equity is only worth a share because the issuer holds a share behind it. The token
-- contracts on Robinhood Chain are mintable and burnable by their issuer, and until now nothing
-- on this venue noticed: supply could double overnight and ArcLite would keep crossing at the
-- Chainlink price as though each token still represented what it did yesterday.
--
-- The honest limit of this table: it records *supply*, not *backing*. Comparing the two is what
-- proof-of-reserve does, and no source for the attested figure exists on this chain — Chainlink
-- publishes no PoR feed on 4663 (0 of 58 feeds), Prism documents no API, and the issuer's own
-- registry carries no reserve field. So this detects that the issuer did something, not that the
-- something was wrong. That is a weaker claim and is deliberately named as one throughout.
--
-- It is still worth having. A supply change outside an announced corporate action is exactly the
-- event a venue should stop crossing an asset over, and this is the scaffolding a real PoR feed
-- would plug into on the day one exists.

create table if not exists arclite.asset_supply (
  chain_id      integer      not null,
  asset_id      integer      not null,
  observed_at   timestamptz  not null default now(),
  -- Raw units, 78 digits, like every other amount here. Never a float: a supply figure that
  -- rounds is a drift figure that lies.
  total_supply  numeric(78,0) not null,
  -- The issuer multiplier at the same instant. A supply move that arrives with a multiplier
  -- change is a corporate action; the same move without one is unexplained, and the difference
  -- is the whole signal.
  multiplier    numeric(78,0) not null,
  primary key (chain_id, asset_id, observed_at)
);

create index if not exists asset_supply_latest_idx
  on arclite.asset_supply (chain_id, asset_id, observed_at desc);

-- The current verdict per asset, so a reader does not have to re-derive it from the series.
create table if not exists arclite.asset_supply_state (
  chain_id        integer      not null,
  asset_id        integer      not null,
  -- Last supply we successfully read, and when.
  last_supply     numeric(78,0),
  last_read_at    timestamptz,
  -- The baseline drift is measured against, and when it was adopted. Reset whenever a drift is
  -- accepted or explained, so one corporate action does not flag forever.
  baseline_supply numeric(78,0),
  baseline_at     timestamptz,
  drift_bps       integer      not null default 0,
  -- Whether this asset is currently considered unsafe to cross.
  drifted         boolean      not null default false,
  -- Why, in words, for the dashboard. Null when not drifted.
  reason          text,
  -- Consecutive failed reads. Fail-closed: enough of these and the asset is drifted regardless,
  -- because "we could not check" and "it is fine" must never render the same.
  failed_reads    integer      not null default 0,
  updated_at      timestamptz  not null default now(),
  primary key (chain_id, asset_id)
);
