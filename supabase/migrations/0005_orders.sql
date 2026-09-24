-- ArcLite RH — migration 0005: sealed order intake.
--
-- An order arrives encrypted and stays that way until the window's book closes. What the server
-- can check before then is deliberately limited to things that need no plaintext: that the window
-- is open, that the commitment has not been seen, that the account is within its rate limit, and
-- that the ciphertext matches the hash the submitter claimed. Everything else waits.
--
-- ## What is visible, and when
--
-- Always: `account_hash`, `commitment`, `nonce_hash`, `submitted_at`, `payload_ct`.
-- After the seal: `asset_id`, `side`, `quantity_raw`, `owner`, `salt` — written by the sealer,
-- never by the submitter.
--
-- `account_hash` is H(address ‖ window salt), so it links a trader's orders *within* one window
-- and not across windows. That is what lets the rate limit work without building a per-address
-- history of who traded when.
--
-- ## The honest limit
--
-- Sealing here uses a per-window keypair whose private half the server holds. Under this mode the
-- operator CAN decrypt at any time: it is transport privacy, keeping orders from other traders
-- and from anyone reading the network, and nothing more. The design calls for drand timelock
-- encryption, where nobody — us included — can decrypt before the round publishes.
-- `arclite.window_keys.seal_mode` records which one a window actually used, so a window sealed
-- under the weaker mode can never be described as having used the stronger one.

create type arclite.order_status as enum ('SEALED', 'REVEALED', 'MATCHED', 'REJECTED', 'EXPIRED');
create type arclite.seal_mode    as enum ('KEYPAIR', 'TLOCK');

-- ---------------------------------------------------------------------------------------------
-- per-window sealing keys
-- ---------------------------------------------------------------------------------------------

create table arclite.window_keys (
  window_id   bigint primary key references arclite.windows(id) on delete cascade,
  seal_mode   arclite.seal_mode not null default 'KEYPAIR',
  -- X25519 public key orders are sealed to. Published with the open window.
  public_key  bytea not null check (octet_length(public_key) = 32),
  -- Under KEYPAIR this is written immediately, and that is deliberate. Withholding it from the
  -- row while the process that generated it still holds it protects against nobody — the
  -- operator is that process — and loses the entire book if the instance dies before sealing.
  -- Under TLOCK it stays null forever, because the key does not exist until drand publishes.
  secret_key  bytea check (secret_key is null or octet_length(secret_key) = 32),
  -- For TLOCK: the drand round the orders are encrypted to. Null under KEYPAIR.
  tlock_round bigint,
  revealed_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint window_keys_tlock_has_round
    check (seal_mode <> 'TLOCK' or tlock_round is not null)
);

comment on column arclite.window_keys.secret_key is
  'Present under KEYPAIR, where the operator can decrypt at any time and the mode is transport privacy only. Null under TLOCK, where the key does not exist until the drand round publishes. seal_mode says which, so a weakly sealed window can never be described as strongly sealed.';

-- ---------------------------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------------------------

create table arclite.orders (
  id           bigint generated always as identity primary key,
  window_id    bigint not null references arclite.windows(id) on delete cascade,
  status       arclite.order_status not null default 'SEALED',

  -- H(address ‖ window salt). Links a trader's orders inside one window, never across windows.
  account_hash bytea not null check (octet_length(account_hash) = 32),
  -- The note commitment this order spends. Unique across all time: a repeat is a replay.
  commitment   bytea not null check (octet_length(commitment) = 32),
  nonce_hash   bytea not null check (octet_length(nonce_hash) = 32),

  payload_ct   bytea not null check (octet_length(payload_ct) between 1 and 4096),
  -- Bound at submission so a payload cannot be swapped after the fact for one that decrypts
  -- differently. Checked again by the sealer before it trusts a single field.
  payload_hash bytea not null check (octet_length(payload_hash) = 32),

  submitted_at timestamptz not null default now(),

  -- Written by the sealer, after the book closes. Never by the submitter.
  asset_id     integer,
  side         text check (side is null or side in ('buy', 'sell')),
  quantity_raw numeric(78, 0) check (quantity_raw is null or quantity_raw > 0),
  owner_field  numeric(78, 0),
  salt_field   numeric(78, 0),
  revealed_at  timestamptz,
  reject_reason text,

  -- Sequence within the sealed book. Assigned at reveal, and it is what makes matching
  -- deterministic: the matcher's tie-break reads this, never row order.
  seq          integer,

  constraint orders_revealed_is_complete check (
    status <> 'REVEALED' or (
      asset_id is not null and side is not null and quantity_raw is not null
      and owner_field is not null and salt_field is not null and seq is not null
    )
  )
);

