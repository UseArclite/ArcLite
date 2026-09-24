#!/usr/bin/env bash
# Apply every migration to a throwaway local Postgres and assert the schema's own invariants.
#
# Supabase's own CLI needs Docker; this needs only a local postgres, so it runs in CI and on a
# laptop without one. It is not a substitute for applying against Supabase — pg_cron, pg_net and
# the auth schema are not exercised here — but it catches the errors that actually happen:
# syntax, ordering, constraint logic.
#
#   ./scripts/validate-migrations.sh
set -euo pipefail

DB="${1:-arclite_validate}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v psql >/dev/null || { echo "psql not found"; exit 1; }
pg_isready -q || { echo "postgres is not accepting connections"; exit 1; }

echo "==> recreating $DB"
dropdb --if-exists "$DB"
createdb "$DB"

# Supabase provides these roles; create them so GRANT/POLICY statements validate.
psql -q -d "$DB" -c "do \$\$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
end \$\$;"

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "==> applying $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"
done

echo "==> asserting invariants"
psql -v ON_ERROR_STOP=1 -q -d "$DB" <<'SQL'
do $$
declare n integer;
begin
  -- addresses must be canonicalised on write, not merely format-checked: citext makes the
  -- format regex case-insensitive, so the CHECK alone lets mixed case through.
  insert into arclite.assets (chain_id, contract_address, token_symbol, token_name, token_decimals, kind)
  values (1, '0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333', 'TEST', 'Test', 18, 'STOCK');
  select count(*) into n from arclite.assets
   where token_symbol = 'TEST' and contract_address::text = lower(contract_address::text);
  if n <> 1 then raise exception 'address was not normalised to lowercase'; end if;

  -- at most one quote asset per chain
  begin
    insert into arclite.assets (chain_id, contract_address, token_symbol, token_name, token_decimals, kind, is_quote)
    values (1, '0x1111111111111111111111111111111111111111', 'Q1', 'Quote 1', 6, 'STABLE', true);
    insert into arclite.assets (chain_id, contract_address, token_symbol, token_name, token_decimals, kind, is_quote)
    values (1, '0x2222222222222222222222222222222222222222', 'Q2', 'Quote 2', 6, 'STABLE', true);
    raise exception 'two quote assets were allowed on one chain';
  exception when unique_violation then null;
  end;

  -- a TREASURY asset without a NAV age bound is unpriceable, so it must not be storable
  begin
    insert into arclite.assets (chain_id, contract_address, token_symbol, token_name, token_decimals, kind)
    values (1, '0x3333333333333333333333333333333333333333', 'T1', 'Treasury', 18, 'TREASURY');
    raise exception 'TREASURY without nav_max_age_seconds was allowed';
  exception when check_violation then null;
  end;

  -- the weekend-staleness fix: CLOSED must be wide and non-crossing
  select max_price_age_seconds into n from arclite.session_policy where session = 'CLOSED';
  if n < 172800 then raise exception 'CLOSED bound too tight: equity feeds are stale by design when markets shut'; end if;
  if (select allow_crossing from arclite.session_policy where session = 'CLOSED') then
    raise exception 'CLOSED must not allow crossing';
  end if;

  -- cron lock must be exclusive while leased, reclaimable after expiry
  if not coalesce(arclite.try_lock('t', 'a', 60), false) then raise exception 'first lock failed'; end if;
  if coalesce(arclite.try_lock('t', 'b', 60), false) then raise exception 'lock was not exclusive'; end if;
  update arclite.cron_locks set lease_until = now() - interval '1s' where name = 't';
  if not coalesce(arclite.try_lock('t', 'c', 60), false) then raise exception 'expired lock not reclaimable'; end if;

  raise notice 'reference-data invariants hold';
end $$;
SQL

