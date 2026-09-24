-- ArcLite RH — migration 0002: epochs and the batch-window lifecycle.
--
-- This is the state machine the dashboard's five stages actually render. Two design decisions
-- carry most of the weight:
--
--   1. The window's `status` column IS the program counter. A cron tick is a fresh stateless
--      invocation with no memory of the last one, so there is nowhere else for the lifecycle to
--      live. Every transition is a compare-and-swap against the expected status; a duplicate or
--      late tick either finds the row already moved and does nothing, or moves it exactly once.
--
--   2. A window seals because `seals_at <= now()`, never because a tick fired on time. Vercel
--      Cron is best-effort and silently skips minutes; time-driven transitions mean a skipped
--      tick *delays* a window but can never corrupt one.
--
-- `advance_windows()` exists so a tick is ONE round trip rather than a conversation. The database
-- is currently ~250ms away from the functions, so a chatty FSM would spend seconds per tick
-- waiting. It is also the right shape regardless: the whole transition is one transaction.

create type arclite.window_status as enum (
  'OPEN',      -- accepting orders
  'SEALED',    -- order set frozen; references snapshotted
  'MATCHING',  -- matcher running
  'MATCHED',   -- fills computed
  'PROVING',   -- proof being generated (stubbed until Phase 4)
  'SETTLING',  -- settlement submitted
  'SETTLED',   -- terminal, success
  'VOID',      -- terminal, abandoned; no orders were spent
  'FAILED'     -- terminal, error
);

create type arclite.epoch_status as enum ('OPEN', 'CLOSING', 'PROVING', 'PUBLISHED', 'FAILED');

create table arclite.epochs (
  id           bigint generated always as identity primary key,
  chain_id     integer not null,
  seq          bigint  not null,
  status       arclite.epoch_status not null default 'OPEN',
  opens_at     timestamptz not null default now(),
  closes_at    timestamptz not null,
  window_count integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint epochs_unique unique (chain_id, seq)
);

create table arclite.windows (
  id         bigint generated always as identity primary key,
  chain_id   integer not null,
  epoch_id   bigint  not null references arclite.epochs(id),
  seq        bigint  not null,
  status     arclite.window_status not null default 'OPEN',

  opens_at   timestamptz not null default now(),
  seals_at   timestamptz not null,
  -- Past this, a stuck window is voided rather than left hanging. Nothing is spent before
  -- settlement, so voiding is always safe.
  deadline_at timestamptz not null,

  sealed_at  timestamptz,
  matched_at timestamptz,
  proved_at  timestamptz,
  settled_at timestamptz,

  order_count  integer not null default 0,
  fill_count   integer not null default 0,
  gross_value  numeric,

  -- Frozen at seal. Orders are matched against the references that existed when the book
  -- closed, never against prices observed afterwards — otherwise the operator holds a free
  -- option on the window.
  reference_snapshot jsonb,
  guard_snapshot     jsonb,
  deferred_symbols   text[] not null default '{}',

  attempt     integer not null default 0,
  last_error  text,
  status_changed_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),

  constraint windows_unique unique (chain_id, seq),
  constraint windows_seal_after_open check (seals_at > opens_at),
  constraint windows_deadline_after_seal check (deadline_at > seals_at)
);

-- The whole concurrency story for opening windows, in one index: at most one live window per
-- chain, enforced by Postgres rather than by application logic. "Open the next window" becomes
-- an idempotent INSERT ... ON CONFLICT DO NOTHING with no locking.
create unique index windows_one_live_idx on arclite.windows (chain_id)
  where status in ('OPEN', 'SEALED', 'MATCHING', 'MATCHED', 'PROVING', 'SETTLING');

create index windows_due_idx on arclite.windows (status, seals_at);
create index windows_recent_idx on arclite.windows (chain_id, seq desc);

-- Per-asset reference and guard state, frozen at seal.
create table arclite.window_assets (
  window_id  bigint not null references arclite.windows(id) on delete cascade,
  asset_id   uuid   not null references arclite.assets(id),
  deferred   boolean not null,
  reasons    arclite.guard_reason[] not null default '{}',
  price_1e18 numeric(78,0),
  multiplier_1e18 numeric(78,0),
  session    arclite.session_kind,
  primary key (window_id, asset_id)
);

-- ---------------------------------------------------------------------------------------------
-- transition guard
-- ---------------------------------------------------------------------------------------------

