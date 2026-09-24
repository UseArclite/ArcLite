-- The note an order spends is not the order.
--
-- Until now the revealed payload carried only `quantity_raw`, and the settler rebuilt the spent
-- note as `{asset_id, quantity_raw}`. That held together only because both sides of a trade were
-- assumed to spend a note of the asset being traded — which made a buy a no-op: the buyer spent a
-- note of the asset, received the same asset back, and the quote leg was never funded by anyone.
--
-- A buyer funds the trade with a quote note instead, so two facts the payload never carried now
-- matter: which asset the note holds (derivable — quote for a buy, the traded asset for a sell)
-- and how many units it holds, which is no longer equal to the order's quantity. A 300 USDG note
-- can back a 222.45 USDG order and keep the change.
alter table arclite.orders
  add column note_units_raw numeric(78, 0) check (note_units_raw is null or note_units_raw > 0);

comment on column arclite.orders.note_units_raw is
  'Units held by the note this order spends. A note is spent whole, so the unspent remainder comes back as a fresh note; this is what the circuit calls in_units.';

-- Revealed orders must carry it. Written as a separate constraint rather than folded into the
-- existing one so an older row that predates the column is not retroactively invalid.
alter table arclite.orders
  add constraint orders_revealed_note_units check (
    status <> 'REVEALED' or note_units_raw is not null
  ) not valid;

drop function if exists arclite.reveal_order(bigint, integer, integer, text, numeric, numeric,
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric);

create or replace function arclite.reveal_order(
  p_id bigint, p_seq integer, p_asset_id integer, p_side text,
  p_quantity numeric, p_note_units numeric, p_owner numeric, p_salt numeric,
  p_pk_x numeric, p_pk_y numeric, p_npk numeric,
  p_sig_s_lo numeric, p_sig_s_hi numeric, p_sig_e_lo numeric, p_sig_e_hi numeric
)
returns void
language sql
as $$
  update arclite.orders
     set status = 'REVEALED', seq = p_seq, asset_id = p_asset_id, side = p_side,
         quantity_raw = p_quantity, note_units_raw = p_note_units,
         owner_field = p_owner, salt_field = p_salt,
         pk_x = p_pk_x, pk_y = p_pk_y, npk = p_npk,
         sig_s_lo = p_sig_s_lo, sig_s_hi = p_sig_s_hi,
         sig_e_lo = p_sig_e_lo, sig_e_hi = p_sig_e_hi,
         revealed_at = now(), reject_reason = null
   where id = p_id and status = 'SEALED';
$$;
