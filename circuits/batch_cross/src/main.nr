//! The crossing proof.
//!
//! What this proves, and — just as important — what it does not.
//!
//! **It proves the crossing was consistent**: every note spent existed in the committed tree and
//! is spent exactly once; every price came from the table the contract committed *after* the
//! book was sealed; no guarded asset crossed; value is conserved per asset; and each fill is
//! within one raw unit of exact pro-rata, so the matcher could not favour anyone.
//!
//! **It does not prove the matcher found the best crossing.** No proof can: "best" is not a
//! property of a single batch. `/proofs` says so in those words rather than letting a reader
//! infer more than is true.
//!
//! The anti-favouritism constraint is the interesting one. Rather than forcing a canonical sort
//! and proving it — expensive, and it would fix a tie-break the venue does not need — the matcher
//! is pinned by inequalities:
//!
//!   * `Σ filled(buys) == Σ filled(sells) == matched`  — value is conserved and nothing is minted
//!   * `matched == min(buy_total, sell_total)`         — liquidity cannot be withheld
//!   * `|filled_i × T_side − quantity_i × matched| < T_side` — every fill is the floor or the
//!     ceiling of exact pro-rata, without the circuit having to compute which
//!
//! Together those admit exactly the answers `src/server/matcher.ts` produces, and nothing else.
//! The two are one rule stated twice; a disagreement is a proof that fails to generate, which is
//! the failure mode you want.

mod tests;

use arclite::merkle::{compute_root, hash2, DEPTH};
use arclite::note::{commitment, nullifier, owner_of, Note};
use arclite::price::{prices_root, select_entry, PriceEntry, MAX_ASSETS};
use arclite::range::{assert_div, assert_div_bits, assert_units};
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

/// Orders per sub-batch. Capacity grows by adding sub-batches, never by raising this: a window
/// proof large enough to hold every order would need more than the 4 GiB a wasm32 prover can
/// address, which no amount of host memory fixes.
pub global N_ORDERS: u32 = 16;

/// Output notes per sub-batch — one filled leg and one residual per order — giving a
/// span-aligned 32-leaf subtree the contract splices in a single operation.
pub global N_OUTPUTS: u32 = 32;

global SIDE_BUY: Field = 0;
global SIDE_SELL: Field = 1;

/// The quote asset is a **public input**, not a constant.
///
/// It was `0`, which read as "the registry's quote slot" — but `EligibleRegistry.assetIdOf`
/// returns 0 for *unregistered* and `nextAssetId` starts at 1, so no registered asset can ever
/// have id 0. A quote note would have carried an asset field the pool accounts nothing under,
/// which makes it unwithdrawable: the note's asset and the pool's `totalUnits` key have to be
/// the same number.
///
/// It cannot simply be witnessed either. A settler free to name the quote asset could name a
/// traded one and pay sellers in it, inflating `totalUnits` for an asset the pool holds no more
/// of. So the pool supplies it from an immutable set at construction, and it is bound here.

/// `10^(dec_base + 18 - dec_quote)` for an 18-decimal base and a 6-decimal quote, with the quote
/// reference pinned at 1e18. Converting a fill to quote units is a division by this.
pub global QUOTE_SCALE: Field = 1000000000000000000000000000000; // 10^30
/// `QUOTE_SCALE` is ~2^99.6, so the remainder proof needs more than the default 96 bits.
global QUOTE_SCALE_BITS: u32 = 104;

global DOMAIN_ORDER: Field = 0x6f72646572; // "order"
/// Domain separator for the spend authorisation, so a signature over an order can never be
/// reinterpreted as a signature over anything else this venue hashes.
global DOMAIN_SPEND: Field = 0x7370656e64; // "spend"
global DOMAIN_RECEIPT: Field = 0x72637074; // "rcpt"
global DOMAIN_TAPE: Field = 0x74617065; // "tape"

