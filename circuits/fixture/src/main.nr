// Emits the full witness for a known unshield case, so Prover.toml is built from the same code
// the circuit uses rather than from a hand-computed guess.
use arclite::merkle::{compute_root, hash2, DEPTH};
use arclite::note::{commitment, nullifier, owner_of, Note};

fn main() -> pub [Field; 27] {
    let asset_id: Field = 1;
    let in_units: Field = 100;
    let npk: Field = 7;
    let pk_x: Field = 11;
    let pk_y: Field = 13;
    let nsecret: Field = 17;

    let owner = owner_of(pk_x, pk_y, npk);
    let c = commitment(Note { asset_id, units: in_units, owner, nsecret });

    let mut path: [Field; DEPTH] = [0; DEPTH];
    let mut zero: Field = 0;
    for i in 0..DEPTH {
        path[i] = zero;
        zero = hash2(zero, zero);
    }

    let mut out: [Field; 27] = [0; 27];
    out[0] = compute_root(c, path, 0);
    out[1] = nullifier(c, nsecret, 0);
    out[2] = c;
    for i in 0..DEPTH {
        out[3 + i] = path[i];
    }
    out
}
