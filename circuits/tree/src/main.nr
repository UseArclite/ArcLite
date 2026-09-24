// Ground truth for the on-chain commitment tree.
//
// The tree is built twice — by `CommitmentTree.sol` and, implicitly, by every circuit that
// proves membership from a leaf and a path. If the two disagree by one hash the contract accepts
// roots no prover can reach, or worse, accepts a root for a tree it did not build. These vectors
// pin the agreement at the shapes the contract actually produces.
use poseidon::poseidon2::Poseidon2;

global DEPTH: u32 = 24;

fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

/// Root of a depth-24 tree containing a single leaf at index 0, everything else empty.
fn root_with_one_leaf(leaf: Field) -> Field {
    let mut zero = 0;
    let mut node = leaf;
    for _ in 0..DEPTH {
        node = hash2(node, zero);
        zero = hash2(zero, zero);
    }
    node
}

/// Root of a fully empty depth-24 tree.
fn empty_root() -> Field {
    let mut zero = 0;
    for _ in 0..DEPTH {
        zero = hash2(zero, zero);
    }
    zero
}

/// Root after four leaves, i.e. a filled depth-2 subtree padded up to depth 24.
fn root_with_four_leaves(l0: Field, l1: Field, l2: Field, l3: Field) -> Field {
    let mut node = hash2(hash2(l0, l1), hash2(l2, l3));
    // zeros[2] — the empty subtree of height 2 — is where padding resumes.
    let z0 = 0;
    let z1 = hash2(z0, z0);
    let mut zero = hash2(z1, z1);
    for _ in 2..DEPTH {
        node = hash2(node, zero);
        zero = hash2(zero, zero);
    }
    node
}

fn main() -> pub [Field; 4] {
    [
        empty_root(),
        root_with_one_leaf(1),
        root_with_four_leaves(11, 22, 33, 44),
        hash2(1, 2),
    ]
}

// ---------------------------------------------------------------------------------------------
// The loop-closing test.
//
// `CommitmentTree.sol` builds the tree by appending; a circuit rebuilds a root from a leaf and
// an authentication path. Those are different algorithms over the same structure, and if they
// disagree the contract accepts roots no prover can produce. The constants below are the roots
// the Solidity implementation actually computes, asserted in
// `contracts/test/CommitmentTreeParity.t.sol`.
// ---------------------------------------------------------------------------------------------

mod tests {
    use arclite::merkle::{compute_root, hash2, DEPTH};
    use super::{empty_root, root_with_four_leaves, root_with_one_leaf};

    fn empty_path() -> [Field; DEPTH] {
        let mut path: [Field; DEPTH] = [0; DEPTH];
        let mut zero: Field = 0;
        for i in 0..DEPTH {
            path[i] = zero;
            zero = hash2(zero, zero);
        }
        path
    }

    /// Path reconstruction must land on the same root as appending. This is the property every
    /// membership proof in the system depends on.
    #[test]
    fn path_reconstruction_matches_append_at_index_zero() {
        let leaf: Field = 1;
        assert(compute_root(leaf, empty_path(), 0) == root_with_one_leaf(leaf));
    }

    /// Index 1 is the right child at level 0, so the sibling ordering is exercised in the
    /// opposite direction — a swapped conditional would pass the index-0 test and fail here.
    #[test]
    fn path_reconstruction_handles_right_children() {
        let l0: Field = 11;
        let l1: Field = 22;
        let mut path = empty_path();
        path[0] = l0; // sibling of leaf 1 at level 0 is leaf 0

        let expected = {
            let mut node = hash2(l0, l1);
            let z0: Field = 0;
            let mut zero = hash2(z0, z0);
            for _ in 1..DEPTH {
                node = hash2(node, zero);
                zero = hash2(zero, zero);
            }
            node
        };
        assert(compute_root(l1, path, 1) == expected);
    }

    #[test]
    fn empty_root_is_the_zero_ladder() {
        let mut zero: Field = 0;
        for _ in 0..DEPTH {
            zero = hash2(zero, zero);
        }
        assert(empty_root() == zero);
    }

    #[test]
    fn four_leaf_root_is_stable() {
        // Pinned against the Solidity implementation in CommitmentTreeParity.t.sol.
        assert(
            root_with_four_leaves(11, 22, 33, 44)
                == 0x2f4adc76aa848323a416713836219d439717ee67fb141abe08daf724827909c5,
        );
    }

    #[test]
    fn one_leaf_root_is_stable() {
        assert(
            root_with_one_leaf(1)
                == 0x0f1163e4a6c699933f342fee0d8c188626c7999bb17ad8b72f27836540cd840b,
        );
    }
}
