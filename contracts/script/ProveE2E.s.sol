// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RwaDarkPool} from "../src/RwaDarkPool.sol";
import {IVerifier} from "../src/interfaces/IVerifier.sol";
import {TestnetStockToken} from "../src/testnet/TestnetAssets.sol";

/// @notice A real shielded deposit and a real private withdrawal, on the live chain.
///
/// The proof is the one barretenberg produced and verified natively, committed at
/// `test/fixtures/unshield.proof`. Nothing here is constructed by the script: the commitment, the
/// root, the nullifier, the recipient and the amount are all fixed by that proof, so the deposit
/// has to land in exactly the tree position the proof was built against or the withdrawal fails.
///
/// That makes this a single assertion about the whole stack — Noir circuit, Poseidon2 in three
/// languages, `CommitmentTree`, the generated verifier and the deployed pool all agreeing — which
/// no unit test can make.
///
/// ## Screening is switched off first, and that is a real weakening
///
/// `shield` verifies a `ScreeningGate` attestation, and producing one needs a Schnorr signature
/// from an issuer key that does not exist yet. So this sets the shield verifier to `address(0)`,
/// which makes deposits open on testnet.
///
/// The withdrawal verifier is deliberately left alone. That asymmetry is the point: the deposit
/// gate decides *who may enter*, while the withdrawal gate is what stands between a forged proof
/// and the pool's funds. Testing the second with the first disabled costs nothing; the reverse
/// would be meaningless.
contract ProveE2E is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        RwaDarkPool pool = RwaDarkPool(vm.envAddress("ARCLITE_POOL"));
        TestnetStockToken token = TestnetStockToken(vm.envAddress("ARCLITE_TOKEN"));

        // Fixed by the committed proof. Changing any of these means regenerating it.
        uint16 assetId = 1;
        uint128 units = 100;
        bytes32 commitment = 0x01b2d87d6f4f966f6da54458e6a259c6463cc714df5ef6baa2edc5794ab6b087;
        bytes32 root = 0x04dfb911529b795d17a1f74fdc6345251508901326a359c3a8fd00abd2f44c27;
        bytes32 nullifier = 0x24926ef182fe58fb14076a863a6ad752093417ab95eb1cf46cb015e0e6c17690;
        address recipient = address(0xaaaa);

        bytes memory proof = vm.readFileBinary("test/fixtures/unshield.proof");

        console.log("chain    ", block.chainid);
        console.log("pool     ", address(pool));
        console.log("token    ", address(token));
        require(block.chainid != 4663, "never run this on mainnet");

        // Resumable. The first run's withdrawal ran out of gas in the verifier sub-call, leaving
        // the deposit in place and the nullifier unspent — so re-running must continue rather
        // than refuse. A script that can only run against a pristine chain is a script you
        // cannot use twice.
        bool alreadyDeposited = pool.nextLeafIndex() == 1 && pool.currentRoot() == root;

        if (!alreadyDeposited) {
            require(pool.nextLeafIndex() == 0, "tree is not empty; the fixture root assumes leaf 0");

            vm.startBroadcast(pk);

            // Open the deposit gate. Recorded in deployments/46630.json rather than left implicit.
            pool.setVerifiers(IVerifier(address(0)), pool.unshieldVerifier(), pool.batchVerifier());

            token.approve(address(pool), units);
            bytes32[] memory none = new bytes32[](0);
            uint32 leafIndex = pool.shield(assetId, units, commitment, hex"", none, hex"");

            vm.stopBroadcast();

            console.log("");
            console.log("  deposited at leaf", leafIndex);
            require(leafIndex == 0, "deposit did not land at leaf 0");
        } else {
            console.log("");
            console.log("  deposit already present, continuing to the withdrawal");
        }

        console.log("  pool owes units  ", pool.totalUnits(assetId));

        // The contract's tree and the circuit's tree are separate implementations. If they
        // disagreed, every proof would cite a root the pool has never held.
        require(pool.currentRoot() == root, "contract root != the root the proof was built against");
        console.log("  root matches the proof");

        require(!pool.nullifierSpent(nullifier), "this note has already been withdrawn");

        uint256 before = token.balanceOf(recipient);

        RwaDarkPool.UnshieldParams memory p;
        p.proof = proof;
        p.root = root;
        p.nullifier = nullifier;
        p.changeCommitment = bytes32(0);
        p.assetId = assetId;
        p.units = units;
        p.recipient = recipient;
        p.relayerFeeUnits = 0;
        p.relayer = address(0);
        p.ciphertext = hex"";

        vm.startBroadcast(pk);
        pool.unshield(p);
        vm.stopBroadcast();

        uint256 paid = token.balanceOf(recipient) - before;
        console.log("");
        console.log("  recipient received", paid);
        console.log("  nullifier spent   ", pool.nullifierSpent(nullifier));
        console.log("  pool still owes   ", pool.totalUnits(assetId));

        require(paid == units, "recipient was not paid the proven amount");
        require(pool.nullifierSpent(nullifier), "nullifier was not marked spent");
        require(pool.totalUnits(assetId) == 0, "pool still owes units it paid out");
        (bool solvent,,) = pool.isSolvent(assetId);
        require(solvent, "pool is not solvent after the withdrawal");

        console.log("");
        console.log("a real zero-knowledge withdrawal settled on chain", block.chainid);
        console.log("deployer unchanged:", deployer);
    }
}
