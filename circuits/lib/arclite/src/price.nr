//! The committed price table, as the circuit sees it.
//!
//! `PriceCommitter.commitWindow` derives `pricesRoot` and `deferMask` **on-chain, after the book
//! is sealed**, from its own staticcalls to the feeds. The circuit's job is therefore not to
//! assert that a price is right — it is to prove the crossing used the table the contract
//! committed. That inversion is what removes the operator's free option on the reference: by the
//! time any price is observed, the orders are already frozen.
//!
//! Every field below is packed exactly as `PriceCommitter._pack` packs it. The two are separate
//! implementations of one encoding, so they are asserted against each other by a parity test
//! rather than trusted to stay in step.

use crate::merkle::hash2;

/// Matches `PriceCommitter.MAX_ASSETS`: the defer mask is one word, one bit per table slot.
pub global MAX_ASSETS: u32 = 32;

/// Domain separator: `keccak256("arclite.prices.v1") % P`, identical to the contract's
/// `DOMAIN_PRICES`. Asserted against the Solidity constant by a parity test rather than eyeballed
/// — a mismatch here produces a root the contract can never reach, for every window.
pub global DOMAIN_PRICES: Field =
    0x25e89cc1ebc10af8e231260a54693ca2358ec7f0b4e62799f0fba59a95ab35a6;

/// The contract's flag bits, in its order. Any non-zero `flags` defers the asset; the individual
/// bits exist so a receipt can say *why*, which is what the dashboard renders.
pub global FLAG_STALE: Field = 0x01;
pub global FLAG_PAUSED: Field = 0x02;
pub global FLAG_EVENT: Field = 0x04;
pub global FLAG_NAV_AGED: Field = 0x08;
pub global FLAG_MULTIPLIER_PENDING: Field = 0x10;
pub global FLAG_UNREADABLE: Field = 0x20;

/// One row of the committed table.
///
/// `ref_value_e18` is USD per whole token, 1e18-scaled — the feed answer already multiplied by
/// the issuer's `uiMultiplier`, so the circuit never has to redo that arithmetic.
pub struct PriceEntry {
    pub asset_id: Field,
    pub kind: Field,
    pub flags: Field,
    pub updated_at: Field,
    pub round_id: Field,
    pub ref_value_e18: Field,
    pub ui_multiplier_e18: Field,
}

impl PriceEntry {
    /// Recompose the two packed words the contract hashed.
    ///
    /// The range asserts are not decoration. `hi` is `ref_value | multiplier << 128`; with an
    /// unbounded multiplier that exceeds the BN254 modulus and wraps, which would let two
    /// different tables hash to the same root. The contract's own comment says both words "stay
    /// well under the modulus" — true for real values, but the circuit must enforce it rather
    /// than inherit the assumption.
    pub fn pack(self) -> (Field, Field) {
        self.asset_id.assert_max_bit_size::<16>();
        self.kind.assert_max_bit_size::<8>();
        self.flags.assert_max_bit_size::<8>();
        self.updated_at.assert_max_bit_size::<64>();
        self.round_id.assert_max_bit_size::<80>();
        self.ref_value_e18.assert_max_bit_size::<128>();
        // 126 rather than 128, so `hi` stays below 2^254 and cannot wrap the field.
        self.ui_multiplier_e18.assert_max_bit_size::<126>();

        let lo = self.asset_id
            + self.kind * 0x10000                    // << 16
            + self.flags * 0x1000000                 // << 24
            + self.updated_at * 0x100000000          // << 32
            + self.round_id * 0x1000000000000000000000000; // << 96

        let hi = self.ref_value_e18
            + self.ui_multiplier_e18 * 0x100000000000000000000000000000000; // << 128

        (lo, hi)
    }

    /// True when any guard flag is set. A deferred asset must not cross.
    pub fn deferred(self) -> bool {
        self.flags != 0
    }
}

/// Rebuild `pricesRoot` and `deferMask` from the table, exactly as the contract did.
///
/// `count` is the number of live rows; the array is fixed-width because circuit shapes are, so
/// trailing rows are ignored rather than absent. They still have to be *provably* ignored, which
/// is why the loop is a select rather than a break.
pub fn prices_root(
    entries: [PriceEntry; MAX_ASSETS],
    count: u32,
    window_id: Field,
    priced_at: Field,
    sequencer_ok: bool,
) -> (Field, Field) {
    let mut h = hash2(DOMAIN_PRICES, window_id);
    h = hash2(h, priced_at);
    h = hash2(h, if sequencer_ok { 1 } else { 0 });

    let mut mask: Field = 0;
    let mut bit: Field = 1;

    for i in 0..MAX_ASSETS {
        let live = i < count;
        let (lo, hi) = entries[i].pack();

        // Chain only the live rows. Selecting the previous value for a dead row is what makes a
        // short table hash identically to how the contract hashed it.
        let h1 = hash2(h, lo);
        let h2 = hash2(h1, hi);
        h = if live { h2 } else { h };

        let flagged = live & entries[i].deferred();
        mask = mask + if flagged { bit } else { 0 };
        bit = bit * 2;
    }

    (h, mask)
}

/// Look a row up by position, proving the choice rather than trusting an index.
///
/// One-hot: the selector array is constrained to hold exactly one 1, and the result is the inner
/// product. A plain array index on a witnessed value would let a prover read a row that is not
/// the one the order names — crossing NVDA at SGOV's price.
pub fn select_entry(entries: [PriceEntry; MAX_ASSETS], selector: [Field; MAX_ASSETS]) -> PriceEntry {
    let mut sum: Field = 0;
    for i in 0..MAX_ASSETS {
        // Each selector is a bit...
        assert(selector[i] * (selector[i] - 1) == 0);
        sum = sum + selector[i];
    }
    // ...and exactly one of them is set.
    assert(sum == 1);

    let mut out = PriceEntry {
        asset_id: 0,
        kind: 0,
        flags: 0,
        updated_at: 0,
        round_id: 0,
        ref_value_e18: 0,
        ui_multiplier_e18: 0,
    };
    for i in 0..MAX_ASSETS {
        let s = selector[i];
        out.asset_id = out.asset_id + s * entries[i].asset_id;
        out.kind = out.kind + s * entries[i].kind;
        out.flags = out.flags + s * entries[i].flags;
        out.updated_at = out.updated_at + s * entries[i].updated_at;
        out.round_id = out.round_id + s * entries[i].round_id;
        out.ref_value_e18 = out.ref_value_e18 + s * entries[i].ref_value_e18;
        out.ui_multiplier_e18 = out.ui_multiplier_e18 + s * entries[i].ui_multiplier_e18;
    }
    out
}
