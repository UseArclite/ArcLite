// Eligibility at deposit.
//
// Proves the depositor holds an unexpired attestation from a known issuer placing them in a
// permitted jurisdiction — without revealing who they are or which jurisdiction it is. It runs
// only at `shield`, which keeps the far larger crossing circuit free of screening entirely.
//
// `deposit_commitment` is a public input and is bound into the signed statement, so a valid
// attestation cannot be replayed onto somebody else's deposit.
use poseidon::poseidon2::Poseidon2;
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

global MAX_JURISDICTIONS: u32 = 64;

/// The attestation the issuer signs. Factored out so the client SDK and the circuit cannot
/// drift on what is being signed — a mismatch there fails opaquely as "invalid signature".
pub fn attestation_message(
    identity_commitment: Field,
    jurisdiction_code: Field,
    expiry: Field,
    deposit_commitment: Field,
) -> Field {
    Poseidon2::hash([identity_commitment, jurisdiction_code, expiry, deposit_commitment], 4)
}

/// Still valid at the published bucket.
pub fn check_expiry(expiry: Field, expiry_bucket: Field) {
    expiry.assert_max_bit_size::<64>();
    expiry_bucket.assert_max_bit_size::<64>();
    assert(expiry as u64 > expiry_bucket as u64);
}

/// The jurisdiction is one of the permitted set. Reading a bit of the published mask reveals
/// only that, never which jurisdiction it was.
pub fn check_jurisdiction(jurisdiction_code: Field, jurisdiction_mask: Field) {
    jurisdiction_code.assert_max_bit_size::<8>();
    assert((jurisdiction_code as u32) < MAX_JURISDICTIONS);
    let bits: [bool; MAX_JURISDICTIONS] = jurisdiction_mask.to_le_bits();
    assert(bits[jurisdiction_code as u32]);
}

fn main(
    issuer_pubkey_hash: pub Field,
    jurisdiction_mask: pub Field,
    expiry_bucket: pub Field,
    deposit_commitment: pub Field,
    // ---- private ----
    identity_secret: Field,
    jurisdiction_code: Field,
    expiry: Field,
    issuer_pk_x: Field,
    issuer_pk_y: Field,
    sig_s_lo: Field,
    sig_s_hi: Field,
    sig_e_lo: Field,
    sig_e_hi: Field,
) {
    // The issuer is identified by a hash of its key, so rotating the key changes a public input
    // rather than requiring a new circuit and a new verifier deployment.
    assert(Poseidon2::hash([issuer_pk_x, issuer_pk_y], 2) == issuer_pubkey_hash);

    let identity_commitment = Poseidon2::hash([identity_secret], 1);

    // What the issuer signed. The deposit commitment is inside the signed message, so an
    // attestation is usable for exactly one deposit.
    let attestation =
        attestation_message(identity_commitment, jurisdiction_code, expiry, deposit_commitment);

    let pk = EmbeddedCurvePoint { x: issuer_pk_x, y: issuer_pk_y };
    let sig = (
        EmbeddedCurveScalar::new(sig_s_lo, sig_s_hi),
        EmbeddedCurveScalar::new(sig_e_lo, sig_e_hi),
    );
    assert(schnorr::verify_signature(pk, sig, attestation));

    // `expiry_bucket` is coarse on purpose: a precise expiry would narrow the anonymity set to
    // whoever happened to be attested at that exact moment.
    check_expiry(expiry, expiry_bucket);
    check_jurisdiction(jurisdiction_code, jurisdiction_mask);
}

// ---------------------------------------------------------------------------------------------
// tests
//
// The predicates are tested directly. The Schnorr verification is NOT covered here: producing a
// valid signature needs a private-key operation that belongs in the client SDK, so the signed
// path is exercised end-to-end from JS once the SDK exists. `attestation_message` is factored
// out precisely so the SDK and the circuit cannot drift on what gets signed — a mismatch there
// would surface only as an opaque "invalid signature".
// ---------------------------------------------------------------------------------------------

mod tests {
    use super::{attestation_message, check_expiry, check_jurisdiction};

    #[test]
    fn permitted_jurisdiction_passes() {
        // Bits 0, 3 and 7 set.
        let mask: Field = 0x89;
        check_jurisdiction(0, mask);
        check_jurisdiction(3, mask);
        check_jurisdiction(7, mask);
    }

    #[test(should_fail)]
    fn excluded_jurisdiction_is_rejected() {
        check_jurisdiction(2, 0x89);
    }

    /// The source plans place the venue under non-US eligibility, so a mask that excludes a
    /// jurisdiction has to actually exclude it rather than merely being advisory.
    #[test(should_fail)]
    fn empty_mask_admits_nobody() {
        check_jurisdiction(0, 0);
    }

    #[test(should_fail)]
    fn jurisdiction_code_out_of_range_is_rejected() {
        check_jurisdiction(200, 0xFFFFFFFFFFFFFFFF);
    }

    #[test]
    fn unexpired_attestation_passes() {
        check_expiry(1_800_000_000, 1_789_000_000);
    }

    #[test(should_fail)]
    fn expired_attestation_is_rejected() {
        check_expiry(1_789_000_000, 1_800_000_000);
    }

    #[test(should_fail)]
    fn attestation_expiring_exactly_now_is_rejected() {
        check_expiry(1_789_000_000, 1_789_000_000);
    }

    /// The deposit commitment is inside the signed message, so an attestation is usable for
    /// exactly one deposit and cannot be replayed onto somebody else's.
    #[test]
    fn message_is_bound_to_the_deposit() {
        let a = attestation_message(1, 2, 3, 100);
        let b = attestation_message(1, 2, 3, 101);
        assert(a != b);
    }

    #[test]
    fn message_is_bound_to_the_identity() {
        assert(attestation_message(1, 2, 3, 100) != attestation_message(9, 2, 3, 100));
    }
}
