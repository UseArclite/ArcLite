-- A window that cannot settle blocked every window behind it, indefinitely.
--
-- `settleMatchedWindows` takes the oldest matched-but-unsettled window, `order by seq limit 1`.
-- When one of them cannot be settled at all — a revealed payload that does not rebuild its
-- commitment, a note that is not in the tree, any error that will be the same error next minute —
-- it stays at the head of that queue forever and nothing after it is ever attempted. One bad
-- window is indistinguishable from a venue that has stopped settling.
--
-- This is the third queue today with the same shape. The sealer starved behind empty windows
-- and the matcher had the same bound; both were fixed by excluding work that could never leave.
-- Here the work *might* leave — a transient RPC failure deserves a retry — so the bound is on
-- attempts rather than on eligibility.
--
-- `settle_attempts` counts them. Past the limit the window is FAILED, which takes it out of the
-- settler's queue and puts it in front of anyone reading health: `chain_error` says what went
-- wrong and `settle_attempts` says it was not a blip. Nothing is lost by giving up — settlement
-- publishes the nullifiers, so a window that never settled spent nothing and every note in it is
-- still whole. That is the same reason `voidWindow` is safe on chain.
alter table arclite.windows
  add column if not exists settle_attempts integer not null default 0;

comment on column arclite.windows.settle_attempts is
  'Settlement attempts made. Past arclite.MAX_SETTLE_ATTEMPTS the window is FAILED so it stops blocking the queue behind it; no value is at risk, because a window that never settled published no nullifiers.';

-- Generous, because the failure this bounds is cheap and the false positive is not: giving up on
-- a window whose RPC was briefly unreachable means a real book is abandoned. Ten attempts is ten
-- minutes at the current cadence.
create or replace function arclite.max_settle_attempts()
returns integer language sql immutable as $$ select 10 $$;

create or replace function arclite.record_chain_error(p_id bigint, p_error text)
returns void
language plpgsql
as $$
declare v_attempts integer;
begin
  update arclite.windows
     set chain_error = p_error,
         settle_attempts = settle_attempts + 1
   where id = p_id
  returning settle_attempts into v_attempts;

  -- Only a window that has actually been matched is failed here. One that has not reached the
  -- settler yet is erroring for some other reason and has its own path out — and an OPEN window
  -- is still taking orders, which the transition trigger rightly refuses to fail out of.
  if v_attempts >= arclite.max_settle_attempts() then
    update arclite.windows
       set status = 'FAILED'
     where id = p_id
       and matcher_ran_at is not null
       and settled_tx is null
       and status not in ('OPEN', 'VOID', 'FAILED');
  end if;
end;
$$;

-- One-off repair: windows the old FSM marked SETTLED without settling anything.
--
-- Before `0010`, `advance_windows` walked a window to SETTLED unconditionally. The ones that had
-- a book are now stuck: the settler still picks them up (it excludes only VOID and FAILED), they
-- fail every time, and SETTLED is terminal, so they can be neither settled nor failed. One of
-- them at the head of the queue blocks every window behind it forever.
--
-- FAILED is the accurate status. Nothing was spent — settlement is what publishes nullifiers, so
-- every note in these windows is still whole and still spendable — and their orders were simply
-- abandoned. The transition trigger is right to forbid SETTLED -> FAILED in normal operation, so
-- this suspends it for exactly this statement rather than weakening the rule.
do $$
begin
  alter table arclite.windows disable trigger windows_enforce_transition;

  update arclite.windows
     set status = 'FAILED',
         chain_error = coalesce(
           chain_error,
           'marked SETTLED by the pre-0010 FSM without ever being settled; no nullifiers were published, so every note in this window is still spendable'
         )
   where status = 'SETTLED'
     and settled_tx is null
     and order_count > 0;

  alter table arclite.windows enable trigger windows_enforce_transition;
end $$;