psql -v ON_ERROR_STOP=1 -q -d "$DB" <<'SQL'
do $$
declare r jsonb; n integer; wid bigint;
begin
  -- A tick with no live window must open exactly one, and must be safe to repeat.
  r := arclite.advance_windows(4663, 300, 3600);
  if (r->>'opened')::int <> 1 then raise exception 'first tick did not open a window: %', r; end if;
  r := arclite.advance_windows(4663, 300, 3600);
  if (r->>'opened')::int <> 0 then raise exception 'second tick opened a duplicate window: %', r; end if;

  select count(*) into n from arclite.windows
   where chain_id = 4663 and status in ('OPEN','SEALED','MATCHING','MATCHED','PROVING','SETTLING');
  if n <> 1 then raise exception 'expected exactly one live window, found %', n; end if;

  -- A window seals because its time arrived, not because a tick fired. Simulate the clock
  -- passing rather than calling the tick more often.
  select id into wid from arclite.windows where chain_id = 4663 and status = 'OPEN';
  -- Wind the whole window back, not just seals_at: the schema (correctly) refuses a window
  -- whose seal precedes its open.
  update arclite.windows
     set opens_at = now() - interval '10 minutes', seals_at = now() - interval '1 second'
   where id = wid;
  r := arclite.advance_windows(4663, 300, 3600);
  if (r->>'sealed')::int <> 1 then raise exception 'overdue window did not seal: %', r; end if;
  if (r->>'settled')::int <> 1 then raise exception 'sealed window did not run through to settled: %', r; end if;

  -- A window with a book waits. The five lifecycle transitions were unconditional, written when
  -- there was no matcher and no prover, so a sealed window reached SETTLED before it had been
  -- sealed on chain, priced, matched or proved — and the settler selects on `matcher_ran_at is
  -- not null and settled_tx is null`, which such a window never satisfies. 141 windows advanced
  -- and none settled, each ending in a status saying it had.
  r := arclite.advance_windows(4663, 300, 3600);
  select id into wid from arclite.windows where chain_id = 4663 and status = 'OPEN';
  update arclite.windows
     set opens_at = now() - interval '10 minutes', seals_at = now() - interval '1 second',
         order_count = 3
   where id = wid;
  r := arclite.advance_windows(4663, 300, 3600);
  if (select status from arclite.windows where id = wid) <> 'SEALED' then
    raise exception 'a window with a book advanced past SEALED with no chain evidence: %',
      (select status from arclite.windows where id = wid);
  end if;

  -- Give it the evidence one step at a time; it should move exactly one step each time.
  update arclite.windows set chain_reconciled = true, priced_at = now() where id = wid;
  perform arclite.advance_windows(4663, 300, 3600);
  if (select status from arclite.windows where id = wid) <> 'MATCHING' then
    raise exception 'a priced window did not reach MATCHING';
  end if;

  update arclite.windows set matcher_ran_at = now() where id = wid;
  perform arclite.advance_windows(4663, 300, 3600);
  if (select status from arclite.windows where id = wid) <> 'MATCHED' then
    raise exception 'a matched window did not reach MATCHED';
  end if;

  update arclite.windows set settled_tx = '0x' || repeat('c', 64) where id = wid;
  perform arclite.advance_windows(4663, 300, 3600);
  if (select status from arclite.windows where id = wid) <> 'SETTLED' then
    raise exception 'a settled window did not reach SETTLED: %',
      (select status from arclite.windows where id = wid);
  end if;
  -- A settled window frees the slot, so the next tick opens the next one. Checked with its own
  -- call: the `r` from several steps ago describes a different moment entirely.
  select count(*) into n from arclite.windows where chain_id = 4663 and status = 'OPEN';
  if n <> 1 then
    r := arclite.advance_windows(4663, 300, 3600);
    if (r->>'opened')::int <> 1 then
      raise exception 'next window did not open after settlement: %', r;
    end if;
  end if;

  -- Terminal means terminal: a late tick must not resurrect a settled window.
  begin
    update arclite.windows set status = 'OPEN' where id = wid;
    raise exception 'a SETTLED window was moved back to OPEN';
  exception when check_violation then null;
  end;

  -- Skipping the middle of the lifecycle must be impossible from any caller.
  select id into wid from arclite.windows where chain_id = 4663 and status = 'OPEN';
  begin
    update arclite.windows set status = 'SETTLED' where id = wid;
    raise exception 'OPEN jumped straight to SETTLED';
  exception when check_violation then null;
  end;

  -- A stuck window past its deadline must void, so it cannot block the next one behind the
  -- one-live-window index.
  update arclite.windows
     set opens_at = now() - interval '20 minutes',
         seals_at = now() - interval '10 minutes',
         deadline_at = now() - interval '1 second',
         status = 'SEALED',
         sealed_at = now() - interval '10 minutes'
   where id = wid;
  r := arclite.advance_windows(4663, 300, 3600);
  if (r->>'voided')::int <> 1 then raise exception 'overdue window did not void: %', r; end if;

  raise notice 'window FSM invariants hold';
