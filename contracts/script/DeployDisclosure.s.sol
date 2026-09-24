// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";

/// @notice Deploy the disclosure registry.
/// @dev No auditor is registered here. Registering one publishes an encryption key that
///      disclosures get sealed to, and doing that from a deploy script — with a placeholder key
///      nobody holds the secret for — would create a trusted-looking recipient that can never
///      read anything. An auditor is registered when there is a real auditor.
contract DeployDisclosure is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address governance = vm.addr(pk);

        vm.startBroadcast(pk);
        DisclosureRegistry reg = new DisclosureRegistry(governance);
        vm.stopBroadcast();

        console.log("DisclosureRegistry", address(reg));
        console.log("governance        ", reg.governance());
        require(reg.governance() == governance, "governance mismatch");
        require(reg.REVOCATION_IS_FORWARD_ONLY(), "the ABI must announce the limit");
        require(reg.grantCount() == 0, "a fresh registry must hold no grants");
        require(reg.auditorList().length == 0, "no auditor should be pre-registered");
        console.log("wiring verified; no auditors registered yet, by design");
    }
}
