-- ArcLite RH — migration 0003: SIWE nonces and sessions.
--
-- Sessions exist for three things named in plan.md — per-account rate limiting, receipt scoping,
-- and minting a Supabase-compatible JWT so Realtime and direct reads respect RLS. They are
-- deliberately NOT what authenticates an order: order submission is authenticated by the Schnorr
-- signature inside the sealed payload, with `credentials: 'omit'`, so the submit path never
-- carries a cookie that links a shielded order to a wallet address.
--
-- Two properties this schema is responsible for:
--
--   * a nonce is usable exactly once. Replay protection cannot be done statelessly — an HMAC'd
--     timestamp is replayable for its whole validity window — so it is done here, as a single
--     conditional UPDATE that either claims the nonce or returns nothing.
--   * the session token is stored **hashed**. A dump of this table must not let the reader hold
--     anyone's session, the same reason a password table stores digests.

-- ---------------------------------------------------------------------------------------------
-- nonces
-- ---------------------------------------------------------------------------------------------

create table arclite.auth_nonces (
  -- EIP-4361 requires an alphanumeric nonce of at least 8 characters; viem's generateSiweNonce
  -- emits 96. The upper bound is a sanity cap, not a format claim — `NONCE_PATTERN` in
  -- src/server/auth.ts is asserted against the generator so a viem change fails a test here
  -- rather than a constraint violation in production. Not citext: case is significant, and the
  -- signed message must match byte for byte.
  nonce       text primary key check (nonce ~ '^[A-Za-z0-9]{8,128}$'),
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  constraint auth_nonces_ttl check (expires_at > issued_at)
);

create index auth_nonces_expiry_idx on arclite.auth_nonces (expires_at);

-- Issue a nonce, and opportunistically reap a bounded number of dead ones so the table cannot
-- grow without a dedicated cron. The LIMIT matters: an unbounded DELETE would make one unlucky
-- sign-in pay for months of accumulated rows.
create or replace function arclite.issue_nonce(p_nonce text, p_ttl_seconds integer)
returns timestamptz
language plpgsql
as $$
declare v_expires timestamptz;
begin
  delete from arclite.auth_nonces
   where nonce in (
     select nonce from arclite.auth_nonces
      where expires_at < now() - interval '1 hour'
      limit 200
   );

  insert into arclite.auth_nonces (nonce, expires_at)
  values (p_nonce, now() + make_interval(secs => p_ttl_seconds))
  returning expires_at into v_expires;

  return v_expires;
end;
$$;

-- Claim a nonce. Returns true at most once per nonce, ever: the WHERE clause is the mutual
-- exclusion, so two concurrent verifies of the same signature cannot both succeed.
create or replace function arclite.consume_nonce(p_nonce text)
returns boolean
language sql
as $$
  update arclite.auth_nonces
     set consumed_at = now()
   where nonce = p_nonce
     and consumed_at is null
     and expires_at > now()
  returning true;
$$;

-- ---------------------------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------------------------

create table arclite.sessions (
  -- sha-256 of the opaque bearer token. The token itself is never stored.
  token_hash   bytea primary key check (octet_length(token_hash) = 32),
  address      citext not null check (address ~ '^0x[0-9a-f]{40}$'),
  chain_id     integer not null,
  issued_at    timestamptz not null default now(),
  expires_at   timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  constraint sessions_ttl check (expires_at > issued_at)
);

create index sessions_address_idx on arclite.sessions (address) where revoked_at is null;
create index sessions_expiry_idx  on arclite.sessions (expires_at);

-- Same citext trap as `assets`: the format CHECK above is case-insensitive because the column is
-- citext, so a mixed-case address satisfies it and is then stored mixed-case. Canonicalise.
create or replace function arclite.normalise_session_address()
returns trigger
language plpgsql
as $$
begin
  new.address := lower(new.address::text)::citext;
  return new;
end;
$$;

create trigger sessions_normalise_address
  before insert or update of address on arclite.sessions
  for each row execute function arclite.normalise_session_address();

create or replace function arclite.open_session(
  p_token_hash bytea, p_address citext, p_chain_id integer, p_ttl_seconds integer
)
returns timestamptz
language plpgsql
as $$
declare v_expires timestamptz;
begin
  delete from arclite.sessions
   where token_hash in (
     select token_hash from arclite.sessions
      where expires_at < now() - interval '7 days'
      limit 200
   );

  insert into arclite.sessions (token_hash, address, chain_id, expires_at)
  values (p_token_hash, p_address, p_chain_id, now() + make_interval(secs => p_ttl_seconds))
  returning expires_at into v_expires;

  return v_expires;
end;
$$;

-- Resolve a token to its account in one round trip, refreshing `last_seen_at` only when it has
-- gone stale. Bumping it on every request would turn every authenticated read into a write.
create or replace function arclite.session_account(p_token_hash bytea)
returns table (address citext, chain_id integer, expires_at timestamptz)
language sql
as $$
  with live as (
    select s.token_hash, s.address, s.chain_id, s.expires_at, s.last_seen_at
      from arclite.sessions s
     where s.token_hash = p_token_hash
       and s.revoked_at is null
       and s.expires_at > now()
  ), bumped as (
    update arclite.sessions t
       set last_seen_at = now()
      from live
     where t.token_hash = live.token_hash
       and live.last_seen_at < now() - interval '60 seconds'
  )
  select live.address, live.chain_id, live.expires_at from live;
$$;

-- Idempotent: logging out twice, or logging out an already-expired session, is not an error.
create or replace function arclite.revoke_session(p_token_hash bytea)
returns boolean
language sql
as $$
  update arclite.sessions
     set revoked_at = now()
   where token_hash = p_token_hash
     and revoked_at is null
  returning true;
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS — service role only, with no policies at all
-- ---------------------------------------------------------------------------------------------
--
-- Neither table gets a policy. `auth_nonces` readable by anon would hand an attacker a valid
-- unconsumed nonce; `sessions` readable by anon would expose the address set of everyone signed
-- in, which is exactly the linkage this venue exists to avoid. Server routes use the service
-- role and bypass RLS; nothing else may read these at all.

alter table arclite.auth_nonces enable row level security;
alter table arclite.sessions    enable row level security;