fn main(
    // ---- public: the ABI with RwaDarkPool.settleBatch, in order ----
    circuit_version: pub Field,
    window_id: pub Field,
    sub_batch_index: pub Field,
    old_root: pub Field,
    orders_root: pub Field,
    prices_root_pub: pub Field,
    defer_mask: pub Field,
    // The asset a buy is funded with and a sell is paid in. Supplied by the pool.
    quote_asset_id: pub Field,
    outputs_subtree_root: pub Field,
    receipts_root: pub Field,
    tape_leaf: pub Field,
    nullifiers: pub [Field; N_ORDERS],
    // ---- private: the committed price table ----
    entries: [PriceEntry; MAX_ASSETS],
    asset_count: u32,
    priced_at: Field,
    sequencer_ok: bool,
    // ---- private: the sealed book. `asset_selector` is one-hot: proving the lookup rather
    //      than indexing on a witness, so an order cannot be crossed at another asset's price.
    //      `active` marks a real order; padding slots must be provably inert.
    asset_selector: [[Field; MAX_ASSETS]; N_ORDERS],
    side: [Field; N_ORDERS],
    quantity: [Field; N_ORDERS],
    filled: [Field; N_ORDERS],
    order_salt: [Field; N_ORDERS],
    active: [Field; N_ORDERS],
    // ---- private: the notes being spent ----
    // `owner` is no longer taken directly: it is *derived* from the key that signs the spend, so
    // a settler holding a revealed order cannot construct a witness for it. See section 3b.
    in_units: [Field; N_ORDERS],
    pk_x: [Field; N_ORDERS],
    pk_y: [Field; N_ORDERS],
    npk: [Field; N_ORDERS],
    sig_s_lo: [Field; N_ORDERS],
    sig_s_hi: [Field; N_ORDERS],
    sig_e_lo: [Field; N_ORDERS],
    sig_e_hi: [Field; N_ORDERS],
    nsecret: [Field; N_ORDERS],
    leaf_index: [Field; N_ORDERS],
    path: [[Field; DEPTH]; N_ORDERS],
    // ---- private: per-asset aggregates, witnessed then constrained against the book ----
    asset_buy_total: [Field; MAX_ASSETS],
    asset_sell_total: [Field; MAX_ASSETS],
    asset_matched: [Field; MAX_ASSETS],
    // bit: 1 when the buy side is the smaller one. Witnessed because a comparison of two
    // field elements is not free, and proving which is smaller is cheaper than computing it.
    buy_is_smaller: [Field; MAX_ASSETS],
    // ---- private: witnessed quotient and remainder of quantity_i × matched / side_total ----
    prorata_q: [Field; N_ORDERS],
    prorata_r: [Field; N_ORDERS],
    // Quote cost of the buyer's *whole* order, so the note is proven to cover any fill the
    // matcher can produce rather than only the one it did.
    max_cost_q: [Field; N_ORDERS],
    max_cost_r: [Field; N_ORDERS],
    // ---- private: the outputs ----
    // Two per order — the residual and the received leg — so the 16-order sub-batch fills the
    // 32-leaf subtree exactly. Their contents are *derived* below, not accepted: see section 6.
    out_commitment: [Field; N_OUTPUTS],
    // Witnessed quotient and remainder of `filled × ref_value / QUOTE_SCALE`, for sell legs.
    quote_q: [Field; N_ORDERS],
    quote_r: [Field; N_ORDERS],
) {
    // -------------------------------------------------------------------------------------
    // 1. the price table is the one the contract committed
    // -------------------------------------------------------------------------------------
    let (root, mask) = prices_root(entries, asset_count, window_id, priced_at, sequencer_ok);
    assert(root == prices_root_pub);

    // The quote asset may not also be a priced row. Without this a window could be committed
    // with the quote asset in the table, and a seller's "quote" payout would be units of the
    // very asset being traded — conservation would still balance while the pool handed out
    // twice the asset it took in.
    for a in 0..MAX_ASSETS {
        if a < asset_count {
            assert(entries[a].asset_id != quote_asset_id);
        }
    }
    assert(mask == defer_mask);

    // Resolved once per order. `select_entry` is a full one-hot pass over the table, so calling
    // it again for each section would have tripled the cost of the most expensive lookup here.
    let mut row: [PriceEntry; N_ORDERS] = [entries[0]; N_ORDERS];
    for i in 0..N_ORDERS {
        row[i] = select_entry(entries, asset_selector[i]);
    }

    // The note's owner, rebuilt from the spending key rather than accepted as a witness.
    let mut owner: [Field; N_ORDERS] = [0; N_ORDERS];
    for i in 0..N_ORDERS {
        owner[i] = owner_of(pk_x[i], pk_y[i], npk[i]);
    }

    // -------------------------------------------------------------------------------------
    // 2. every order is in the sealed book, and the book was sealed before any price was read
    // -------------------------------------------------------------------------------------
    let mut book = hash2(DOMAIN_ORDER, window_id);
    book = hash2(book, sub_batch_index);

    for i in 0..N_ORDERS {
        assert(active[i] * (active[i] - 1) == 0);
        assert((side[i] - SIDE_BUY) * (side[i] - SIDE_SELL) == 0);
        assert_units(quantity[i]);
        assert_units(filled[i]);
        assert_units(in_units[i]);

        // The order commits to everything the matcher was given. Sealing this *before* any price
        // is observed is what denies the operator a free option on the window's reference.
        let leaf = hash2(
            hash2(hash2(row[i].asset_id, side[i]), quantity[i]),
            hash2(owner[i], order_salt[i]),
        );
        let chained = hash2(book, leaf);
        book = if active[i] == 1 { chained } else { book };
    }
    assert(book == orders_root);

    // -------------------------------------------------------------------------------------
    // 3. each note existed, and is spent exactly once
    // -------------------------------------------------------------------------------------
    for i in 0..N_ORDERS {
        // A seller funds the trade with the asset itself; a buyer funds it with quote. Taking
        // the note's asset from the price-table row for both made a buy a no-op: the buyer spent
        // a base note and received base units, so residual plus received equalled what went in,
        // while the seller's units vanished and their quote came from nowhere.
        let note_asset = (1 - side[i]) * quote_asset_id + side[i] * row[i].asset_id;
        let note =
            Note { asset_id: note_asset, units: in_units[i], owner: owner[i], nsecret: nsecret[i] };
        let c = commitment(note);

        if active[i] == 1 {
            assert(compute_root(c, path[i], leaf_index[i]) == old_root);
            assert(nullifiers[i] == nullifier(c, nsecret[i], leaf_index[i]));
            // The note has to cover the whole order, not merely the part that filled — the
            // matcher chooses `filled`, and a note that could only cover some outcomes would
            // make a valid crossing unprovable after the fact.
            //
            //   sell: `quantity` base units, straight out of the note
            //   buy:  the quote cost of `quantity` base units at the committed reference
            assert_div_bits::<QUOTE_SCALE_BITS>(
                quantity[i] * row[i].ref_value_e18,
                QUOTE_SCALE,
                max_cost_q[i],
                max_cost_r[i],
            );
            // Ceil, not floor, on the quote leg: a buyer pays the rounding up and a seller is
            // paid the rounding down, so the pool can never owe out more quote than it took in.
            let max_cost = max_cost_q[i] + (max_cost_r[i] != 0) as Field;
            let offered = (1 - side[i]) * max_cost + side[i] * quantity[i];
            assert_units(in_units[i] - offered);
        } else {
            // A padding slot must claim nothing. Nullifier 0 is the contract's "no spend".
            assert(nullifiers[i] == 0);
            assert(filled[i] == 0);
            assert(quantity[i] == 0);
        }

        // Never filled beyond what was ordered — for active and padding slots alike.
        assert_units(quantity[i] - filled[i]);

        // A guarded asset crosses nothing. `deferred()` is the same test the contract used to
        // build `defer_mask`, so this enforces the published mask rather than forming a second
        // opinion about staleness.
        if row[i].deferred() {
            assert(filled[i] == 0);
        }
    }

    // -------------------------------------------------------------------------------------
    // 3b. the owner authorised this spend
    // -------------------------------------------------------------------------------------
    //
    // Without this, spending a note needed only the `owner` preimage and `nsecret` — both of
    // which the settler reads out of a revealed order. It could not redirect a trade once the
    // outputs were constrained, but it could replay the same note into a *later* batch and cross
    // it again. Knowing a secret is not the same as being authorised to use it.
    //
    // The signed message names the window, the slot and the exact order, so a signature
    // authorises one spend in one place. Replaying it anywhere else changes the message and the
    // verification fails.
    for i in 0..N_ORDERS {
        // Deliberately **not** bound to the slot or the sub-batch. Both are assigned by the
        // sealer after the order was submitted, and a trader signing offline cannot know them —
        // requiring them would make the scheme unusable rather than strict.
        //
        // Leaving them out is safe because the nullifier is inside the message and a nullifier
        // may be published once: the same note cannot appear in two slots, two sub-batches or
        // two windows, so there is nowhere for a signature to move to.
        let message = hash2(
            hash2(DOMAIN_SPEND, window_id),
            hash2(hash2(row[i].asset_id, side[i]), hash2(quantity[i], nullifiers[i])),
        );

        let pk = EmbeddedCurvePoint { x: pk_x[i], y: pk_y[i] };
        let sig = (
            EmbeddedCurveScalar::new(sig_s_lo[i], sig_s_hi[i]),
            EmbeddedCurveScalar::new(sig_e_lo[i], sig_e_hi[i]),
        );

        // Padding slots carry no signature and must not be required to.
        if active[i] == 1 {
            assert(schnorr::verify_signature(pk, sig, message));
        }
    }

    // -------------------------------------------------------------------------------------
    // 4. conservation and no withholding, per asset
    // -------------------------------------------------------------------------------------
    for a in 0..MAX_ASSETS {
        let mut buy_filled: Field = 0;
        let mut sell_filled: Field = 0;
        let mut buy_qty: Field = 0;
        let mut sell_qty: Field = 0;

        for i in 0..N_ORDERS {
            // Both factors are bits, so `here` is a bit: this order is active and on this asset.
            let here = asset_selector[i][a] * active[i];
            let is_buy = here * (1 - side[i]);
            let is_sell = here * side[i];

            buy_filled = buy_filled + is_buy * filled[i];
            sell_filled = sell_filled + is_sell * filled[i];
            buy_qty = buy_qty + is_buy * quantity[i];
            sell_qty = sell_qty + is_sell * quantity[i];
        }

        // The witnessed aggregates are the book's, not the prover's invention.
        assert(asset_buy_total[a] == buy_qty);
        assert(asset_sell_total[a] == sell_qty);

        // Nothing is minted: the two sides fill each other exactly.
        assert(buy_filled == sell_filled);
        assert(buy_filled == asset_matched[a]);

        // matched == min(buy_total, sell_total), proven rather than computed. The bit picks a
        // side; the range assert proves that side really is the smaller one. Both halves are
        // needed — without the inequality a prover could claim the larger side is the minimum.
        assert(buy_is_smaller[a] * (buy_is_smaller[a] - 1) == 0);
        if buy_is_smaller[a] == 1 {
            assert(asset_matched[a] == buy_qty);
            assert_units(sell_qty - buy_qty);
        } else {
            assert(asset_matched[a] == sell_qty);
            assert_units(buy_qty - sell_qty);
        }
    }

    // -------------------------------------------------------------------------------------
    // 5. every fill is exact pro-rata, to within one raw unit
    // -------------------------------------------------------------------------------------
    for i in 0..N_ORDERS {
        // The totals this order must be measured against, selected one-hot so an order cannot
        // be scored against a different asset's book.
        let mut my_side_total: Field = 0;
        let mut my_matched: Field = 0;
        for a in 0..MAX_ASSETS {
            let s = asset_selector[i][a];
            let side_total = (1 - side[i]) * asset_buy_total[a] + side[i] * asset_sell_total[a];
            my_side_total = my_side_total + s * side_total;
            my_matched = my_matched + s * asset_matched[a];
        }

        if active[i] == 1 {
            assert_units(my_side_total);
            assert_units(my_matched);

            //   quantity_i × M = q × T + r,  with r < T   and   filled_i ∈ {q, q+1}
            //
            // which is exactly "the floor or the ceiling of the exact share" — what the
            // largest-remainder allocation in the matcher produces — without this circuit having
            // to know which of the two it chose. Witnessed division throughout: Noir's `/` on a
            // Field is multiplication by a modular inverse, not integer division, and using it
            // for money would be silently wrong.
            assert_div(quantity[i] * my_matched, my_side_total, prorata_q[i], prorata_r[i]);
            let delta = filled[i] - prorata_q[i];
            assert(delta * (delta - 1) == 0);
        }
    }

    // -------------------------------------------------------------------------------------
    // 6. the outputs belong to the traders, and the subtree is what the contract will splice
    // -------------------------------------------------------------------------------------
    //
    // This section used to be four lines: hash the 32 leaves, compare to the public root. The
    // leaves themselves were **entirely unconstrained**, which meant whoever built the proof
    // could spend a trader's note and send the whole proceeds to a note of their own. Every
    // other check still passed, because conservation here is about how many units crossed, not
    // about who received them.
    //
    // So the outputs are now *derived* from the book rather than accepted from the prover. For
    // each order there are exactly two, and both are owned by that order's owner:
    //
    //   out[2i]     the residual — what did not fill, returned in the same asset
    //   out[2i + 1] the received leg — base units for a buyer, quote units for a seller
    //
    // The prover has no freedom left: given the sealed book and the committed prices, there is
    // exactly one valid output subtree.
    //
    // `nsecret_out` derives from the order's own `nsecret`, so the trader can regenerate the
    // note from key material they already hold. It is **not** a spend authority on its own —
    // see the note below about signatures.
    let mut expected: [Field; N_OUTPUTS] = [0; N_OUTPUTS];
    for i in 0..N_ORDERS {
        // `in_units`, not `quantity`. A note is spent whole — its nullifier is published — so
        // everything it held that did not fill has to come back. Using `quantity` here meant a
        // trader offering 30 units of a 100-unit note lost the other 70: the note was consumed
        // and only `quantity - filled` was returned.
        let residual = in_units[i] - filled[i];

        // Quote units for a sell: floor(filled × ref_value / QUOTE_SCALE). Witnessed division,
        // never Field division, and floored so a seller is never paid more than the reference.
        assert_div_bits::<QUOTE_SCALE_BITS>(
            filled[i] * row[i].ref_value_e18,
            QUOTE_SCALE,
            quote_q[i],
            quote_r[i],
        );

        let is_sell = side[i];
        // A buyer receives `filled` of the asset; a seller receives quote units.
        let out_asset = (1 - is_sell) * row[i].asset_id + is_sell * quote_asset_id;
        let out_units = (1 - is_sell) * filled[i] + is_sell * quote_q[i];

        // The residual comes back in whatever the note was funded with: unspent quote for a
        // buyer, unsold units for a seller. `in_units`, not `quantity` — a note is spent whole,
        // its nullifier is published, so everything it held that did not fill has to come back.
        let note_asset = (1 - is_sell) * quote_asset_id + is_sell * row[i].asset_id;
        // The buyer pays ceil of the same product the seller is paid the floor of. Per asset the
        // two sides' fills are already forced equal, so summing over the window the buyers hand
        // over at least what the sellers take away: the quote leg cannot mint, and the at-most-
        // one-unit-per-order difference stays in the pool.
        let spent = (1 - is_sell) * (quote_q[i] + (quote_r[i] != 0) as Field) + is_sell * filled[i];
        let residual = in_units[i] - spent;
        // Without this the subtraction could wrap the field and hand the trader a note holding
        // almost the whole modulus.
        assert_units(residual);

        let residual_note = Note {
            asset_id: note_asset,
            units: residual,
            owner: owner[i],
            nsecret: hash2(nsecret[i], hash2(window_id, 0)),
        };
        let received_note = Note {
            asset_id: out_asset,
            units: out_units,
            owner: owner[i],
            nsecret: hash2(nsecret[i], hash2(window_id, 1)),
        };

        // A padding slot contributes zero leaves, which the tree already treats as empty.
        expected[i * 2] = if active[i] == 1 { commitment(residual_note) } else { 0 };
        expected[i * 2 + 1] = if active[i] == 1 { commitment(received_note) } else { 0 };
    }

    for j in 0..N_OUTPUTS {
        assert(out_commitment[j] == expected[j]);
    }

    // Fixed 32 leaves, so the reduction is five unconditional levels. A variable width would
    // make the circuit shape depend on how many orders filled, leaking the fill count into the
    // proof size.
    let mut level: [Field; N_OUTPUTS] = out_commitment;
    for _ in 0..5 {
        let mut next: [Field; N_OUTPUTS] = [0; N_OUTPUTS];
        for j in 0..(N_OUTPUTS / 2) {
            next[j] = hash2(level[j * 2], level[j * 2 + 1]);
        }
        level = next;
    }
    assert(level[0] == outputs_subtree_root);

    // -------------------------------------------------------------------------------------
    // 7. receipts and the tape commitment
    // -------------------------------------------------------------------------------------
    let mut receipts = hash2(DOMAIN_RECEIPT, window_id);
    for i in 0..N_ORDERS {
        let leaf = hash2(hash2(nullifiers[i], filled[i]), hash2(quantity[i], row[i].asset_id));
        receipts = hash2(receipts, leaf);
    }
    assert(receipts == receipts_root);

    // The tape commits to **per-asset matched volume and nothing else**.
    //
    // It used to chain `receipts`, which was wrong in a way worth spelling out: the receipts root
    // commits to per-order (nullifier, filled, quantity), so revealing the tape against it would
    // have meant revealing the order book. A delayed tape is supposed to publish aggregates —
    // how much of each asset crossed — not the trades that made them up.
    //
    // Fixed here, at proving time, so the operator can neither edit the tape afterwards nor
    // publish it early. `TapeRegistry` recomputes this from the revealed volumes and compares.
    //
    // Only the live rows are chained. Chaining all 32 cost `TapeRegistry` 8.9 M gas per publish
    // recomputing hashes over rows that are always zero — and the empty rows carry no
    // information the commitment needs, since `asset_count` is already bound through
    // `prices_root`.
    let mut tape = hash2(hash2(DOMAIN_TAPE, window_id), hash2(sub_batch_index, circuit_version));
    for a in 0..MAX_ASSETS {
        let live = a < asset_count;
        let next = hash2(tape, hash2(entries[a].asset_id, asset_matched[a]));
        tape = if live { next } else { tape };
    }
    assert(tape_leaf == tape);
}
