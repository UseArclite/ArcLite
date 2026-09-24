-- ArcLite RH — migration 0007: the owner's authorisation for a spend.
--
-- Until now a revealed order carried everything needed to *construct* a spend: the owner field
-- and the note secret. That meant whoever ran the sealer could replay a trader's note into a
-- later batch and cross it again. Knowing a secret is not the same as being allowed to use it.
--
-- `batch_cross` now verifies a Schnorr signature over (window, asset, side, quantity, nullifier)
-- under the key `owner` commits to. These columns carry it. They are revealed fields, written by
-- the sealer from the decrypted payload — never by the submitter.

alter table arclite.orders
  -- The Grumpkin public key `owner = poseidon2([pk_x, pk_y, npk])` commits to. Stored as
  -- numeric(78,0) like every other field element: these are 254-bit values and a bigint would
  -- silently truncate them.
  add column pk_x     numeric(78, 0),
  add column pk_y     numeric(78, 0),
  add column npk      numeric(78, 0),
  -- The signature, split at 2^128 the way the circuit's EmbeddedCurveScalar carries it.
  add column sig_s_lo numeric(78, 0),
  add column sig_s_hi numeric(78, 0),
  add column sig_e_lo numeric(78, 0),
  add column sig_e_hi numeric(78, 0);

-- A revealed order without an authorisation cannot be settled, so it must not be storable as
-- revealed. Catching it here means a malformed payload is rejected at reveal with a reason,
-- rather than surfacing later as an unsatisfied constraint inside a proof.
alter table arclite.orders
  add constraint orders_revealed_is_authorised check (
    status <> 'REVEALED' or (
      pk_x is not null and pk_y is not null and npk is not null
      and sig_s_lo is not null and sig_s_hi is not null
      and sig_e_lo is not null and sig_e_hi is not null
    )
  );

comment on column arclite.orders.sig_s_lo is
  'Schnorr over Grumpkin with Poseidon2, the scheme noir-lang/schnorr verifies. Authorises this one spend: the window and the nullifier are both inside the signed message.';

-- `reveal_order` gains the authorisation. Replacing rather than adding an overload, so there is
-- no signature-less path left for a caller to reach by accident.
drop function if exists arclite.reveal_order(bigint, integer, integer, text, numeric, numeric, numeric);

create or replace function arclite.reveal_order(
  p_id bigint, p_seq integer, p_asset_id integer, p_side text,
  p_quantity numeric, p_owner numeric, p_salt numeric,
  p_pk_x numeric, p_pk_y numeric, p_npk numeric,
  p_sig_s_lo numeric, p_sig_s_hi numeric, p_sig_e_lo numeric, p_sig_e_hi numeric
)
returns void
language sql
as $$
  update arclite.orders
     set status = 'REVEALED', seq = p_seq, asset_id = p_asset_id, side = p_side,
         quantity_raw = p_quantity, owner_field = p_owner, salt_field = p_salt,
         pk_x = p_pk_x, pk_y = p_pk_y, npk = p_npk,
         sig_s_lo = p_sig_s_lo, sig_s_hi = p_sig_s_hi,
         sig_e_lo = p_sig_e_lo, sig_e_hi = p_sig_e_hi,
         revealed_at = now(), reject_reason = null
   where id = p_id and status = 'SEALED';
$$;
