// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";

/// @notice Turns the shield screening gate off, because it is currently a gate on nobody.
///
/// `shield` verifies a screening proof only when `shieldVerifier` is set, and mainnet was
/// deployed with a real one while the browser has never generated a screening proof — it sends
/// `"0x"` and an empty public-input array, which is what testnet accepted because its pool was
/// deployed with `shieldVerifier = address(0)`. The result on mainnet is that every deposit
/// reverts with `InvalidProof`. Not some deposits: all of them, for everyone.
///
/// So this is not a weakening of a working control, it is the removal of a broken one. A gate
/// that rejects every honest user and screens nobody is worse than no gate, and it is exactly
/// the fallback `plan.md` lists for the screening circuit: ship without it, reinstate for A2.
/// The real fix is to wire the `screening` circuit into the browser prover next to `unshield`,
/// and that is a separate piece of work rather than a line in a script.
///
/// **The other two verifiers are re-set to the values they already hold.** `setVerifiers` takes
/// all three, so passing zero for the ones we are not changing would silently disable proof
/// checking on `unshield` — the one path that must never be optional, and the one that would not
/// revert to tell you about it. The assertions below exist for that mistake, not for this one.
///
///   POOL=0x... DEPLOYER_PRIVATE_KEY=... \
///   forge script script/DisableShieldGate.s.sol --rpc-url $RPC --broadcast
contract DisableShieldGate is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        RwaDarkPool pool = RwaDarkPool(vm.envAddress("POOL"));

        IVerifier unshieldBefore = pool.unshieldVerifier();
        IVerifier batchBefore = pool.batchVerifier();

        console.log("pool            ", address(pool));
        console.log("shield   before ", address(pool.shieldVerifier()));
        console.log("unshield before ", address(unshieldBefore));
        console.log("batch    before ", address(batchBefore));

        // If either of these is already zero something is very wrong and this script must not
        // be the thing that writes it back.
        require(address(unshieldBefore) != address(0), "unshield verifier is already unset");
        require(address(batchBefore) != address(0), "batch verifier is already unset");

        vm.startBroadcast(pk);
        pool.setVerifiers(IVerifier(address(0)), unshieldBefore, batchBefore);
        vm.stopBroadcast();

        require(address(pool.shieldVerifier()) == address(0), "shield gate still set");
        require(address(pool.unshieldVerifier()) == address(unshieldBefore), "unshield verifier changed");
        require(address(pool.batchVerifier()) == address(batchBefore), "batch verifier changed");

        console.log("");
        console.log("shield gate off; unshield and batch verifiers untouched");
    }
}
