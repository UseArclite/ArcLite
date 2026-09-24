-- The window FSM ran ahead of the chain, so nothing ever settled.
--
-- `advance_windows` drove SEALED -> MATCHING -> MATCHED -> PROVING -> SETTLING -> SETTLED with
-- five unconditional updates in a single call. They were written in Phase 2, when there was no
-- matcher and no prover, and the comment above them said "each becomes a real await as the
-- pieces land". They never did.
--
-- So a window sealed in the database reached SETTLED before it had been sealed on chain, priced,
-- matched or proved. `settleMatchedWindows` selects on `matcher_ran_at is not null and
-- settled_tx is null`, which such a window never satisfies — it had already sailed past. The
-- venue advanced 141 windows, settled none of them, and every one of them ended in a status
-- saying it had. `/api/health` reported `ok`, the crons reported no errors, and the only visible
-- trace was `settled_off_chain_only`, labelled "informational, not an alarm".
--
-- Each transition now waits on the evidence that the step actually happened. An empty window
-- skips to SETTLED, because there is nothing to seal, price, match or prove — and leaving it in
-- MATCHING forever would block the next window through the partial unique index on OPEN.
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

  -- Drive the middle of the lifecycle — but only as far as the real work has actually got.
  --
  -- These five transitions used to be unconditional, written when there was no matcher and no
  -- prover and marked "each becomes a real await as the pieces land". They never did. So a
  -- window sealed in the database walked SEALED -> MATCHING -> MATCHED -> PROVING -> SETTLING ->
  -- SETTLED inside one call, before it had been sealed on chain, priced, matched or proved — and
  -- `settleMatchedWindows` looks for `matcher_ran_at is not null and settled_tx is null`, which
  -- such a window never satisfies. The venue advanced 141 windows and settled none of them, and
  -- every one of them ended in a status that says it did.
  --
  -- Each step now waits on the evidence that it happened:
  --
  --   SEALED   -> MATCHING  the pool has the book, and the contract has committed prices
  --   MATCHING -> MATCHED   the matcher wrote fills
  --   MATCHED  -> PROVING   a settlement transaction is on chain
  --   PROVING  -> SETTLED   (via SETTLING, same evidence)
  --
  -- A window with no orders has nothing to seal, price, match or prove, so `order_count = 0`
  -- satisfies every step. It still walks each one: the transition trigger rejects a jump
  -- straight to SETTLED, and it is right to — a status that skips stages is a status nobody can
  -- reason about afterwards. Leaving quiet windows stuck instead would block the next one, since
  -- the partial unique index allows only one live window per chain.
  update arclite.windows
     set status = 'MATCHING'
   where chain_id = p_chain_id and status = 'SEALED'
     and (order_count = 0 or ((sealed_tx is not null or chain_reconciled) and priced_at is not null));

  update arclite.windows
     set status = 'MATCHED', matched_at = coalesce(matched_at, now())
   where chain_id = p_chain_id and status = 'MATCHING'
     and (order_count = 0 or matcher_ran_at is not null);

  update arclite.windows
     set status = 'PROVING'
   where chain_id = p_chain_id and status = 'MATCHED'
     and (order_count = 0 or settled_tx is not null);

  update arclite.windows
     set status = 'SETTLING', proved_at = coalesce(proved_at, now())
   where chain_id = p_chain_id and status = 'PROVING'
     and (order_count = 0 or settled_tx is not null);

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