-- A commitment may be spent once, ever. Not per window: the point is that a note cannot be
-- offered into two windows at the same time and matched in both.
create unique index orders_commitment_idx on arclite.orders (commitment);
create index orders_window_idx on arclite.orders (window_id, seq);
create index orders_account_idx on arclite.orders (window_id, account_hash);
create unique index orders_window_seq_idx on arclite.orders (window_id, seq) where seq is not null;

-- ---------------------------------------------------------------------------------------------
-- intake
-- ---------------------------------------------------------------------------------------------

-- Accept an order, or say precisely why not — in one round trip, and without reading the payload.
--
-- Returns (ok, reason, order_id). A rejection is a normal result rather than an exception: the
-- caller turns it into a 4xx, and a raised exception would lose the reason on the way up.
create or replace function arclite.submit_order(
  p_chain_id integer,
  p_window_seq bigint,
  p_account_hash bytea,
  p_commitment bytea,
  p_nonce_hash bytea,
  p_payload_ct bytea,
  p_payload_hash bytea,
  p_max_per_account integer
)
returns table (ok boolean, reason text, order_id bigint)
language plpgsql
as $$
declare
  v_window arclite.windows%rowtype;
  v_count integer;
  v_id bigint;
begin
  select * into v_window from arclite.windows
   where chain_id = p_chain_id and seq = p_window_seq;

  if not found then
    return query select false, 'no such window', null::bigint; return;
  end if;
  if v_window.status <> 'OPEN' then
    return query select false, 'window is no longer open', null::bigint; return;
  end if;
  -- Time, not status. A window seals because its moment arrived; a tick that has not run yet
  -- must not let an order in after the book was due to close.
  if v_window.seals_at <= now() then
    return query select false, 'window is past its seal time', null::bigint; return;
  end if;

  select count(*) into v_count from arclite.orders
   where window_id = v_window.id and account_hash = p_account_hash and status <> 'REJECTED';
  if v_count >= p_max_per_account then
    return query select false, 'too many orders for this account in this window', null::bigint; return;
  end if;

  begin
    insert into arclite.orders (window_id, account_hash, commitment, nonce_hash, payload_ct, payload_hash)
    values (v_window.id, p_account_hash, p_commitment, p_nonce_hash, p_payload_ct, p_payload_hash)
    returning id into v_id;
  exception when unique_violation then
    -- The commitment is already spoken for. Said plainly: a trader resubmitting the same note
    -- needs to know it is a duplicate, not that "something went wrong".
    return query select false, 'this note has already been offered', null::bigint; return;
  end;

  update arclite.windows set order_count = order_count + 1 where id = v_window.id;
  return query select true, null::text, v_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- revealing
-- ---------------------------------------------------------------------------------------------

-- Write a decrypted order back, in book order. Called by the sealer once, per order.
create or replace function arclite.reveal_order(
  p_id bigint, p_seq integer, p_asset_id integer, p_side text,
  p_quantity numeric, p_owner numeric, p_salt numeric
)
returns void
language sql
as $$
  update arclite.orders
     set status = 'REVEALED', seq = p_seq, asset_id = p_asset_id, side = p_side,
         quantity_raw = p_quantity, owner_field = p_owner, salt_field = p_salt,
         revealed_at = now(), reject_reason = null
   where id = p_id and status = 'SEALED';
$$;

-- An order that cannot be decrypted, or decrypts to nonsense, is rejected rather than dropped.
-- Dropping it would make the order count disagree with the book and the orders root unreachable.
create or replace function arclite.reject_order(p_id bigint, p_reason text)
returns void
language sql
as $$
  update arclite.orders
     set status = 'REJECTED', reject_reason = p_reason, revealed_at = now()
   where id = p_id and status = 'SEALED';
$$;

create or replace function arclite.set_orders_root(p_window_id bigint, p_root bytea, p_count integer)
returns void
language sql
as $$
  update arclite.windows set orders_root = p_root, order_count = p_count where id = p_window_id;
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------------------------
--
-- Orders and sealing keys are service-role only, with no policies at all. `payload_ct` readable
-- by anon would hand every sealed order to anyone the moment the key is published, and
-- `window_keys.secret_key` readable by anon would do it a great deal sooner.

alter table arclite.orders enable row level security;
alter table arclite.window_keys enable row level security;
