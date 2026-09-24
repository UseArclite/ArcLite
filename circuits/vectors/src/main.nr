// Ground-truth Poseidon2 vectors for the Solidity parity test (week-1 check #3).
//
// `poseidon2_permutation` is a stdlib blackbox executed by barretenberg, so the Solidity library
// must match *bb's* constants. These vectors are produced by nargo against that same blackbox,
// which makes them independent ground truth rather than a restatement of the Solidity port.
//
// Sweeps message_size 1..=6 across 8 seeds, so every sponge path is covered: partial chunks,
// exact chunk boundaries (3, 6 — where Noir skips the final permutation), and multi-chunk.
//
//   nargo execute --package vectors out   > emits 48 field elements, row-major [seed][len]
use poseidon::poseidon2::Poseidon2;

global SEEDS: u32 = 8;
global MAXLEN: u32 = 6;

fn main() -> pub [Field; 48] {
    let mut out: [Field; 48] = [0; 48];
    for s in 0..SEEDS {
        // Spread the seeds across the field rather than using small neighbouring integers,
        // so a constant-ordering or endianness error cannot coincidentally pass.
        let base = (s as Field) * 0x9e3779b97f4a7c15 + 1;
        let input: [Field; 6] = [base, base * 3 + 7, base * 5 + 11, base * 7 + 13, base * 11 + 17, base * 13 + 19];
        for l in 0..MAXLEN {
            out[s * MAXLEN + l] = Poseidon2::hash(input, l + 1);
        }
    }
    out
}
