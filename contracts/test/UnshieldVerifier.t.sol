// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {HonkVerifier} from "../src/verifiers/UnshieldVerifier.sol";

/// @title The real proof, verified on-chain
/// @notice This closes the gap `docs/blocker-solidity-verifier-stack.md` named: native `bb verify`
///         proved the circuit was sound, but the Solidity path — the one that actually runs in
///         production — was untested because the generated verifier would not compile.
///
///         The fixtures are the exact bytes barretenberg produced and verified natively. Nothing
///         here is constructed by the test, so a change to the circuit, the verification key, or
///         the verifier makes this fail rather than quietly verify something else.
///
///         The negative tests matter more than the positive one. A verifier that returns `true`
///         for the honest proof *and* for a tampered one is worse than no verifier at all: it
///         looks like a working safety check while enforcing nothing.
contract UnshieldVerifierTest is Test {
    HonkVerifier internal verifier;
    bytes internal proof;
    bytes32[] internal publicInputs;

    /// The eight public inputs `RwaDarkPool.unshield` builds, in order.
    uint256 internal constant IDX_ROOT = 0;
    uint256 internal constant IDX_NULLIFIER = 1;
    uint256 internal constant IDX_CHANGE_COMMITMENT = 2;
    uint256 internal constant IDX_ASSET_ID = 3;
    uint256 internal constant IDX_UNITS = 4;
    uint256 internal constant IDX_RECIPIENT = 5;
    uint256 internal constant IDX_RELAYER = 6;
    uint256 internal constant IDX_RELAYER_FEE = 7;

    function setUp() public {
        verifier = new HonkVerifier();
        proof = vm.readFileBinary("test/fixtures/unshield.proof");

        bytes memory raw = vm.readFileBinary("test/fixtures/unshield.public_inputs");
        require(raw.length % 32 == 0, "public inputs are not whole words");
        publicInputs = new bytes32[](raw.length / 32);
        for (uint256 i = 0; i < publicInputs.length; i++) {
            bytes32 word;
            // 0x20 skips the length prefix; each input is one word at 32-byte stride.
            assembly ("memory-safe") {
                word := mload(add(add(raw, 0x20), mul(i, 0x20)))
            }
            publicInputs[i] = word;
        }
    }

    /// Verification either returns false or reverts with a named error, depending on which check
    /// catches the tampering. Both are rejections; only `true` is acceptance.
    function _accepts(bytes32[] memory inputs) internal view returns (bool) {
        try verifier.verify(proof, inputs) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _acceptsProof(bytes memory p) internal view returns (bool) {
        try verifier.verify(p, publicInputs) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function _copyInputs() internal view returns (bytes32[] memory out) {
        out = new bytes32[](publicInputs.length);
        for (uint256 i = 0; i < publicInputs.length; i++) out[i] = publicInputs[i];
    }

    // ------------------------------------------------------------------------------------
    // the fixture is the one bb signed off on
    // ------------------------------------------------------------------------------------

    function test_FixtureMatchesTheDocumentedPublicInputs() public view {
        // Pinned against docs/blocker-solidity-verifier-stack.md. If the circuit's public-input
        // order ever changes, the proof would still verify — against a different statement — so
        // the order is asserted separately from the proof.
        assertEq(publicInputs.length, 8, "expected eight public inputs");
        assertEq(
            publicInputs[IDX_ROOT],
            bytes32(0x04dfb911529b795d17a1f74fdc6345251508901326a359c3a8fd00abd2f44c27),
            "root"
        );
        assertEq(
            publicInputs[IDX_NULLIFIER],
            bytes32(0x24926ef182fe58fb14076a863a6ad752093417ab95eb1cf46cb015e0e6c17690),
            "nullifier"
        );
        assertEq(uint256(publicInputs[IDX_CHANGE_COMMITMENT]), 0, "full withdrawal leaves no change");
        assertEq(uint256(publicInputs[IDX_ASSET_ID]), 1, "assetId");
        assertEq(uint256(publicInputs[IDX_UNITS]), 100, "units");
        assertEq(uint256(publicInputs[IDX_RECIPIENT]), 0xaaaa, "recipient");
        assertEq(uint256(publicInputs[IDX_RELAYER]), 0, "no relayer");
        assertEq(uint256(publicInputs[IDX_RELAYER_FEE]), 0, "no relayer fee");
    }

    function test_VerifiesTheRealProof() public view {
        assertTrue(verifier.verify(proof, publicInputs), "the honest proof must verify on-chain");
    }

    function test_VerificationGasIsAffordable() public view {
        uint256 before = gasleft();
        verifier.verify(proof, publicInputs);
        uint256 used = before - gasleft();
        // Recorded rather than asserted tightly: the number is a budgeting input for window
        // sizing, and a hard bound here would fail on an unrelated solc change.
        console.log("unshield verification gas:", used);
        assertLt(used, 3_000_000, "verification should stay well inside a block");
    }

    // ------------------------------------------------------------------------------------
    // tampering — the property that was untested until the verifier compiled
    // ------------------------------------------------------------------------------------

    function test_RejectsEveryTamperedPublicInput() public view {
        for (uint256 i = 0; i < publicInputs.length; i++) {
            bytes32[] memory inputs = _copyInputs();
            inputs[i] = bytes32(uint256(inputs[i]) + 1);
            assertFalse(_accepts(inputs), "a modified public input was accepted");
        }
    }

    function test_RejectsAnInflatedWithdrawal() public view {
        // The concrete attack: same proof, larger `units`. If this passed, a 100-unit note would
        // fund an arbitrary withdrawal.
        bytes32[] memory inputs = _copyInputs();
        inputs[IDX_UNITS] = bytes32(uint256(1_000_000));
        assertFalse(_accepts(inputs), "an inflated units value was accepted");
    }

    function test_RejectsARedirectedRecipient() public view {
        // Why `recipient` is a public input at all: a relayer holding a valid proof must not be
        // able to send the funds somewhere else.
        bytes32[] memory inputs = _copyInputs();
        inputs[IDX_RECIPIENT] = bytes32(uint256(uint160(address(0xBEEF))));
        assertFalse(_accepts(inputs), "a redirected recipient was accepted");
    }

    function test_RejectsAnInflatedRelayerFee() public view {
        bytes32[] memory inputs = _copyInputs();
        inputs[IDX_RELAYER_FEE] = bytes32(uint256(99));
        assertFalse(_accepts(inputs), "an inflated relayer fee was accepted");
    }

    function test_RejectsASubstitutedNullifier() public view {
        // Double-spend shape: reuse the proof under a fresh nullifier so the pool's spent-set
        // check passes.
        bytes32[] memory inputs = _copyInputs();
        inputs[IDX_NULLIFIER] = keccak256("a nullifier that was never proven");
        assertFalse(_accepts(inputs), "a substituted nullifier was accepted");
    }

    function test_RejectsAForeignRoot() public view {
        bytes32[] memory inputs = _copyInputs();
        inputs[IDX_ROOT] = keccak256("a root this proof was not built against");
        assertFalse(_accepts(inputs), "a foreign root was accepted");
    }

    function test_RejectsTheWrongNumberOfPublicInputs() public {
        bytes32[] memory short = new bytes32[](publicInputs.length - 1);
        for (uint256 i = 0; i < short.length; i++) short[i] = publicInputs[i];
        vm.expectRevert();
        verifier.verify(proof, short);
    }

    function test_RejectsATamperedProof() public view {
        // Flip one byte in each quarter of the proof rather than only the first: a verifier that
        // checked a prefix would pass a single-point test.
        uint256[4] memory offsets = [uint256(0), proof.length / 4, proof.length / 2, proof.length - 1];
        for (uint256 i = 0; i < offsets.length; i++) {
            bytes memory tampered = bytes(proof);
            tampered[offsets[i]] = bytes1(uint8(tampered[offsets[i]]) ^ 0x01);
            assertFalse(_acceptsProof(tampered), "a tampered proof was accepted");
        }
    }

    function test_RejectsATruncatedProof() public {
        bytes memory truncated = new bytes(proof.length - 32);
        for (uint256 i = 0; i < truncated.length; i++) truncated[i] = proof[i];
        vm.expectRevert();
        verifier.verify(truncated, publicInputs);
    }

    function test_RejectsAnEmptyProof() public {
        vm.expectRevert();
        verifier.verify("", publicInputs);
    }
}