-- A late or duplicated invocation must never walk a window backwards. The compare-and-swap in
-- advance_windows() already prevents it; this makes it impossible from any caller.
create or replace function arclite.enforce_window_transition()
returns trigger
language plpgsql
as $$
declare ok boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  ok := case old.status
    when 'OPEN'     then new.status in ('SEALED', 'VOID')
    when 'SEALED'   then new.status in ('MATCHING', 'VOID', 'FAILED')
    when 'MATCHING' then new.status in ('MATCHED', 'VOID', 'FAILED')
    when 'MATCHED'  then new.status in ('PROVING', 'VOID', 'FAILED')
    when 'PROVING'  then new.status in ('SETTLING', 'VOID', 'FAILED')
    when 'SETTLING' then new.status in ('SETTLED', 'FAILED')
    else false   -- SETTLED, VOID and FAILED are terminal
  end;

  if not ok then
    raise exception 'illegal window transition % -> % (window %)', old.status, new.status, old.id
      using errcode = 'check_violation';
  end if;

  new.status_changed_at := now();
  return new;
end;
$$;

create trigger windows_enforce_transition
  before update of status on arclite.windows
  for each row execute function arclite.enforce_window_transition();

-- ---------------------------------------------------------------------------------------------
-- the tick
-- ---------------------------------------------------------------------------------------------

/**
 * Advance every window that is due, and open one if none is live.
 *
 * Returns a jsonb summary of what changed so the caller can log it without a second query.
 * Safe to call concurrently and repeatedly: transitions are compare-and-swap, and opening is
 * guarded by the partial unique index.
 *
 * Phase 2 runs the lifecycle with no matcher and no chain — windows open, seal against a frozen
 * reference snapshot, cross nothing, and settle empty. That is honest: the clock, the sealing
 * and the snapshot are real, and the crossing step becomes real when orders and proofs exist.
 */
create or replace function arclite.advance_windows(
  p_chain_id integer,
  p_window_seconds integer default 300,
  p_epoch_seconds integer default 3600
)
returns jsonb
language plpgsql
as $$
declare
  v_epoch_id   bigint;
  v_epoch_seq  bigint;
  v_opened     bigint := 0;
  v_sealed     bigint := 0;
  v_advanced   bigint := 0;
  v_settled    bigint := 0;
  v_voided     bigint := 0;
  v_next_seq   bigint;
