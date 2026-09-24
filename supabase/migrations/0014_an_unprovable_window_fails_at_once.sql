-- A window that cannot prove will not prove on the tenth try either.
--
-- `record_chain_error` counts attempts and gives up at ten, which is right for a failure that
-- might be transient: an RPC timeout, a rate limit, a cold prover. It is wrong for a failure
-- that is arithmetic. A window's inputs are frozen at seal, its prices are committed on chain
-- and never change, and the prover is deterministic — so a book that violates a circuit
-- constraint violates it identically every time.
--
-- The case that prompted this: a buy of 1 NVDA funded by a $1 USDG note. The circuit range
-- checks `in_units - offered`, the shortfall went negative, a negative Field range-checks as
-- enormous, and `assert_max_bit_size` failed. That is not a blip. It sealed, priced, matched,
-- then failed to prove ten times across ten minutes while the window sat in the queue looking
-- like it might still recover.
--
-- The client now refuses such an order before it is ever submitted. This is the other half:
-- when something does slip past, the venue stops immediately instead of burning gas on a
-- verdict that is already decided.
--
-- Kept separate from `record_chain_error` rather than folded into it, because the caller is the
-- only thing that can tell a deterministic failure from a transient one — the message shape is
-- the evidence, and that lives in TypeScript next to the prover.
create or replace function arclite.fail_window_now(p_id bigint, p_error text)
returns void
language sql
as $$
  update arclite.windows
     set chain_error = p_error,
         -- Set rather than incremented: this is a verdict, not a tally, and leaving it below the
         -- limit would invite something to pick the window back up.
         settle_attempts = arclite.max_settle_attempts(),
         status = 'FAILED'
   where id = p_id
     -- Same guards as the attempt-counted path. A window still taking orders has no business
     -- being failed by the settler, and the transition trigger would refuse it anyway.
     and matcher_ran_at is not null
     and settled_tx is null
     and status not in ('OPEN', 'VOID', 'FAILED');
$$;

comment on function arclite.fail_window_now is
  'Fail a matched window immediately on a deterministic proving error, without spending the '
  'retry budget. Transient failures still go through record_chain_error.';