end $$;
SQL

psql -v ON_ERROR_STOP=1 -q -d "$DB" <<'SQL'
do $$
declare ok boolean; n integer; exp timestamptz; addr citext; h bytea; v_nonce text; v_stale text;
begin
  h := sha256('token-a'::bytea);
  -- 96 hex characters, the shape viem's generateSiweNonce actually emits. A short hand-written
  -- nonce here passed the CHECK while the real one did not, which is exactly the gap this
  -- fixture closes.
  v_nonce := encode(sha256('n1'::bytea), 'hex') || encode(sha256('n2'::bytea), 'hex');
  v_stale := encode(sha256('n3'::bytea), 'hex') || encode(sha256('n4'::bytea), 'hex');

  -- A nonce is single-use. This is the whole replay defence, so assert it rather than trusting
  -- that the UPDATE's WHERE clause says what it looks like it says.
  perform arclite.issue_nonce(v_nonce, 600);
  if not coalesce(arclite.consume_nonce(v_nonce), false) then
    raise exception 'a fresh nonce could not be consumed';
  end if;
  if coalesce(arclite.consume_nonce(v_nonce), false) then
    raise exception 'a nonce was consumed twice';
  end if;

  -- An expired nonce is not claimable, even though the row still exists.
  perform arclite.issue_nonce(v_stale, 600);
  -- Wind the whole row back, not just expires_at: the CHECK (correctly) refuses a nonce that
  -- expires before it was issued.
  update arclite.auth_nonces
     set issued_at = now() - interval '10 minutes', expires_at = now() - interval '1s'
   where nonce = v_stale;
  if coalesce(arclite.consume_nonce(v_stale), false) then
    raise exception 'an expired nonce was consumed';
  end if;

  -- An unknown nonce must not be forgeable into existence by consuming it.
  if coalesce(arclite.consume_nonce('neverIssued000001'), false) then
    raise exception 'an unissued nonce was consumed';
  end if;

  -- Sessions: mixed case in, lowercase stored. Same citext trap as assets.
  perform arclite.open_session(h, '0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333'::citext, 46630, 3600);
  select count(*) into n from arclite.sessions
   where token_hash = h and address::text = lower(address::text);
  if n <> 1 then raise exception 'session address was not normalised to lowercase'; end if;

  -- Lookup resolves, and resolves case-insensitively to the canonical form.
  select s.address into addr from arclite.session_account(h) s;
  if addr::text <> '0xaaaabbbbccccddddeeeeffff0000111122223333' then
    raise exception 'session_account returned %', addr;
  end if;

  -- A revoked session is gone immediately, not at expiry.
  if not coalesce(arclite.revoke_session(h), false) then raise exception 'revoke failed'; end if;
  select count(*) into n from arclite.session_account(h);
  if n <> 0 then raise exception 'a revoked session still resolves'; end if;
  if coalesce(arclite.revoke_session(h), false) then raise exception 'revoke was not idempotent'; end if;

  -- An expired session is gone too, without needing a sweeper to have run.
  h := sha256('token-b'::bytea);
  perform arclite.open_session(h, '0x1111111111111111111111111111111111111111'::citext, 46630, 3600);
  update arclite.sessions
     set issued_at = now() - interval '2 hours', expires_at = now() - interval '1s'
   where token_hash = h;
  select count(*) into n from arclite.session_account(h);
  if n <> 0 then raise exception 'an expired session still resolves'; end if;

  -- The token itself must never be storable in place of its digest.
  begin
    insert into arclite.sessions (token_hash, address, chain_id, expires_at)
    values ('\x00'::bytea, '0x2222222222222222222222222222222222222222'::citext, 46630, now() + interval '1h');
    raise exception 'a non-32-byte token_hash was accepted';
  exception when check_violation then null;
  end;

  raise notice 'session invariants hold';
