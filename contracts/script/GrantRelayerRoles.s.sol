// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {PriceCommitter} from "../src/PriceCommitter.sol";

/// @notice Gives the relayer exactly the three roles it needs, and nothing else.
///
/// The venue's routine signer should be able to seal a window, price it and settle it — and be
/// unable to do anything else. It is deliberately not the pool's admin: a leaked relayer key
/// must not be able to change verifiers, pause the venue, delist an asset, or grant itself
/// anything further. On testnet the relayer and the deployer are the same account, which is a
/// real weakening; carrying that to mainnet would mean the key that signs every window is also
/// the key that governs the venue.
///
/// So this script is the separation, and it asserts both halves of it: that the relayer gained
/// the three operational roles, and that it did **not** gain admin. The second assertion is the
/// one worth having — granting a role is easy to verify by eye, whereas "and nothing more" is
/// the part that quietly goes wrong.
///
/// Revoking the deployer's operational roles is deliberately not done here. The deployer keeps
/// them as a fallback until the relayer has demonstrably sealed and settled a window on its own;
/// removing them first would mean a relayer that cannot sign leaves the venue with nobody who
/// can. Revoke afterwards, once the relayer has proven itself.
///
///   RELAYER=0x... POOL=0x... PRICER=0x... DEPLOYER_PRIVATE_KEY=... \
///   forge script script/GrantRelayerRoles.s.sol --rpc-url $RPC --broadcast --slow
contract GrantRelayerRoles is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(pk);
        address relayer = vm.envAddress("RELAYER");
        RwaDarkPool pool = RwaDarkPool(vm.envAddress("POOL"));
        PriceCommitter pricer = PriceCommitter(vm.envAddress("PRICER"));

        require(relayer != address(0), "no relayer");
        // The whole point is that these are two different accounts. If they are the same one,
        // this script has granted nothing and has quietly confirmed the weakening it exists to
        // remove.
        require(relayer != admin, "relayer must not be the deployer");

        console.log("chain   ", block.chainid);
        console.log("admin   ", admin);
        console.log("relayer ", relayer);
        console.log("pool    ", address(pool));
        console.log("pricer  ", address(pricer));

        vm.startBroadcast(pk);
        pool.grantRole(pool.SEALER_ROLE(), relayer);
        pool.grantRole(pool.SETTLER_ROLE(), relayer);
        pricer.grantRole(pricer.PRICER_ROLE(), relayer);
        vm.stopBroadcast();

        require(pool.hasRole(pool.SEALER_ROLE(), relayer), "SEALER_ROLE not granted");
        require(pool.hasRole(pool.SETTLER_ROLE(), relayer), "SETTLER_ROLE not granted");
        require(pricer.hasRole(pricer.PRICER_ROLE(), relayer), "PRICER_ROLE not granted");

        // And nothing else. A relayer holding admin could grant itself anything, which would
        // make every other line here decorative.
        bytes32 adminRole = pool.DEFAULT_ADMIN_ROLE();
        require(!pool.hasRole(adminRole, relayer), "relayer must not hold pool admin");
        require(!pricer.hasRole(pricer.DEFAULT_ADMIN_ROLE(), relayer), "relayer must not hold pricer admin");
        require(!pool.hasRole(pool.GOV_ROLE(), relayer), "relayer must not hold GOV_ROLE");
        require(!pool.hasRole(pool.GUARDIAN_ROLE(), relayer), "relayer must not hold GUARDIAN_ROLE");
        require(pool.hasRole(adminRole, admin), "deployer should still be admin");

        console.log("");
        console.log("granted: SEALER, SETTLER (pool) and PRICER (committer)");
        console.log("withheld: admin, GOV and GUARDIAN");
    }
}
