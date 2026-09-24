/// Range discipline.
///
/// BN254 is ~254 bits, so a product like `units * price` silently wraps if either operand is
/// unbounded — a mint bug no test with realistic numbers would ever catch. Every witnessed
/// quantity is bounded before it is multiplied, and every division is witnessed rather than
/// performed with `/` on a Field.

/// Raw token units. 2^96 covers 18-decimal tokens up to ~7.9e10 whole units.
pub global MAX_UNITS_BITS: u32 = 96;
/// 1e18-scaled reference values. 2^80 covers ~1.2e6 USD per whole token.
pub global MAX_VALUE_BITS: u32 = 80;

pub fn assert_units(x: Field) {
    x.assert_max_bit_size::<MAX_UNITS_BITS>();
}

pub fn assert_value(x: Field) {
    x.assert_max_bit_size::<MAX_VALUE_BITS>();
}

/// Assert `a == q * b + r` with `r < b`, i.e. that (q, r) really is the quotient and remainder.
///
/// Noir's `/` on Field is multiplication by a modular inverse, which is not integer division —
/// using it for money would be silently wrong. The caller supplies the result and this proves it.
pub fn assert_div(a: Field, b: Field, q: Field, r: Field) {
    assert(b != 0);
    assert(a == q * b + r);
    // r < b, proven by showing b - r - 1 is a small non-negative number.
    (b - r - 1).assert_max_bit_size::<MAX_UNITS_BITS>();
}

/// `assert_div` with an explicit bound on the divisor.
///
/// The fixed 96-bit version cannot express a division by the quote scale: converting base units
/// to quote units divides by 10^30, which is about 2^99.6, so proving `r < b` needs more than 96
/// bits for `b - r - 1`. Using the narrow version there fails with a range error that says
/// nothing about the real cause.
pub fn assert_div_bits<let BITS: u32>(a: Field, b: Field, q: Field, r: Field) {
    assert(b != 0);
    assert(a == q * b + r);
    (b - r - 1).assert_max_bit_size::<BITS>();
}
