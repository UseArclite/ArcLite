use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar};

fn main(
    k1_pub_x: [u8; 32],
    k1_pub_y: [u8; 32],
    k1_sig: [u8; 64],
    k1_hash: [u8; 32],
    gk_pub_x: Field,
    gk_pub_y: Field,
    gk_s_lo: Field,
    gk_s_hi: Field,
    gk_e_lo: Field,
    gk_e_hi: Field,
    message: Field,
) {
    let pk = EmbeddedCurvePoint { x: gk_pub_x, y: gk_pub_y };
    let sig = (
        EmbeddedCurveScalar::new(gk_s_lo, gk_s_hi),
        EmbeddedCurveScalar::new(gk_e_lo, gk_e_hi),
    );
    assert(schnorr::verify_signature(pk, sig, message));
}