end $$;
SQL

psql -v ON_ERROR_STOP=1 -q -d "$DB" <<'SQL'
do $$
declare r jsonb; wid bigint; wid2 bigint; n integer; st record;
begin
  -- The reconciliation this migration exists for: a window sealed in the database but not on
  -- chain means the venue's clock says the book is frozen while the pool has never heard of it.
  r := arclite.advance_windows(99, 300, 3600);
  select id into wid from arclite.windows where chain_id = 99 and status = 'OPEN';
  update arclite.windows
     set opens_at = now() - interval '10 minutes', seals_at = now() - interval '1 second',
         -- A book, because an empty window has nothing to seal and is deliberately not counted.
         -- Before that exclusion the alarm read 136 permanently — every window the venue had
         -- ever opened with nothing in it — and an alarm that is always on is not an alarm.
         order_count = 2
   where id = wid;
  r := arclite.advance_windows(99, 300, 3600);

  -- Straight after sealing, nothing has been sent to the chain.
  select * into st from arclite.window_chain_state(99);
  if st.unsealed_on_chain < 1 then
    raise exception 'a window sealed in the database did not register as unsealed on chain';
  end if;

  -- A retired window's error must not linger in health. It reported one from a window dealt
  -- with hours earlier, beside `ok: true` — an alarm that can never clear, which is this
  -- morning's alarm-that-never-fires the other way round.
  update arclite.windows set chain_error = 'something went wrong' where id = wid;
  select * into st from arclite.window_chain_state(99);
  if st.last_chain_error is null then
    raise exception 'a live window''s error was not reported';
  end if;
  update arclite.windows set chain_error = null where id = wid;

  -- An empty window must not sit in the seal queue. It cannot be sealed — `sealWindow` on an
  -- empty book pays gas to say nothing — so leaving it there fills a bounded queue with work
  -- that will never leave it, and a window with a real book never reaches the front.
  update arclite.windows set order_count = 0 where id = wid;
  select count(*) into n from arclite.windows_needing_chain_seal(99);
  if n <> 0 then raise exception 'an empty window was queued for a chain seal'; end if;
  update arclite.windows set order_count = 2 where id = wid;
  select count(*) into n from arclite.windows_needing_chain_seal(99);
  if n <> 1 then raise exception 'a window with a book was not queued for a chain seal'; end if;

  -- And an empty one does not raise it, however far past OPEN it has travelled.
  update arclite.windows set order_count = 0 where id = wid;
  select * into st from arclite.window_chain_state(99);
  if st.unsealed_on_chain <> 0 then
    raise exception 'an empty window was counted as unsealed on chain';
  end if;
  update arclite.windows set order_count = 2 where id = wid;

  -- A window knows its chain id from the moment it opens, because that is what a trader signs
  -- their spend against — hours before the sealer computes anything.
  select count(*) into n from arclite.windows where chain_id = 99 and chain_window_id is null;
  if n <> 0 then raise exception 'a window opened without a chain id'; end if;

  perform arclite.record_chain_seal(wid, 4242, '0x' || repeat('a', 64), sha256('book'::bytea));
  select count(*) into n from arclite.windows where id = wid and chain_window_id = 4242;
  if n <> 1 then raise exception 'chain seal was not recorded'; end if;

  -- One on-chain window id per chain: reusing one would silently merge two books. Against a
  -- second *real* window, because `record_chain_seal` on an id that does not exist updates
  -- nothing and raises nothing — which would pass this test while proving the opposite.
  -- Finish the sealed window so another can open: the partial unique index allows one live
  -- window per chain, and the FSM (correctly) will not advance one whose chain work is unproven.
  update arclite.windows set order_count = 0 where id = wid;
  r := arclite.advance_windows(99, 300, 3600);
  update arclite.windows set order_count = 2 where id = wid;
  r := arclite.advance_windows(99, 300, 3600);
  select id into wid2 from arclite.windows
   where chain_id = 99 and id <> wid order by seq desc limit 1;
  if wid2 is null then raise exception 'the fixture needs a second window to collide with'; end if;
  begin
    perform arclite.record_chain_seal(wid2, 4242, '0x' || repeat('b', 64), sha256('x'::bytea));
    raise exception 'a duplicate chain_window_id was allowed';
  exception when unique_violation then null;
  end;

  -- A transaction hash must look like one, or a monitor will happily link to nothing.
  begin
    update arclite.windows set priced_tx = 'not-a-hash' where id = wid;
    raise exception 'a malformed transaction hash was accepted';
  exception when check_violation then null;
  end;

  perform arclite.record_chain_prices(wid, '0x' || repeat('c', 64), sha256('prices'::bytea), 0, now());
  select * into st from arclite.window_chain_state(99);
  if st.unpriced_on_chain <> 0 then raise exception 'priced window still reads as unpriced'; end if;

  -- A revert is a fact about the window, not an exception to lose.
  perform arclite.record_chain_error(wid, 'execution reverted: WindowAlreadySealed(4242)');
  select * into st from arclite.window_chain_state(99);
  if st.last_chain_error is null then raise exception 'chain error was not retained'; end if;

  raise notice 'on-chain window invariants hold';
