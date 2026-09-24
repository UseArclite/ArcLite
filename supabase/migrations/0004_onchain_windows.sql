-- ArcLite RH — migration 0004: connect the window FSM to the chain.
--
-- Until now the tick advanced a database-only state machine. A window could seal, match and
-- settle in Postgres while nothing whatsoever happened on Robinhood Chain — two clocks with no
-- relationship, and no way to notice they had diverged.
--
-- These columns are the join. They record what the chain did, not what we intended: a window
-- carries the transaction that sealed it and the `pricesRoot` the contract derived for itself.
-- Nothing here is authoritative — the chain is — which is why every column is nullable and
-- `arclite.window_chain_state()` reports disagreement rather than papering over it.

alter table arclite.windows
  -- The on-chain window id. Not the same as `seq`: the contract takes a uint64 the operator
  -- chooses, and reusing `seq` across a redeployed pool would collide with its history.
  add column chain_window_id  bigint,
  add column sealed_tx        text check (sealed_tx ~ '^0x[0-9a-f]{64}$'),
  add column priced_tx        text check (priced_tx ~ '^0x[0-9a-f]{64}$'),
  add column settled_tx       text check (settled_tx ~ '^0x[0-9a-f]{64}$'),
  add column voided_tx        text check (voided_tx ~ '^0x[0-9a-f]{64}$'),
  -- Derived on-chain by PriceCommitter after the book was sealed. Stored so the matcher can be
  -- checked against what the contract actually committed, rather than what we asked it to.
  add column prices_root      bytea check (prices_root is null or octet_length(prices_root) = 32),
  add column orders_root      bytea check (orders_root is null or octet_length(orders_root) = 32),
  add column defer_mask       numeric(78, 0),
  add column priced_at        timestamptz,
  -- The contract refused. Kept verbatim: a revert reason is the most useful thing the chain
  -- ever tells you, and summarising it loses the selector.
  add column chain_error      text,
  -- True when the window was found already sealed on chain rather than sealed by us — a previous
  -- tick sent it and died before recording. Distinct from `sealed_tx` because writing a
  -- placeholder hash there would read as a real transaction and link to nothing.
  add column chain_reconciled boolean not null default false;

create unique index windows_chain_window_idx
  on arclite.windows (chain_id, chain_window_id)
  where chain_window_id is not null;

comment on column arclite.windows.chain_window_id is
  'The uint64 the pool knows this window by. Null until the window is sealed on chain.';
comment on column arclite.windows.prices_root is
  'Derived by PriceCommitter from its own staticcalls, after sealing. We record it; we do not choose it.';

-- ---------------------------------------------------------------------------------------------
-- reconciliation
-- ---------------------------------------------------------------------------------------------

-- A window that sealed in the database but not on chain is the failure worth catching early:
-- the venue's clock says the book is frozen while the pool has never heard of it, so an order
-- accepted afterwards would be crossed against a window that cannot settle.
create or replace function arclite.windows_needing_chain_seal(p_chain_id integer)
returns table (id bigint, seq bigint, seals_at timestamptz)
language sql
as $$
  select w.id, w.seq, w.seals_at
    from arclite.windows w
   where w.chain_id = p_chain_id
     -- Anything past OPEN should have been sealed on chain. VOID and FAILED are exempt because
     -- they were abandoned; a window that reached SETTLED with no seal is the *worst* case, not
     -- an exempt one, so it must stay in this set rather than ageing out of it.
     and w.status not in ('OPEN', 'VOID', 'FAILED')
     and w.sealed_tx is null
     and not w.chain_reconciled
   order by w.seq
   limit 8;
$$;

-- `p_tx` null means the window was found already sealed on chain rather than sealed by us.
create or replace function arclite.record_chain_seal(
  p_id bigint, p_chain_window_id bigint, p_tx text, p_orders_root bytea
)
returns void
language sql
as $$
  update arclite.windows
     set chain_window_id  = p_chain_window_id,
         sealed_tx        = p_tx,
         chain_reconciled = (p_tx is null),
         orders_root      = coalesce(p_orders_root, orders_root),
         chain_error      = null
   where id = p_id;
$$;

create or replace function arclite.record_chain_prices(
  p_id bigint, p_tx text, p_prices_root bytea, p_defer_mask numeric, p_priced_at timestamptz
)
returns void
language sql
as $$
  update arclite.windows
     set priced_tx   = p_tx,
         -- Null tx means a previous tick priced it and died before recording; `priced_at` is
         -- what marks the window priced, so the absence of a hash cannot make it look unpriced.
         prices_root = p_prices_root,
         defer_mask  = p_defer_mask,
         priced_at   = p_priced_at,
         chain_error = null
   where id = p_id;
$$;

-- Recorded rather than thrown. A chain call that failed is a fact about the window, and losing
-- it to an exception means the next tick retries blind.
create or replace function arclite.record_chain_error(p_id bigint, p_error text)
returns void
language sql
as $$
  update arclite.windows set chain_error = p_error where id = p_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- health
-- ---------------------------------------------------------------------------------------------

-- Answers one question for the uptime monitor: is the database's idea of the venue still
-- connected to the chain's? `unsealed_on_chain` above zero means they have diverged.
create or replace function arclite.window_chain_state(p_chain_id integer)
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
    )::int,
    count(*) filter (
      where (sealed_tx is not null or chain_reconciled) and priced_at is null
    )::int,
    -- Informational, not an alarm. The tick seals and prices on chain but does not yet prove or
    -- settle — that needs a prover in the serverless path — so the database FSM runs ahead of the
    -- pool by design. Counting it makes the gap visible instead of letting it read as health.
    count(*) filter (
      where status = 'SETTLED' and settled_tx is null
    )::int,
    -- A window sealed on chain and long past its deadline. While one is open every deposit
    -- queues instead of entering the tree, so this is the difference between "the venue is
    -- quiet" and "the venue is silently refusing deposits".
    bool_or(
      sealed_tx is not null and settled_tx is null and voided_tx is null
      and sealed_at < now() - interval '1 hour'
    ),
    (select sealed_tx from arclite.windows
      where chain_id = p_chain_id and sealed_tx is not null
      order by seq desc limit 1),
    (select chain_error from arclite.windows
      where chain_id = p_chain_id and chain_error is not null
      order by seq desc limit 1)
  from arclite.windows
  where chain_id = p_chain_id;
$$;
