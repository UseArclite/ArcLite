// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";

interface IPoolVerifiers {
    function shieldVerifier() external view returns (address);
    function unshieldVerifier() external view returns (address);
    function batchVerifier() external view returns (address);
}

/// @notice The deployed pool must not demand a proof the client cannot produce.
///
/// This exists because of a live failure. Mainnet was deployed with a real `shieldVerifier`;
/// testnet's pool has `address(0)`. `shield` only verifies a screening proof when that address
/// is set, and the browser sends `"0x"` with an empty public-input array — which testnet
/// accepted and mainnet rejected. Every mainnet deposit reverted with `InvalidProof`. Not some:
/// all of them, for everyone, from the first one attempted.
///
/// Nothing caught it because every test ran against a locally deployed pool that was configured
/// like testnet, and the two networks' configurations were never compared to each other or to
/// what the client actually sends.
///
/// So the property under test is not "is a verifier set" — either answer can be right. It is
/// **the deployed configuration and the client's call have to agree**, and the only way to
/// assert that is against a real deployment. Give it an RPC and it checks the pool on that
/// chain; without one it skips, so the offline suite stays offline.
///
///   RHC_MAINNET_RPC=https://rpc.mainnet.chain.robinhood.com POOL=0x16B2... \
///   forge test --mc ShieldGateParity -vv
///
/// The client sends an empty screening proof today. When that changes — when the `screening`
/// circuit is compiled, shipped to the browser and an attestation issuer exists — flip
/// `CLIENT_SENDS_SCREENING_PROOF` and this test starts demanding the opposite.
contract ShieldGateParityTest is Test {
    /// What `vault-provider.tsx` actually passes to `shield`. Today: `"0x"` and `[]`.
    bool constant CLIENT_SENDS_SCREENING_PROOF = false;

    function test_DeployedShieldGateMatchesWhatTheClientSends() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            console.log("skipped: set RHC_MAINNET_RPC and POOL to check a live deployment");
            return;
        }
        vm.createSelectFork(rpc);
        IPoolVerifiers pool = IPoolVerifiers(vm.envAddress("POOL"));

        address shield = pool.shieldVerifier();
        console.log("shieldVerifier  ", shield);
        console.log("client proves?  ", CLIENT_SENDS_SCREENING_PROOF);

        if (CLIENT_SENDS_SCREENING_PROOF) {
            assertTrue(
                shield != address(0),
                "the client generates a screening proof but the pool would never check it"
            );
        } else {
            assertEq(
                shield,
                address(0),
                "the pool demands a screening proof and the client sends an empty one: every deposit reverts"
            );
        }
    }

    /// The gate above is optional. These two are not, and a mistake here does not announce
    /// itself — a zero `unshieldVerifier` accepts any proof and lets anyone drain the pool,
    /// reverting nothing. `setVerifiers` takes all three at once, so changing one means passing
    /// the other two, and passing them wrongly is a single keystroke away.
    function test_WithdrawalAndCrossingVerifiersAreNeverUnset() public {
        string memory rpc = vm.envOr("RHC_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        IPoolVerifiers pool = IPoolVerifiers(vm.envAddress("POOL"));

        assertTrue(pool.unshieldVerifier() != address(0), "unshield verifier is unset");
        assertTrue(pool.batchVerifier() != address(0), "batch verifier is unset");
        assertGt(pool.unshieldVerifier().code.length, 0, "unshield verifier has no code");
        assertGt(pool.batchVerifier().code.length, 0, "batch verifier has no code");
    }
}