end $$;
SQL

psql -v ON_ERROR_STOP=1 -q -d "$DB" <<'SQL'
do $$
declare r record; wid bigint; oid bigint; n integer;
begin
  perform arclite.advance_windows(77, 300, 3600);
  select id into wid from arclite.windows where chain_id = 77 and status = 'OPEN';

  -- A first order is accepted.
  select * into r from arclite.submit_order(77, 1, sha256('acct'::bytea), sha256('c1'::bytea),
    sha256('n1'::bytea), 'ct'::bytea, sha256('ct'::bytea), 8);
  if not r.ok then raise exception 'a valid order was rejected: %', r.reason; end if;
  oid := r.order_id;

  -- A note may be offered once, ever. Not once per window: offering it into two windows at the
  -- same time and matching in both is the attack.
  select * into r from arclite.submit_order(77, 1, sha256('acct'::bytea), sha256('c1'::bytea),
    sha256('n2'::bytea), 'ct'::bytea, sha256('ct'::bytea), 8);
  if r.ok then raise exception 'a duplicate commitment was accepted'; end if;
  if r.reason not like '%already been offered%' then
    raise exception 'duplicate rejected with an unhelpful reason: %', r.reason;
  end if;

  -- Rate limit, per account per window.
  for i in 2..8 loop
    select * into r from arclite.submit_order(77, 1, sha256('acct'::bytea),
      sha256(('c' || i)::bytea), sha256(('n' || i)::bytea), 'ct'::bytea, sha256('ct'::bytea), 8);
    if not r.ok then raise exception 'order % rejected early: %', i, r.reason; end if;
  end loop;
  select * into r from arclite.submit_order(77, 1, sha256('acct'::bytea), sha256('c99'::bytea),
    sha256('n99'::bytea), 'ct'::bytea, sha256('ct'::bytea), 8);
  if r.ok then raise exception 'the rate limit did not bind'; end if;

  -- A different account in the same window is unaffected: the limit is per account, not global.
  select * into r from arclite.submit_order(77, 1, sha256('other'::bytea), sha256('c100'::bytea),
    sha256('n100'::bytea), 'ct'::bytea, sha256('ct'::bytea), 8);
  if not r.ok then raise exception 'the rate limit leaked across accounts: %', r.reason; end if;

  -- Past the seal time, nothing more gets in — even if the tick has not run yet and the row
  -- still says OPEN.
  -- Wind the whole window back: the schema refuses a seal that precedes its own open.
  update arclite.windows
     set opens_at = now() - interval '10 minutes', seals_at = now() - interval '1 second'
   where id = wid;
  select * into r from arclite.submit_order(77, 1, sha256('late'::bytea), sha256('c200'::bytea),
    sha256('n200'::bytea), 'ct'::bytea, sha256('ct'::bytea), 8);
  if r.ok then raise exception 'an order was accepted after the seal time'; end if;

  -- A revealed order must be complete. A half-revealed one would break the orders root and the
  -- matcher at once.
  begin
    update arclite.orders set status = 'REVEALED' where id = oid;
    raise exception 'a REVEALED order with no contents was allowed';
  exception when check_violation then null;
  end;

  -- A revealed order with no authorisation must not be storable: it could never be settled,
  -- and finding that out inside a proof is far worse than finding it out here.
  begin
    update arclite.orders
       set status = 'REVEALED', seq = 0, asset_id = 1, side = 'buy',
           quantity_raw = 30, owner_field = 111, salt_field = 555
     where id = oid;
    raise exception 'a REVEALED order with no signature was allowed';
  exception when check_violation then null;
  end;

  perform arclite.reveal_order(oid, 0, 1, 'buy', 30, 500, 111, 555, 1, 2, 3, 4, 5, 6, 7);
  select count(*) into n from arclite.orders where id = oid and status = 'REVEALED' and seq = 0;
  if n <> 1 then raise exception 'reveal did not record the order'; end if;

  -- Revealing is once. A second call must not renumber an order already in the book.
  perform arclite.reveal_order(oid, 5, 1, 'sell', 99, 99, 1, 1, 1, 2, 3, 4, 5, 6, 7);
  select quantity_raw into n from arclite.orders where id = oid;
  if n <> 30 then raise exception 'a revealed order was rewritten'; end if;

  -- The note is not the order. A buy is funded with a quote note, so its units are USDG while
  -- the order's are base units: the two numbers are unrelated and the column has to carry both.
  select note_units_raw into n from arclite.orders where id = oid;
  if n <> 500 then raise exception 'the spent note''s units were not recorded'; end if;

  -- The sealing key must be withholdable: null secret until the book closes.
  insert into arclite.window_keys (window_id, public_key) values (wid, sha256('pk'::bytea));
  select count(*) into n from arclite.window_keys where window_id = wid and secret_key is null;
  if n <> 1 then raise exception 'a window key was created with its secret already present'; end if;

  -- TLOCK without a round is unsealable, so it must be unstorable.
  begin
    update arclite.window_keys set seal_mode = 'TLOCK' where window_id = wid;
    raise exception 'TLOCK without a drand round was allowed';
  exception when check_violation then null;
  end;

  raise notice 'order intake invariants hold';
