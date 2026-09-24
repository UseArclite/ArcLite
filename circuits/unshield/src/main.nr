// Withdrawal from the shielded pool.
//
// This is the circuit that makes "your funds are yours" true rather than promised. It is
// deliberately small — ~2^14 — so it proves in a couple of seconds *in the browser*. A user who
// can generate this proof can leave while the venue is paused, the asset is delisted, and the
// operator is hostile or simply gone; `RwaDarkPool.unshield` carries no pause, no role and no
// window check.
//
// The public inputs are the exact array `RwaDarkPool.unshield` builds, in order. A mismatch
// fails with PUBLIC_INPUT_COUNT_INVALID rather than verifying something else, but the *order*
// would silently verify the wrong statement — so it is asserted by a test, not by comment.
//
// `recipient`, `relayer` and `relayer_fee` are public inputs precisely so a relayer cannot
// redirect the withdrawal or inflate its own fee: it can only broadcast the statement the owner
// signed, or nothing.
use arclite::merkle::{compute_root, DEPTH};
use arclite::note::{commitment, nullifier, owner_of, Note};
use arclite::range::{assert_units, MAX_UNITS_BITS};

fn main(
    // ---- public: must mirror RwaDarkPool.unshield's publicInputs array, in order ----
    root: pub Field,
    nullifier_out: pub Field,
    change_commitment: pub Field,
    asset_id: pub Field,
    units_out: pub Field,
    recipient: pub Field,
    relayer: pub Field,
    relayer_fee: pub Field,
    // ---- private ----
    in_units: Field,
    owner_npk: Field,
    pk_x: Field,
    pk_y: Field,
    nsecret: Field,
    leaf_index: Field,
    path: [Field; DEPTH],
    change_nsecret: Field,
) {
    assert_units(in_units);
    assert_units(units_out);
    assert_units(relayer_fee);

    // --- the note being spent exists in the committed tree ---
    let owner = owner_of(pk_x, pk_y, owner_npk);
    let note = Note { asset_id, units: in_units, owner, nsecret };
    let c = commitment(note);
    assert(compute_root(c, path, leaf_index) == root);

    // --- and is being spent exactly once ---
    assert(nullifier_out == nullifier(c, nsecret, leaf_index));

    // --- value conservation ---
    // Witnessed subtraction with a range check, never field subtraction: `in_units - units_out`
    // wraps to an enormous positive value if the withdrawal exceeds the note, which would let a
    // 1-unit note fund an arbitrary withdrawal.
    let change_units = in_units - units_out;
    change_units.assert_max_bit_size::<MAX_UNITS_BITS>();
    assert(in_units == units_out + change_units);

    // The relayer's cut comes out of the withdrawal, not out of the pool.
    let to_recipient = units_out - relayer_fee;
    to_recipient.assert_max_bit_size::<MAX_UNITS_BITS>();

    // --- the change note is well formed, or absent ---
    // A fully-spent note publishes commitment 0, which the contract reads as "insert nothing".
    // Binding that here stops a spender from quietly minting themselves a change note.
    let change_owner = owner;
    let change = Note { asset_id, units: change_units, owner: change_owner, nsecret: change_nsecret };
    let expected_change = commitment(change);
    if change_units == 0 {
        assert(change_commitment == 0);
    } else {
        assert(change_commitment == expected_change);
    }

    // --- bind the payout target into the statement ---
    // These are already public inputs, so the verifier checks them against the contract's
    // arguments. Touching them here keeps them in the circuit's constraint system rather than
    // letting the compiler drop them as unused.
    assert(recipient != 0);
    let _ = relayer;
}

// ---------------------------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------------------------
//
// These construct a real note, place it at a real index in an empty tree, and drive `main`.
// They matter because a circuit that is merely *satisfiable* proves nothing — the question is
// whether a false statement is rejected, so most of these assert failure.

mod tests {
    use super::main;
    use arclite::merkle::{compute_root, hash2, DEPTH};
    use arclite::note::{commitment, nullifier, owner_of, Note};

    /// Authentication path for the first leaf of an empty tree: every sibling is the zero
    /// subtree of that height, mirroring `CommitmentTree`'s constructor ladder.
    fn empty_path() -> [Field; DEPTH] {
        let mut path: [Field; DEPTH] = [0; DEPTH];
        let mut zero: Field = 0;
        for i in 0..DEPTH {
            path[i] = zero;
            zero = hash2(zero, zero);
        }
        path
    }

