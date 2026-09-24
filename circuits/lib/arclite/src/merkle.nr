use poseidon::poseidon2::Poseidon2;

/// Depth of the note commitment tree. Must equal `CommitmentTree.DEPTH`.
pub global DEPTH: u32 = 24;

pub fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

/// Recompute a root from a leaf and its authentication path.
///
/// The ordering must match `CommitmentTree._insert` exactly: at each level the node is the LEFT
/// child when the index bit is 0, and the right child when it is 1. Reversing that would produce
/// roots the contract can never reach — the same class of bug the Poseidon2 parity tests exist
/// to catch, one level up.
pub fn compute_root(leaf: Field, path: [Field; DEPTH], index: Field) -> Field {
    let bits: [bool; DEPTH] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..DEPTH {
        let sibling = path[i];
        // A conditional swap rather than a branch: both orderings are evaluated and selected,
        // so the circuit shape does not depend on secret index bits.
        let left = if bits[i] { sibling } else { node };
        let right = if bits[i] { node } else { sibling };
        node = hash2(left, right);
    }
    node
}
