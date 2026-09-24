use crate::merkle::hash2;
use poseidon::poseidon2::Poseidon2;

/// A shielded note.
///
/// Notes hold **raw units**, never a value. A stock note revalues when the issuer multiplier
/// changes and a treasury note when NAV is published, so a price move rewrites nothing — which
/// is what lets yield accrue privately with no per-note update.
pub struct Note {
    pub asset_id: Field,
    pub units: Field,
    /// poseidon2([pk_spend.x, pk_spend.y, npk]) — binds the note to a spending key.
    pub owner: Field,
    /// Per-note nullifier secret. Handing one to a prover reveals exactly that note's
    /// nullifier and nothing about any other note, past or future.
    pub nsecret: Field,
}

pub fn commitment(n: Note) -> Field {
    // nsecret is hashed before being committed so the commitment never exposes it directly.
    Poseidon2::hash([n.asset_id, n.units, n.owner, Poseidon2::hash([n.nsecret], 1)], 4)
}

/// The nullifier is bound to the leaf index as well as the note, so two identical notes at
/// different positions produce different nullifiers and neither can shadow the other.
pub fn nullifier(commitment_: Field, nsecret: Field, leaf_index: Field) -> Field {
    Poseidon2::hash([commitment_, nsecret, leaf_index], 3)
}

/// Owner binding. Kept as a function so the circuit and the client SDK cannot drift.
pub fn owner_of(pk_x: Field, pk_y: Field, npk: Field) -> Field {
    Poseidon2::hash([pk_x, pk_y, npk], 3)
}

/// Deterministic note randomness: `rho` and `nsecret` derive from the epoch viewing key and a
/// counter, so a client can regenerate every note it owns from its own key alone. That is what
/// makes recovery independent of any server, indexer or on-chain ciphertext.
pub fn derive_rho(ivk_epoch: Field, counter: Field) -> Field {
    hash2(ivk_epoch, counter)
}

pub fn derive_nsecret(ivk_epoch: Field, rho: Field) -> Field {
    Poseidon2::hash([ivk_epoch, rho, 1], 3)
}
