-- A window that failed must give the notes back.
--
-- `orders_commitment_idx` was unconditionally unique on `commitment`, so a note offered once
-- could never be offered again — including when the window it was offered into failed and the
-- note was never spent. No nullifier is published until settlement, so those notes are still
-- sitting in the tree, still perfectly spendable by their owner, and permanently unusable by
-- this venue. One bad window bricked every note in it: withdrawable forever, tradable never.
--
-- It went unnoticed because it needs a window to fail *and* the same trader to come back, and
-- until mainnet no window had ever failed with a real book in it.
--
-- The index was always meant to stop the live double-offer: one note, one open order, because a
-- note is spent whole and two orders against it would be the owner double-spending their own
-- funds. `submit_order` already reads `status <> 'REJECTED'` for its per-account count, so
-- REJECTED was already understood to mean "this one no longer counts" — the index simply did
-- not agree. Now it does.
drop index if exists arclite.orders_commitment_idx;

create unique index orders_commitment_idx
  on arclite.orders (commitment)
  where status <> 'REJECTED';

comment on index arclite.orders_commitment_idx is
  'One live offer per note. A rejected order releases its commitment so the note — never spent, '
  'because nullifiers are only published at settlement — can be offered again.';

-- Rejecting the orders is what makes the index above take effect, and it is also just true: a
-- window that reached VOID or FAILED settled nothing, so every order in it is an order that
-- never happened.
create or replace function arclite.release_orders_of_dead_windows(p_chain_id integer)
returns integer
language plpgsql
as $$
declare v_count integer;
begin
  update arclite.orders o
     set status = 'REJECTED'
    from arclite.windows w
   where w.id = o.window_id
     and w.chain_id = p_chain_id
     and w.status in ('VOID', 'FAILED')
     and o.status <> 'REJECTED';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function arclite.release_orders_of_dead_windows is
  'Mark orders of VOID/FAILED windows REJECTED so their notes can be offered again. Safe to '
  'call repeatedly; the tick does so.';

-- Repair what is already stuck, on every chain rather than one.
do $$
declare r record;
begin
  for r in select distinct chain_id from arclite.windows loop
    perform arclite.release_orders_of_dead_windows(r.chain_id);
  end loop;
end $$;
