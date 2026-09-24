-- ArcLite RH — migration 0006: fills, and the window's matched result.
--
-- A fill is what the matcher decided for one order. It is recorded before anything is proved,
-- because the proof is generated *from* this: `batch_cross` does not re-derive the crossing, it
-- constrains it, so the matcher's answer has to exist first and has to be reproducible.
--
-- Determinism is the reason this table is shaped the way it is. Replaying a window must produce
-- byte-identical fills or the proof cannot be regenerated after a crash, so every value here is
-- an exact integer and the ordering is `seq`, never insertion order.

-- `windows.matched_at` already exists and means "the FSM passed through MATCHED" — a status
-- timestamp the lifecycle sets on its own. Reusing it to mean "the matcher has run" silently
-- made every window look already-matched and the matcher never executed once. Two meanings on
-- one column is the bug; this is the second meaning, given its own column.
alter table arclite.windows add column matcher_ran_at timestamptz;

create type arclite.fill_reason as enum ('matched', 'partial', 'unmatched', 'stale', 'event');

create table arclite.fills (
  id            bigint generated always as identity primary key,
  window_id     bigint not null references arclite.windows(id) on delete cascade,
  order_id      bigint not null references arclite.orders(id) on delete cascade,
  seq           integer not null,

  asset_id      integer not null,
  side          text not null check (side in ('buy', 'sell')),

  -- Raw units. numeric(78,0) throughout: uint256-safe, and a float here would round a balance
  -- the circuit will later check exactly.
  quantity_raw  numeric(78, 0) not null check (quantity_raw > 0),
  filled_raw    numeric(78, 0) not null check (filled_raw >= 0),
  residual_raw  numeric(78, 0) not null check (residual_raw >= 0),
  quote_raw     numeric(78, 0) not null check (quote_raw >= 0),

  -- The same five strings the dashboard renders and the circuit constrains. Sharing the
  -- vocabulary is what turns a rendered label into a proven claim rather than a server assertion.
  reason        arclite.fill_reason not null,

  created_at    timestamptz not null default now(),

  -- A fill can never exceed its order. The circuit asserts this too; asserting it here means a
  -- matcher bug is caught before a proof is attempted rather than as an unsatisfiable constraint.
  constraint fills_within_order check (filled_raw <= quantity_raw),
  constraint fills_conserve check (filled_raw + residual_raw = quantity_raw),
  -- The reason must agree with the numbers. `stale` and `event` are guard outcomes and are
  -- checked separately, since a deferred asset fills nothing regardless of its book.
  constraint fills_reason_agrees check (
    case reason
      when 'matched'   then filled_raw = quantity_raw
      when 'partial'   then filled_raw > 0 and filled_raw < quantity_raw
      when 'unmatched' then filled_raw = 0
      else filled_raw = 0
    end
  )
);

create unique index fills_order_idx on arclite.fills (order_id);
create index fills_window_idx on arclite.fills (window_id, seq);

-- Per-asset totals for the window, which is what the tape eventually publishes and what
-- `batch_cross` commits to as `asset_matched`.
create table arclite.window_assets_matched (
  window_id    bigint not null references arclite.windows(id) on delete cascade,
  asset_id     integer not null,
  buy_total    numeric(78, 0) not null,
  sell_total   numeric(78, 0) not null,
  matched      numeric(78, 0) not null,
  deferred     boolean not null default false,
  primary key (window_id, asset_id),
  -- Liquidity cannot be withheld: the matched size is the whole of the smaller side, unless the
  -- asset was deferred and crossed nothing.
  constraint matched_is_min check (
    (deferred and matched = 0) or matched = least(buy_total, sell_total)
  )
);

-- Record a whole window's match in one call. One round trip, one transaction: a partially
-- written match is worse than none, because the orders root would no longer describe the fills.
create or replace function arclite.record_match(
  p_window_id bigint, p_fills jsonb, p_assets jsonb, p_gross numeric
)
returns integer
language plpgsql
as $$
declare v_count integer;
begin
  delete from arclite.fills where window_id = p_window_id;
  delete from arclite.window_assets_matched where window_id = p_window_id;

  insert into arclite.fills (window_id, order_id, seq, asset_id, side,
                             quantity_raw, filled_raw, residual_raw, quote_raw, reason)
  select p_window_id, f.order_id, f.seq, f.asset_id, f.side,
         f.quantity_raw, f.filled_raw, f.residual_raw, f.quote_raw, f.reason::arclite.fill_reason
    from jsonb_to_recordset(p_fills) as f(
      order_id bigint, seq integer, asset_id integer, side text,
      quantity_raw numeric, filled_raw numeric, residual_raw numeric, quote_raw numeric, reason text
    );
  get diagnostics v_count = row_count;

  insert into arclite.window_assets_matched (window_id, asset_id, buy_total, sell_total, matched, deferred)
  select p_window_id, a.asset_id, a.buy_total, a.sell_total, a.matched, a.deferred
    from jsonb_to_recordset(p_assets) as a(
      asset_id integer, buy_total numeric, sell_total numeric, matched numeric, deferred boolean
    );

  update arclite.orders o
     set status = 'MATCHED'
    from arclite.fills f
   where f.order_id = o.id and f.window_id = p_window_id;

  update arclite.windows
     set fill_count = v_count, gross_value = p_gross, matcher_ran_at = now()
   where id = p_window_id;

  return v_count;
end;
$$;

-- Windows that have been priced on chain but not yet matched. The matcher runs after pricing,
-- never before: it crosses at the reference the contract committed, not one we chose.
create or replace function arclite.windows_needing_match(p_chain_id integer)
returns table (id bigint, seq bigint, chain_window_id bigint)
language sql
as $$
  select w.id, w.seq, w.chain_window_id
    from arclite.windows w
   where w.chain_id = p_chain_id
     and w.priced_tx is not null
     -- Not `matched_at`: that is the FSM's own status timestamp, set whether or not a matcher
     -- ever ran.
     and w.matcher_ran_at is null
     and w.status not in ('VOID', 'FAILED')
   order by w.seq
   limit 4;
$$;

alter table arclite.fills enable row level security;
alter table arclite.window_assets_matched enable row level security;
