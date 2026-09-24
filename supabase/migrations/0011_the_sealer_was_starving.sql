-- An empty window does not need a chain seal, and while it sat in the queue nothing else could.
--
-- `windows_needing_chain_seal` returns the eight oldest windows past OPEN with no seal recorded.
-- `sealWindow` on an empty book pays gas to say nothing, so the sealer skips `order_count = 0` —
-- but the selector did not, so those windows stayed in the set forever. With 140 of them ahead
-- of it, a window with a real book would never appear in the first eight, and never be sealed.
--
-- The ordering is by `seq` ascending, deliberately: the oldest unsealed window is the most
-- urgent, because while one is open on chain every deposit queues instead of entering the tree.
-- That is exactly why the queue must not fill with windows that will never leave it.
--
-- The comment on the original said a window that reached SETTLED with no seal is "the worst
-- case, not an exempt one, so it must stay in this set". That is right, and still holds — for a
-- window that had a book. One with no orders was never going to be sealed by anyone.
create or replace function arclite.windows_needing_chain_seal(p_chain_id integer)
returns table (id bigint, seq bigint, seals_at timestamptz)
language sql
as $$
  select w.id, w.seq, w.seals_at
    from arclite.windows w
   where w.chain_id = p_chain_id
     and w.status not in ('OPEN', 'VOID', 'FAILED')
     and w.sealed_tx is null
     and not w.chain_reconciled
     -- Nothing to freeze. The sealer skipped these already; now they leave the queue too.
     and w.order_count > 0
   order by w.seq
   limit 8;
$$;

-- Same starvation, one stage later: `windows_needing_match` takes the four oldest priced windows
-- with no matcher run. An empty window is never priced, so it cannot reach that queue — but a
-- window whose settlement failed permanently can, and `limit 4` is small. Bounded by excluding
-- windows already past the point of being matchable.
create or replace function arclite.windows_needing_match(p_chain_id integer)
returns table (id bigint, seq bigint, chain_window_id bigint)
language sql
as $$
  select w.id, w.seq, w.chain_window_id
    from arclite.windows w
   where w.chain_id = p_chain_id
     and w.priced_tx is not null
     -- Not `matched_at`: that is the FSM's own status timestamp, set whether or not a matcher
     -- ever ran.
     and w.matcher_ran_at is null
     and w.status not in ('VOID', 'FAILED')
     and w.order_count > 0
   order by w.seq
   limit 4;
$$;
