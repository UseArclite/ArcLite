global ROUNDS: u32 = 28000;
fn main(seed: Field) -> pub Field {
    let mut acc = seed;
    for _ in 0..ROUNDS { acc = poseidon::poseidon2::Poseidon2::hash([acc, acc + 1], 2); }
    acc
}
