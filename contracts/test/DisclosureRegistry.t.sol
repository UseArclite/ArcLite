// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DisclosureRegistry} from "../src/DisclosureRegistry.sol";

/// @notice Disclosure is mostly about what the contract refuses to claim. These tests pin the
///         limits as hard as the features — a registry that implied revocation clawed back a
///         key would be worse than having no registry, because a trader would rely on it.
contract DisclosureRegistryTest is Test {
    DisclosureRegistry internal reg;

    address internal gov = address(this);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal auditor = address(0xAD17);
    address internal other = address(0x07E5);

    bytes32 internal constant AUDITOR_KEY = bytes32(uint256(0xE2C));
    bytes internal sealedKey = hex"deadbeefcafe";

    function setUp() public {
        vm.warp(1_789_000_000);
        reg = new DisclosureRegistry(gov);
        reg.registerAuditor(auditor, AUDITOR_KEY, "Example Audit LLP");
    }

    // ------------------------------------------------------------------------------------
    // the limits, first
    // ------------------------------------------------------------------------------------

    /// The single most important property to state honestly: revoking withdraws standing, not
    /// knowledge. The auditor still holds the epoch key and can still decrypt.
    function test_RevocationIsForwardOnlyAndSaysSo() public {
        assertTrue(reg.REVOCATION_IS_FORWARD_ONLY(), "the ABI must announce this");

        vm.prank(alice);
        uint256 id = reg.grant(auditor, 7, sealedKey);

        vm.prank(alice);
        reg.revoke(id);

        // The sealed key is still on chain and still readable by anyone, including the auditor.
        // Revocation changed a flag; it did not and cannot unpublish it.
        DisclosureRegistry.Grant memory g = reg.grantAt(id);
        assertEq(g.sealedKey, sealedKey, "revoking must not pretend the key is gone");
        assertGt(g.revokedAt, 0, "grant is no longer standing");
        assertFalse(reg.isLive(id));
    }

    /// Deactivating an auditor stops new grants and deliberately leaves existing ones alone.
    /// Silently marking them revoked would tell traders their data was withdrawn when it was not.
    function test_DeactivatingAnAuditorDoesNotWithdrawPastGrants() public {
        vm.prank(alice);
        uint256 id = reg.grant(auditor, 7, sealedKey);

        reg.deactivateAuditor(auditor);

        assertTrue(reg.isLive(id), "an existing grant was silently revoked");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DisclosureRegistry.AuditorInactive.selector, auditor));
        reg.grant(auditor, 7, sealedKey);
    }

    /// The access log records what an auditor chooses to record. An empty log is not evidence.
    function test_TheAccessLogIsVoluntary() public {
        vm.prank(alice);
        uint256 id = reg.grant(auditor, 7, sealedKey);

        // Nobody has attested to anything, which says nothing about whether the key was used.
        assertEq(reg.accessCount(id), 0);

        vm.prank(auditor);
        reg.logAccess(id);
        assertEq(reg.accessCount(id), 1);
    }

    // ------------------------------------------------------------------------------------
    // granting
    // ------------------------------------------------------------------------------------

    function test_GrantsScopeToOneEpoch() public {
        // The scope is the key, not the record: `ivk_epoch` reconstructs epoch 7 and is useless
        // for epoch 8. The epoch here is a label for humans and indexers.
        vm.prank(alice);
        uint256 id = reg.grant(auditor, 7, sealedKey);
        DisclosureRegistry.Grant memory g = reg.grantAt(id);
        assertEq(g.grantor, alice);
        assertEq(g.auditor, auditor);
        assertEq(g.epoch, 7);
        assertEq(g.revokedAt, 0);
    }

    function test_OnlyTheGrantorCanGrantTheirOwnActivity() public {
        // There is no grant-on-behalf-of. Disclosure someone else can initiate for you is not
        // disclosure — the contract has no such entry point, which this asserts by construction.
        vm.prank(alice);
        uint256 id = reg.grant(auditor, 7, sealedKey);
        assertEq(reg.grantAt(id).grantor, alice, "the caller is always the grantor");

        vm.prank(bob);
        vm.expectRevert(DisclosureRegistry.NotGrantor.selector);
        reg.revoke(id);
    }

    function test_RegrantingTheSameScopeReplacesRatherThanAccumulates() public {
        vm.startPrank(alice);
        uint256 first = reg.grant(auditor, 7, sealedKey);
        uint256 second = reg.grant(auditor, 7, hex"0102");
        vm.stopPrank();

        // Two live grants for one scope would double-count in every UI reading this.
        assertFalse(reg.isLive(first), "the superseded grant is still live");
        assertTrue(reg.isLive(second));
        assertEq(reg.grantAt(second).sealedKey, hex"0102");
    }

    function test_DifferentEpochsAreSeparateGrants() public {
        vm.startPrank(alice);
        uint256 seven = reg.grant(auditor, 7, sealedKey);
        uint256 eight = reg.grant(auditor, 8, sealedKey);
        vm.stopPrank();
        assertTrue(reg.isLive(seven), "granting epoch 8 revoked epoch 7");
        assertTrue(reg.isLive(eight));
    }

    function test_DifferentAuditorsAreSeparateGrants() public {
        reg.registerAuditor(other, bytes32(uint256(0xF00)), "Second Auditor");
        vm.startPrank(alice);
        uint256 a = reg.grant(auditor, 7, sealedKey);
        uint256 b = reg.grant(other, 7, sealedKey);
        vm.stopPrank();
        assertTrue(reg.isLive(a));
        assertTrue(reg.isLive(b));
    }

    function test_RejectsAnUnknownAuditor() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DisclosureRegistry.UnknownAuditor.selector, bob));
        reg.grant(bob, 7, sealedKey);
    }

    function test_RejectsAnEmptySealedKey() public {
        vm.prank(alice);
        vm.expectRevert(DisclosureRegistry.EmptyKey.selector);
        reg.grant(auditor, 7, hex"");
    }

    function test_CannotRevokeTwice() public {
        vm.startPrank(alice);
        uint256 id = reg.grant(auditor, 7, sealedKey);
        reg.revoke(id);
        vm.expectRevert(abi.encodeWithSelector(DisclosureRegistry.AlreadyRevoked.selector, id));
        reg.revoke(id);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------
    // auditors
    // ------------------------------------------------------------------------------------

    /// Registering is governance-gated because the key is what grants are sealed to: anyone who
    /// could register an auditor could publish their own key under a trusted-looking name.
    function test_OnlyGovernanceRegistersAuditors() public {
        vm.prank(alice);
        vm.expectRevert(DisclosureRegistry.NotGovernance.selector);
        reg.registerAuditor(other, bytes32(uint256(1)), "Impostor");
    }

    function test_RejectsAnAuditorWithNoEncryptionKey() public {
        // Without a key there is nothing to seal to, so a grant would be plaintext or garbage.
        vm.expectRevert(DisclosureRegistry.EmptyKey.selector);
        reg.registerAuditor(other, bytes32(0), "No Key");
    }

    function test_CannotReregisterAnAuditor() public {
        // Otherwise governance could rotate a key and silently redirect future disclosures.
        vm.expectRevert(
            abi.encodeWithSelector(DisclosureRegistry.AuditorAlreadyRegistered.selector, auditor)
        );
        reg.registerAuditor(auditor, bytes32(uint256(2)), "Same Again");
    }

    function test_OnlyTheAuditorCanLogTheirOwnAccess() public {
        vm.prank(alice);
        uint256 id = reg.grant(auditor, 7, sealedKey);
        vm.prank(bob);
        vm.expectRevert(DisclosureRegistry.NotTheAuditor.selector);
        reg.logAccess(id);
    }

    function test_ARevokedGrantCannotBeLoggedAgainst() public {
        vm.startPrank(alice);
        uint256 id = reg.grant(auditor, 7, sealedKey);
        reg.revoke(id);
        vm.stopPrank();
        vm.prank(auditor);
        vm.expectRevert(abi.encodeWithSelector(DisclosureRegistry.GrantRevoked.selector, id));
        reg.logAccess(id);
    }

    // ------------------------------------------------------------------------------------
    // enumeration
    // ------------------------------------------------------------------------------------

    function test_ATraderCanSeeEverythingTheyHaveDisclosed() public {
        vm.startPrank(alice);
        reg.grant(auditor, 7, sealedKey);
        reg.grant(auditor, 8, sealedKey);
        vm.stopPrank();
        vm.prank(bob);
        reg.grant(auditor, 7, sealedKey);

        assertEq(reg.grantsByGrantor(alice).length, 2, "alice cannot see her own disclosures");
        assertEq(reg.grantsByGrantor(bob).length, 1);
        assertEq(reg.grantsByAuditor(auditor).length, 3);
    }

    function test_RejectsAGrantIdThatDoesNotExist() public {
        vm.expectRevert(abi.encodeWithSelector(DisclosureRegistry.NoSuchGrant.selector, uint256(42)));
        reg.grantAt(42);
    }
}