end $$;
SQL

psql -v ON_ERROR_STOP=1 -q -d "$DB" <<'SQL'
do $$
declare wid bigint; wid2 bigint; oid bigint; n integer; i integer; stat text; r record; st2 record;
begin
  perform arclite.advance_windows(88, 300, 3600);
  select id into wid from arclite.windows where chain_id = 88 and status = 'OPEN';
  select * into r from arclite.submit_order(88, 1, sha256('a'::bytea), sha256('m1'::bytea),
    sha256('m2'::bytea), 'ct'::bytea, sha256('ct'::bytea), 8);
  oid := r.order_id;
  perform arclite.reveal_order(oid, 0, 1, 'buy', 30, 500, 111, 555, 1, 2, 3, 4, 5, 6, 7);

  -- A fill that exceeds its order is a mint. The circuit asserts it too; asserting it here
  -- catches a matcher bug before a proof is attempted rather than as an unsatisfiable constraint.
  begin
    insert into arclite.fills (window_id, order_id, seq, asset_id, side,
      quantity_raw, filled_raw, residual_raw, quote_raw, reason)
    values (wid, oid, 0, 1, 'buy', 30, 40, 0, 100, 'matched');
    raise exception 'a fill larger than its order was allowed';
  exception when check_violation then null;
  end;

  -- filled + residual must equal the order, or units vanish.
  begin
    insert into arclite.fills (window_id, order_id, seq, asset_id, side,
      quantity_raw, filled_raw, residual_raw, quote_raw, reason)
    values (wid, oid, 0, 1, 'buy', 30, 10, 10, 100, 'partial');
    raise exception 'a fill that did not conserve was allowed';
  exception when check_violation then null;
  end;

  -- The reason must agree with the numbers: the dashboard renders this string and the circuit
  -- constrains it, so a row where they disagree is a rendered claim the proof would refute.
  begin
    insert into arclite.fills (window_id, order_id, seq, asset_id, side,
      quantity_raw, filled_raw, residual_raw, quote_raw, reason)
    values (wid, oid, 0, 1, 'buy', 30, 15, 15, 100, 'matched');
    raise exception 'a partial fill labelled matched was allowed';
  exception when check_violation then null;
  end;

  -- A whole match, recorded in one call.
  n := arclite.record_match(wid,
    jsonb_build_array(jsonb_build_object('order_id', oid, 'seq', 0, 'asset_id', 1, 'side', 'buy',
      'quantity_raw', 30, 'filled_raw', 15, 'residual_raw', 15, 'quote_raw', 3336, 'reason', 'partial')),
    jsonb_build_array(jsonb_build_object('asset_id', 1, 'buy_total', 30, 'sell_total', 15,
      'matched', 15, 'deferred', false)),
    3336);
  if n <> 1 then raise exception 'record_match wrote % fills', n; end if;
  select count(*) into n from arclite.orders where id = oid and status = 'MATCHED';
  if n <> 1 then raise exception 'the order was not marked matched'; end if;

  -- Liquidity cannot be withheld: matched must be the whole of the smaller side.
  begin
    update arclite.window_assets_matched set matched = 5 where window_id = wid;
    raise exception 'a withheld match was allowed';
  exception when check_violation then null;
  end;

  -- Re-running a match replaces rather than duplicates. Replay must be byte-identical, not
  -- additive, or a retried tick would double every fill.
  n := arclite.record_match(wid,
    jsonb_build_array(jsonb_build_object('order_id', oid, 'seq', 0, 'asset_id', 1, 'side', 'buy',
      'quantity_raw', 30, 'filled_raw', 15, 'residual_raw', 15, 'quote_raw', 3336, 'reason', 'partial')),
    jsonb_build_array(jsonb_build_object('asset_id', 1, 'buy_total', 30, 'sell_total', 15,
      'matched', 15, 'deferred', false)),
    3336);
  select count(*) into n from arclite.fills where window_id = wid;
  if n <> 1 then raise exception 'replaying a match duplicated fills: %', n; end if;

  -- A window that cannot settle has to leave the settler's queue. It takes the oldest matched
  -- window, `order by seq limit 1`, so one permanent failure at the head blocks every window
  -- behind it — indistinguishable from a venue that has stopped settling.
  -- Past OPEN, because that is where the settler sees it, and the transition trigger rightly
  -- refuses to fail a window that is still taking orders.
  update arclite.windows
     set opens_at = now() - interval '10 minutes', seals_at = now() - interval '1 second',
         order_count = 1
   where id = wid;
  perform arclite.advance_windows(88, 300, 3600);
  update arclite.windows set matcher_ran_at = now() where id = wid;
  for i in 1..arclite.max_settle_attempts() loop
    perform arclite.record_chain_error(wid, 'the same error every time');
  end loop;
  select status into stat from arclite.windows where id = wid;
  if stat <> 'FAILED' then
    raise exception 'a window that could never settle stayed in the queue: %', stat;
  end if;

  -- And its error stops being reported. A window the venue has given up on has nothing
  -- outstanding, so health showing its message beside `ok: true` is an alarm that never clears.
  select * into st2 from arclite.window_chain_state(88);
  if st2.last_chain_error is not null then
    raise exception 'a failed window''s error was still reported: %', st2.last_chain_error;
  end if;

  -- And a window that has not been matched is left alone: it is failing for some other reason
  -- and has its own way out.
  select id into wid2 from arclite.windows where id <> wid order by id desc limit 1;
  update arclite.windows set matcher_ran_at = null where id = wid2;
  for i in 1..arclite.max_settle_attempts() loop
    perform arclite.record_chain_error(wid2, 'not a settlement problem');
  end loop;
  select status into stat from arclite.windows where id = wid2;
  if stat = 'FAILED' then
    raise exception 'an unmatched window was failed by the settlement bound';
  end if;

  raise notice 'fill invariants hold';
end $$;
SQL

echo "==> ok"
dropdb "$DB"
