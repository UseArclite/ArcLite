// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {HonkVerifier} from "../src/verifiers/BatchCrossVerifier.sol";

/// @title The crossing proof, verified on-chain
/// @notice The fixture is a real `batch_cross` proof over a real crossing: two buyers for 30 and
///         10 units against one seller of 20, matched at 20 and split 15/5 pro-rata. Its witness
///         was built in TypeScript by `scripts/build-batch-witness.mjs` and accepted by the Noir
///         circuit unchanged — so the proof also stands as evidence that the client, the matcher,
///         the circuit and the contract all agree on Poseidon2, the note format, the price
///         packing and the tree.
contract BatchCrossVerifierTest is Test {
    HonkVerifier internal verifier;
    bytes internal proof;
    bytes32[] internal publicInputs;

    /// The public inputs `settleBatch` builds, in order.
    uint256 internal constant IDX_VERSION = 0;
    uint256 internal constant IDX_WINDOW = 1;
    uint256 internal constant IDX_SUB_BATCH = 2;
    uint256 internal constant IDX_OLD_ROOT = 3;
    uint256 internal constant IDX_ORDERS_ROOT = 4;
    uint256 internal constant IDX_PRICES_ROOT = 5;
    uint256 internal constant IDX_DEFER_MASK = 6;
    /// The quote asset a buy is funded with and a sell is paid in. A public input because a
    /// settler free to choose it could name a traded asset and pay sellers in it.
    uint256 internal constant IDX_QUOTE_ASSET = 7;
    uint256 internal constant IDX_OUTPUTS_ROOT = 8;
    uint256 internal constant IDX_RECEIPTS_ROOT = 9;
    uint256 internal constant IDX_TAPE_LEAF = 10;
    uint256 internal constant IDX_FIRST_NULLIFIER = 11;

    function setUp() public {
        verifier = new HonkVerifier();
        proof = vm.readFileBinary("test/fixtures/batch_cross.proof");
        bytes memory raw = vm.readFileBinary("test/fixtures/batch_cross.public_inputs");
        require(raw.length % 32 == 0, "public inputs are not whole words");
        publicInputs = new bytes32[](raw.length / 32);
        for (uint256 i = 0; i < publicInputs.length; i++) {
            bytes32 word;
            assembly ("memory-safe") {
                word := mload(add(add(raw, 0x20), mul(i, 0x20)))
            }
            publicInputs[i] = word;
        }
    }

    function _accepts(bytes32[] memory inputs) internal view returns (bool) {
        try verifier.verify(proof, inputs) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _copy() internal view returns (bytes32[] memory out) {
        out = new bytes32[](publicInputs.length);
        for (uint256 i = 0; i < publicInputs.length; i++) out[i] = publicInputs[i];
    }

    function test_PublicInputsMatchTheSettlementAbi() public view {
        // 10 scalars plus one nullifier per order slot. If the circuit's signature ever changes,
        // `settleBatch` would build a different array and verify a different statement — which
        // would still verify, against the wrong claim. So the shape is pinned here.
        assertEq(publicInputs.length, 27, "11 scalars + 16 nullifiers");
        assertEq(uint256(publicInputs[IDX_VERSION]), 1, "circuit version");
        assertEq(uint256(publicInputs[IDX_WINDOW]), 77, "window id");
        assertEq(uint256(publicInputs[IDX_SUB_BATCH]), 0, "sub-batch index");
        assertEq(uint256(publicInputs[IDX_DEFER_MASK]), 0, "nothing deferred in this window");
    }

    function test_ThreeOrdersSpendThreeNotesAndNoMore() public view {
        // Three real orders, thirteen padding slots. A padding slot must publish nullifier 0,
        // which the pool treats as "no spend" — otherwise an empty slot could burn a note.
        uint256 spends;
        for (uint256 i = IDX_FIRST_NULLIFIER; i < publicInputs.length; i++) {
            if (uint256(publicInputs[i]) != 0) spends++;
        }
        assertEq(spends, 3, "exactly three notes spent");
    }

    function test_VerifiesTheRealCrossingProof() public view {
        assertTrue(verifier.verify(proof, publicInputs), "the honest crossing must verify");
    }

    function test_VerificationGasIsAffordable() public view {
        uint256 before = gasleft();
        verifier.verify(proof, publicInputs);
        console.log("batch_cross verification gas:", before - gasleft());
        // Eight sub-batches per window have to fit in a block alongside settlement bookkeeping.
        assertLt(before - gasleft(), 3_500_000, "one sub-batch verification");
    }

    function test_RejectsEveryTamperedPublicInput() public view {
        for (uint256 i = 0; i < publicInputs.length; i++) {
            bytes32[] memory inputs = _copy();
            inputs[i] = bytes32(uint256(inputs[i]) + 1);
            assertFalse(_accepts(inputs), "a modified public input was accepted");
        }
    }

    function test_RejectsAReplayIntoAnotherWindow() public view {
        // The same crossing, claimed for a different window. Without this the operator could
        // settle one batch repeatedly against successive windows.
        bytes32[] memory inputs = _copy();
        inputs[IDX_WINDOW] = bytes32(uint256(78));
        assertFalse(_accepts(inputs), "a replayed window was accepted");
    }

    function test_RejectsAReplayIntoAnotherSubBatch() public view {
        bytes32[] memory inputs = _copy();
        inputs[IDX_SUB_BATCH] = bytes32(uint256(1));
        assertFalse(_accepts(inputs), "a replayed sub-batch index was accepted");
    }

    function test_RejectsASubstitutedPriceTable() public view {
        // The attack the seal-then-price ordering exists to stop, at the contract boundary:
        // settle against a price table other than the one committed.
        bytes32[] memory inputs = _copy();
        inputs[IDX_PRICES_ROOT] = keccak256("a table nobody committed");
        assertFalse(_accepts(inputs), "a substituted price table was accepted");
    }

    function test_RejectsASubstitutedOrderBook() public view {
        bytes32[] memory inputs = _copy();
        inputs[IDX_ORDERS_ROOT] = keccak256("a book nobody sealed");
        assertFalse(_accepts(inputs), "a substituted order book was accepted");
    }

    function test_RejectsAForgedOutputSubtree() public view {
        // The subtree the contract splices into the tree. Forging it is how you would mint notes.
        bytes32[] memory inputs = _copy();
        inputs[IDX_OUTPUTS_ROOT] = keccak256("notes nobody proved");
        assertFalse(_accepts(inputs), "a forged output subtree was accepted");
    }

    function test_RejectsAnAlteredTapeCommitment() public view {
        // Fixed at proving time so the tape cannot be edited afterwards or published early.
        bytes32[] memory inputs = _copy();
        inputs[IDX_TAPE_LEAF] = keccak256("a tape the crossing did not commit to");
        assertFalse(_accepts(inputs), "an altered tape commitment was accepted");
    }

    function test_RejectsASubstitutedNullifier() public view {
        bytes32[] memory inputs = _copy();
        inputs[IDX_FIRST_NULLIFIER] = keccak256("a note nobody spent");
        assertFalse(_accepts(inputs), "a substituted nullifier was accepted");
    }

    function test_RejectsAnExtraNullifierInAPaddingSlot() public view {
        // A padding slot carrying a nullifier would let a settlement burn a note that was never
        // part of the batch.
        bytes32[] memory inputs = _copy();
        inputs[publicInputs.length - 1] = keccak256("a note that was never in this batch");
        assertFalse(_accepts(inputs), "a padding-slot nullifier was accepted");
    }

    function test_RejectsATamperedProof() public view {
        uint256[4] memory offsets = [uint256(0), proof.length / 4, proof.length / 2, proof.length - 1];
        for (uint256 i = 0; i < offsets.length; i++) {
            bytes memory tampered = bytes(proof);
            tampered[offsets[i]] = bytes1(uint8(tampered[offsets[i]]) ^ 0x01);
            bool ok;
            try verifier.verify(tampered, publicInputs) returns (bool v) {
                ok = v;
            } catch {
                ok = false;
            }
            assertFalse(ok, "a tampered proof was accepted");
        }
    }
}