begin
  -- Close an expired epoch and open the next, so windows always have a parent.
  update arclite.epochs
     set status = 'PUBLISHED'
   where chain_id = p_chain_id and status = 'OPEN' and closes_at <= now();

  select id, seq into v_epoch_id, v_epoch_seq
    from arclite.epochs
   where chain_id = p_chain_id and status = 'OPEN'
   order by seq desc limit 1;

  if v_epoch_id is null then
    select coalesce(max(seq), 41) + 1 into v_epoch_seq
      from arclite.epochs where chain_id = p_chain_id;
    insert into arclite.epochs (chain_id, seq, closes_at)
    values (p_chain_id, v_epoch_seq, now() + make_interval(secs => p_epoch_seconds))
    returning id into v_epoch_id;
  end if;

  -- VOID anything past its deadline before doing anything else, so a stuck window cannot block
  -- the next one behind the one-live-window index. Nothing is spent before settlement.
  with voided as (
    update arclite.windows
       set status = 'VOID',
           last_error = coalesce(last_error, 'deadline exceeded')
     where chain_id = p_chain_id
       and status in ('SEALED', 'MATCHING', 'MATCHED', 'PROVING', 'SETTLING')
       and deadline_at <= now()
    returning 1
  ) select count(*) into v_voided from voided;

  -- SEAL: freeze the book and the references it will cross against.
  with sealed as (
    update arclite.windows w
       set status = 'SEALED',
           sealed_at = now(),
           -- Prices live in price_observations, guards in asset_guards; the snapshot needs
           -- both, taking the most recent round per asset.
           reference_snapshot = (
             select jsonb_object_agg(a.token_symbol, jsonb_build_object(
                      'price1e18', o.price_1e18::text,
                      'multiplier1e18', o.multiplier_1e18::text,
                      'session', o.session,
                      'feedUpdatedAt', o.feed_updated_at
                    ))
               from arclite.assets a
               join arclite.price_feeds pf on pf.asset_id = a.id
               join lateral (
                 select po.price_1e18, po.multiplier_1e18, po.session, po.feed_updated_at
                   from arclite.price_observations po
                  where po.feed_id = pf.id
                  order by po.feed_updated_at desc
                  limit 1
               ) o on true
              where a.chain_id = p_chain_id and a.eligible
           ),
           guard_snapshot = (
             select jsonb_object_agg(a.token_symbol, jsonb_build_object(
                      'deferred', g.deferred, 'stale', g.stale, 'event', g.event
                    ))
               from arclite.asset_guards g
               join arclite.assets a on a.id = g.asset_id
              where a.chain_id = p_chain_id and a.eligible
           ),
           deferred_symbols = coalesce((
             select array_agg(a.token_symbol order by a.token_symbol)
               from arclite.asset_guards g
               join arclite.assets a on a.id = g.asset_id
              where a.chain_id = p_chain_id and a.eligible and g.deferred
           ), '{}')
     where w.chain_id = p_chain_id and w.status = 'OPEN' and w.seals_at <= now()
    returning 1
  ) select count(*) into v_sealed from sealed;

  -- Snapshot per-asset detail for the windows just sealed.
  insert into arclite.window_assets (window_id, asset_id, deferred, reasons, price_1e18,
                                     multiplier_1e18, session)
  select w.id, a.id, g.deferred, g.reasons, o.price_1e18, o.multiplier_1e18, g.session
    from arclite.windows w
    join arclite.assets a on a.chain_id = w.chain_id and a.eligible
    join arclite.asset_guards g on g.asset_id = a.id
    left join arclite.price_feeds pf on pf.asset_id = a.id
    left join lateral (
      select po.price_1e18, po.multiplier_1e18
        from arclite.price_observations po
       where po.feed_id = pf.id
       order by po.feed_updated_at desc
       limit 1
    ) o on true
   where w.chain_id = p_chain_id and w.status = 'SEALED'
     and w.sealed_at >= now() - interval '5 seconds'
  on conflict do nothing;

  -- Drive the middle of the lifecycle. With no matcher and no prover yet these are immediate;
  -- each becomes a real await as the pieces land, and the shape does not change.
  update arclite.windows set status = 'MATCHING'
   where chain_id = p_chain_id and status = 'SEALED';
  update arclite.windows set status = 'MATCHED', matched_at = now()
   where chain_id = p_chain_id and status = 'MATCHING';
  update arclite.windows set status = 'PROVING'
   where chain_id = p_chain_id and status = 'MATCHED';
  update arclite.windows set status = 'SETTLING', proved_at = now()
   where chain_id = p_chain_id and status = 'PROVING';

  with settled as (
    update arclite.windows
       set status = 'SETTLED', settled_at = now()
     where chain_id = p_chain_id and status = 'SETTLING'
    returning 1
  ) select count(*) into v_settled from settled;

  v_advanced := v_sealed;

  -- OPEN the next window if none is live. The partial unique index makes this idempotent, so
  -- two concurrent ticks cannot both succeed.
  select coalesce(max(seq), 0) + 1 into v_next_seq
    from arclite.windows where chain_id = p_chain_id;

  insert into arclite.windows (chain_id, epoch_id, seq, opens_at, seals_at, deadline_at)
  select p_chain_id, v_epoch_id, v_next_seq, now(),
         now() + make_interval(secs => p_window_seconds),
         now() + make_interval(secs => p_window_seconds * 6)
   where not exists (
     select 1 from arclite.windows
      where chain_id = p_chain_id
        and status in ('OPEN', 'SEALED', 'MATCHING', 'MATCHED', 'PROVING', 'SETTLING')
   )
  on conflict do nothing;

  get diagnostics v_opened = row_count;

  update arclite.epochs e
     set window_count = (select count(*) from arclite.windows w where w.epoch_id = e.id)
   where e.id = v_epoch_id;

  return jsonb_build_object(
    'chainId', p_chain_id,
    'epochSeq', v_epoch_seq,
    'opened', v_opened,
    'sealed', v_sealed,
    'advanced', v_advanced,
    'settled', v_settled,
    'voided', v_voided
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------

alter table arclite.epochs        enable row level security;
alter table arclite.windows       enable row level security;
alter table arclite.window_assets enable row level security;

-- The window lifecycle is public by nature: it is a published auction clock, and every
-- participant needs the same view of it. Order contents are not here.
create policy anon_read on arclite.epochs for select to anon, authenticated using (true);
create policy anon_read on arclite.windows for select to anon, authenticated using (true);
create policy anon_read on arclite.window_assets for select to anon, authenticated using (true);

grant select on arclite.epochs, arclite.windows, arclite.window_assets to anon, authenticated;