    fn fixture() -> (Field, Field, Field, Field, Field, Field, [Field; DEPTH]) {
        let asset_id: Field = 1;
        let in_units: Field = 100;
        let npk: Field = 7;
        let pk_x: Field = 11;
        let pk_y: Field = 13;
        let nsecret: Field = 17;
        let owner = owner_of(pk_x, pk_y, npk);
        let note = Note { asset_id, units: in_units, owner, nsecret };
        let c = commitment(note);
        let path = empty_path();
        let root = compute_root(c, path, 0);
        let null = nullifier(c, nsecret, 0);
        (asset_id, in_units, npk, root, null, nsecret, path)
    }

    #[test]
    fn full_withdrawal_leaves_no_change() {
        let (asset_id, in_units, npk, root, null, nsecret, path) = fixture();
        // Fully spent: the contract reads commitment 0 as "insert nothing".
        main(root, null, 0, asset_id, in_units, 0xAAAA, 0, 0, in_units, npk, 11, 13, nsecret, 0, path, 99);
    }

    #[test]
    fn partial_withdrawal_produces_a_change_note() {
        let (asset_id, in_units, npk, root, null, nsecret, path) = fixture();
        let owner = owner_of(11, 13, npk);
        let change_nsecret: Field = 99;
        let change = Note { asset_id, units: in_units - 40, owner, nsecret: change_nsecret };
        let change_c = commitment(change);
        main(root, null, change_c, asset_id, 40, 0xAAAA, 0, 0, in_units, npk, 11, 13, nsecret, 0, path, change_nsecret);
    }

    #[test]
    fn relayer_fee_comes_out_of_the_withdrawal() {
        let (asset_id, in_units, npk, root, null, nsecret, path) = fixture();
        main(root, null, 0, asset_id, in_units, 0xAAAA, 0xBBBB, 5, in_units, npk, 11, 13, nsecret, 0, path, 99);
    }

    /// The bug this circuit exists to prevent: spending more than the note holds. Field
    /// subtraction would wrap to an enormous positive value, so the range check is what stops a
    /// 100-unit note funding an unbounded withdrawal.
    #[test(should_fail)]
    fn cannot_withdraw_more_than_the_note_holds() {
        let (asset_id, in_units, npk, root, null, nsecret, path) = fixture();
        main(root, null, 0, asset_id, in_units + 1, 0xAAAA, 0, 0, in_units, npk, 11, 13, nsecret, 0, path, 99);
    }

    #[test(should_fail)]
    fn cannot_spend_a_note_that_is_not_in_the_tree() {
        let (asset_id, in_units, npk, _root, null, nsecret, path) = fixture();
        main(0xDEAD, null, 0, asset_id, in_units, 0xAAAA, 0, 0, in_units, npk, 11, 13, nsecret, 0, path, 99);
    }

    /// A spender must not be able to publish a nullifier of their choosing — that would let the
    /// same note be spent twice under two different nullifiers.
    #[test(should_fail)]
    fn cannot_publish_an_arbitrary_nullifier() {
        let (asset_id, in_units, npk, root, _null, nsecret, path) = fixture();
        main(root, 0xFFFF, 0, asset_id, in_units, 0xAAAA, 0, 0, in_units, npk, 11, 13, nsecret, 0, path, 99);
    }

    /// Claiming a fully-spent note while still minting change would create units from nothing.
    #[test(should_fail)]
    fn cannot_mint_change_on_a_full_withdrawal() {
        let (asset_id, in_units, npk, root, null, nsecret, path) = fixture();
        main(root, null, 0x1234, asset_id, in_units, 0xAAAA, 0, 0, in_units, npk, 11, 13, nsecret, 0, path, 99);
    }

    /// Change must be exactly the remainder, not a number the spender picked.
    #[test(should_fail)]
    fn change_note_must_match_the_remainder() {
        let (asset_id, in_units, npk, root, null, nsecret, path) = fixture();
        let owner = owner_of(11, 13, npk);
        let inflated = Note { asset_id, units: in_units, owner, nsecret: 99 };
        main(root, null, commitment(inflated), asset_id, 40, 0xAAAA, 0, 0, in_units, npk, 11, 13, nsecret, 0, path, 99);
    }

    /// Spending someone else's note: the owner binding is part of the commitment, so a wrong
    /// key produces a commitment that is not in the tree.
    #[test(should_fail)]
    fn cannot_spend_with_the_wrong_key() {
        let (asset_id, in_units, npk, root, null, nsecret, path) = fixture();
        main(root, null, 0, asset_id, in_units, 0xAAAA, 0, 0, in_units, npk, 12, 13, nsecret, 0, path, 99);
    }
}
