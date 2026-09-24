-- `/api/health` reported an error from a window that had been dealt with hours earlier.
--
-- `last_chain_error` was the most recent non-null `chain_error` on any window, ever. A window
-- that failed and was retired — its notes untouched, its orders abandoned, nothing outstanding —
-- left its message there permanently, so health read `ok: true` beside
-- `orders_root disagrees with the chain: …` from a bug that was fixed and redeployed.
--
-- That is this morning's problem the other way round. `unsealed_on_chain` was an alarm that
-- could never fire because it counted windows nobody would ever seal; this is an alarm that can
-- never clear because it counts a window nobody will ever settle. Both make the endpoint say
-- something that is not about now, and both make a reader stop believing it.
--
-- VOID and FAILED are terminal: they mean the venue decided, not that something is wrong. The
-- error worth showing is one from a window still trying.
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
        and order_count > 0
    )::int,
    count(*) filter (
      where (sealed_tx is not null or chain_reconciled) and priced_at is null
    )::int,
    count(*) filter (
      where status = 'SETTLED' and settled_tx is null and order_count > 0
    )::int,
    bool_or(
      status in ('SEALED','MATCHING','MATCHED','PROVING','SETTLING')
      and (sealed_tx is not null or chain_reconciled)
      and deadline_at < now() - interval '15 minutes'
    ),
    (array_remove(array_agg(sealed_tx order by seq desc), null))[1],
    -- Only from a window that is still trying. A retired one has nothing outstanding to report.
    (array_remove(
      array_agg(chain_error order by seq desc)
        filter (where status not in ('VOID', 'FAILED') and settled_tx is null),
      null
    ))[1]
  from arclite.windows
  where chain_id = p_chain_id;
$$;
