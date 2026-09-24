-- An empty window has nothing to seal, and counting it as unsealed makes the alarm useless.
--
-- `unsealed_on_chain` is the one number in `/api/health` worth waking someone for: it means the
-- database believes a window has moved past OPEN while the pool has never heard of it, and every
-- deposit behind it is queuing. It read 136 for a week — every window the venue had ever opened
-- with no orders in it, which the FSM correctly advanced and correctly never sealed, because
-- `sealWindow` on an empty book is a transaction that pays gas to say nothing.
--
-- An alarm that is always on is not an alarm. The fix is to count only windows that actually had
-- a book: `order_count > 0`. The same applies to pricing and to settlement — a window with no
-- orders is not "settled off chain", it is finished.
--
-- Note this is the second time this shape of bug has cost real time: the pool was wedged for
-- hours while every health indicator stayed green. A health check that cannot go red is worse
-- than none, because it is read as evidence.
-- Dropped rather than replaced: an earlier deploy of this function returns a different row
-- type, and `create or replace` refuses to change OUT parameters. Replacing in place worked
-- locally, where the migrations run in order from empty, and failed on the live database — which
-- is the whole reason a migration is tested against both.
drop function if exists arclite.window_chain_state(integer);

create function arclite.window_chain_state(p_chain_id integer)
returns table (
  live_windows integer,
  unsealed_on_chain integer,
  unpriced_on_chain integer,
  settled_off_chain_only integer,
  queued_deposits_blocked boolean,
  last_sealed_tx text,
  last_chain_error text
)
language sql
as $$
  select
    count(*) filter (
      where status in ('OPEN','SEALED','MATCHING','MATCHED','PROVING','SETTLING')
    )::int,
    count(*) filter (
      where status not in ('OPEN','VOID','FAILED') and sealed_tx is null and not chain_reconciled
        and order_count > 0
    )::int,
    count(*) filter (
      where (sealed_tx is not null or chain_reconciled) and priced_at is null
    )::int,
    count(*) filter (
      where status = 'SETTLED' and settled_tx is null and order_count > 0
    )::int,
    -- A window sealed on chain and long past its deadline. While one is open every deposit
    -- queues instead of entering the tree, so this is the difference between "the venue is
    -- quiet" and "the venue is silently refusing deposits".
    bool_or(
      status in ('SEALED','MATCHING','MATCHED','PROVING','SETTLING')
      and (sealed_tx is not null or chain_reconciled)
      and deadline_at < now() - interval '15 minutes'
    ),
    (array_remove(array_agg(sealed_tx order by seq desc), null))[1],
    (array_remove(array_agg(chain_error order by seq desc), null))[1]
  from arclite.windows
  where chain_id = p_chain_id;
$$;

-- Give a window its chain id when it opens, not when it seals.
--
-- `chain_window_id` was derived at seal time as `floor(opens_at)`, which was fine while nothing
-- outside the sealer needed it. But the trader's spend signature is bound to the window id the
-- *pool* knows, and a trader signs while the window is open — hours before the sealer computes
-- anything. So `/api/orders/window-key` had nothing to hand out, returned `seq` instead, and
-- every order carried a signature over a number the circuit never checks against.
--
-- Same derivation, moved earlier: the value is a function of `opens_at`, so assigning it at
-- insert changes nothing about what the sealer sends, only about when it is knowable. Ordering
-- on a per-second timestamp also matches the pool's own `openWindowId`, which is what makes it
-- the right identifier rather than a second counter to keep in step.
alter table arclite.windows
  alter column chain_window_id set default null;

update arclite.windows
   set chain_window_id = floor(extract(epoch from opens_at))::bigint
 where chain_window_id is null
   and not exists (
     select 1 from arclite.windows w2
      where w2.chain_id = arclite.windows.chain_id
        and w2.chain_window_id = floor(extract(epoch from arclite.windows.opens_at))::bigint
   );

-- Monotonic, and unique even when two windows open inside the same second.
--
-- A plain `floor(epoch(opens_at))` collides the moment a window settles and the next opens in
-- the same second, and the unique index turns that into `on conflict do nothing` — the venue
-- silently stops opening windows, which is the worst possible way to find out. Taking the later
-- of the timestamp and one past the last id keeps the value readable as a time while making a
-- collision impossible.
create or replace function arclite.assign_chain_window_id()
returns trigger
language plpgsql
as $$
declare v_last bigint;
begin
  if new.chain_window_id is null then
    select max(chain_window_id) into v_last
      from arclite.windows where chain_id = new.chain_id;
    new.chain_window_id := greatest(
      floor(extract(epoch from new.opens_at))::bigint,
      coalesce(v_last, 0) + 1
    );
  end if;
  return new;
end;
$$;

-- A trigger rather than a column default, because the value depends on another column. It fires
-- only when the id is absent, so the sealer recording the id it actually used still wins.
drop trigger if exists windows_assign_chain_window_id on arclite.windows;
create trigger windows_assign_chain_window_id
  before insert on arclite.windows
  for each row execute function arclite.assign_chain_window_id();
