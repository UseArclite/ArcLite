#!/usr/bin/env bash
# Regenerate the Solidity verifiers from the circuits, and apply the one patch they need.
#
# ## Why a patch step exists
#
# `bb write_solidity_verifier` emits a contract that no solc configuration will compile:
#
#     Yul exception: Variable expr_mpos_20 is 1 too deep in the stack
#     No memoryguard was present. Consider using memory-safe assembly only and annotating it
#     via 'assembly ("memory-safe") { ... }'.
#
# That second line is the cause, and it is why nothing in the first investigation helped — ten
# solc versions, both codegen pipelines, five optimizer configurations. Solc's stack-to-memory
# mover is *disabled outright* for a function containing un-annotated inline assembly, because
# it cannot know the assembly will not collide with the spill slots. No optimizer setting can
# re-enable it. Annotating the blocks lets the mover run, and the "1 too deep" variable spills.
#
# ## Why the annotation is true
#
# Every assembly block in the generated verifier does one of two things, both permitted by
# solc's definition of memory-safe:
#
#   * `invert` and `pow` allocate from the free memory pointer and bump it (rule 1), and use the
#     scratch space at 0x00 for the modexp precompile's output (rule 3).
#   * `ecMul`, `ecAdd` and `batchMul` use the region at and above the free memory pointer as
#     temporary space without bumping it (rule 4), and otherwise touch only memory reachable
#     through Solidity variables already in scope (rule 2).
#
# None of them write below the free memory pointer except in scratch, and solc places spill
# slots *below* the initial free memory pointer — so the two regions cannot overlap.
#
# The annotation changes no semantics: it is an assertion to the compiler, not a code change.
# That assertion is checked empirically rather than taken on trust — `forge test --match-contract
# UnshieldVerifier` verifies the exact proof barretenberg verified natively, and asserts that
# every tampered public input is rejected. Run it after regenerating; a wrong annotation would
# corrupt memory and show up there.
#
#   ./scripts/generate-verifiers.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"

command -v nargo >/dev/null || { echo "nargo not found (expected ~/.nargo/bin)"; exit 1; }
command -v bb    >/dev/null || { echo "bb not found (expected ~/.bb)"; exit 1; }

# Pinned deliberately: the generated verifier is cryptographic code, and a toolchain bump must be
# a visible change to this file rather than whatever happens to be installed.
EXPECTED_BB="5.2.0"
ACTUAL_BB="$(bb --version | tr -d '[:space:]')"
if [[ "$ACTUAL_BB" != "$EXPECTED_BB" ]]; then
  echo "bb version is $ACTUAL_BB, expected $EXPECTED_BB."
  echo "Bump EXPECTED_BB here and re-run the verifier tests before trusting the output."
  exit 1
fi

cd "$ROOT/circuits"

for circuit in unshield screening batch_cross; do
  case "$circuit" in
    unshield)  contract="UnshieldVerifier" ;;
    screening) contract="ScreeningVerifier" ;;
    batch_cross) contract="BatchCrossVerifier" ;;
  esac

  echo "==> $circuit"
  nargo compile --package "$circuit"
  # Per-circuit key directory. Writing every vk to `target/vk` left whichever circuit ran last
  # in the shared slot, so a proof generated afterwards would be keyed to the wrong circuit —
  # and would fail verification for a reason that looks nothing like its cause.
  mkdir -p "target/$circuit"
  bb write_vk -b "target/$circuit.json" -o "target/$circuit" --verifier_target evm >/dev/null
  bb write_solidity_verifier -k "target/$circuit/vk" \
     -o "$ROOT/contracts/src/verifiers/$contract.sol" >/dev/null

  out="$ROOT/contracts/src/verifiers/$contract.sol"

  # The patch. Counted rather than assumed: if the generator ever emits a block this does not
  # match, a silent zero-replacement would leave the file uncompilable and the cause obscure.
  before="$(grep -c 'assembly {' "$out" || true)"
  if [[ "$before" -eq 0 ]]; then
    echo "  no un-annotated assembly blocks found — has the generator changed?"
    exit 1
  fi
  perl -pi -e 's/\bassembly \{/assembly ("memory-safe") {/g' "$out"
  echo "  annotated $before assembly blocks memory-safe"

  # A stray un-annotated block would reintroduce the stack error in a way that looks like a
  # different bug, so fail here instead.
  if grep -q 'assembly {' "$out"; then
    echo "  an un-annotated assembly block remains"
    exit 1
  fi
done

# The prover reads the compiled circuit at runtime, and `circuits/target/` is gitignored build
# output — so nothing under it ever reaches a deployment. This copy is the committed artifact.
# Skipping it leaves the venue proving against whatever was compiled the last time someone
# remembered, which verifies locally and is rejected on chain.
echo "==> staging the runtime artifact"
mkdir -p "$ROOT/circuits/artifacts"
cp "$ROOT/circuits/target/batch_cross.json" "$ROOT/circuits/artifacts/batch_cross.json"
echo "  circuits/artifacts/batch_cross.json — commit it"

echo "==> compiling"
cd "$ROOT/contracts"
forge build --contracts src/verifiers

echo "==> verifying the generated verifier against a known-good proof"
forge test --match-contract UnshieldVerifier

echo "==> ok"
