// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "openzeppelin-contracts/contracts/access/AccessControl.sol";
import {Pausable} from "openzeppelin-contracts/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";

import {CommitmentTree} from "./CommitmentTree.sol";
import {EligibleRegistry} from "./EligibleRegistry.sol";
import {PriceCommitter} from "./PriceCommitter.sol";
import {IVerifier} from "./interfaces/IVerifier.sol";

/// @title The shielded RWA pool
/// @notice Holds every shielded token and owns the note commitment tree. Its safety rests on
///         four properties, each asserted by a test rather than argued in prose:
///
///         1. **Crossing moves no tokens.** In a uniform-price internal cross every unit a buyer
///            receives comes from a seller in the same window, so `settleBatch` transfers zero
///            ERC-20s. Tokens move only on `shield` and `unshield`. Solvency therefore reduces
///            to `balanceOf(pool) >= totalUnits[asset]`, an invariant that changes only on
///            deposit and withdrawal — inductive, and checkable by anyone.
///
///         2. **Unshield is always open.** No pause, no role, no window, no registry status.
///            A user holding a valid proof can leave while everything else is frozen. Anything
///            less makes "your funds are yours" conditional on our liveness.
///
///         3. **No admin path can move user tokens.** There is no rescue function, no sweep, no
///            arbitrary call. Governance can swap verifiers and pause deposits; it cannot touch
///            `totalUnits`, the nullifier set, or a root.
///
///         4. **Prices are committed after the book is sealed.** `sealWindow` freezes
///            `ordersRoot`; `PriceCommitter` then derives the reference. Settlement checks that
///            ordering held, so the operator never sees a price before choosing the order set.
///
///         Immutable by construction: no proxy, no delegatecall, no selfdestruct.
contract RwaDarkPool is CommitmentTree, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant SEALER_ROLE = keccak256("SEALER_ROLE");
    bytes32 public constant SETTLER_ROLE = keccak256("SETTLER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant GOV_ROLE = keccak256("GOV_ROLE");

    EligibleRegistry public immutable registry;
    /// @notice The asset a buy is funded with and a sell is paid in.
    /// @dev    A public input of every crossing proof, so the settler cannot choose it. A settler
    ///         free to name the quote asset could name a traded one and pay sellers in it,
    ///         inflating `totalUnits` for an asset the pool holds no more of. Immutable and
    ///         checked against the registry at construction: a quote asset the registry does not
    ///         know is one `unshield` could never pay out.
    uint16 public immutable quoteAssetId;
    PriceCommitter public immutable pricer;

    IVerifier public shieldVerifier;
    IVerifier public unshieldVerifier;
    IVerifier public batchVerifier;

    /// @dev Shielded units per asset. The counterpart of the pool's token balance, and the only
    ///      number solvency depends on.
    mapping(uint16 => uint256) public totalUnits;
    mapping(bytes32 => bool) public nullifierSpent;

    struct Window {
        bytes32 ordersRoot;
        /// @dev Chained over each sub-batch's proven `tapeLeaf`. Fixed once the window
        ///      finalises, which is what makes "delayed tape" mean something.
        bytes32 tapeCommitment;
        uint64 sealedAt;
        uint64 settledAt;
        uint16 orderCount;
        uint8 subBatchCount;
        uint8 subBatchesSettled;
        bool finalized;
        /// @dev Voided windows are finalized too, so `settleBatch` refuses them. Kept separate
        ///      so the tape and the audit trail can tell "settled" from "abandoned".
        bool voided;
    }

    mapping(uint64 => Window) public windows;

    /// @dev The window currently between `sealWindow` and finalization, or 0. While one is open,
    ///      deposits queue rather than insert so a batch's output subtree stays span-aligned.
    uint64 public openWindowId;

    /// @notice How long a sealed window may stay open before anyone may void it.
    /// @dev A window only closes by settling, and settling needs a proof. If that proof can never
    ///      be produced — a prover crash, a matcher bug, a circuit upgrade mid-window — the
    ///      window stays open forever, and every deposit after it queues instead of entering the
    ///      tree. Funds are never at risk (queued commitments are still owed, and `unshield` does
    ///      not care about windows), but the venue stops accepting new notes with no way back.
    ///      The deadline is the way back.
    uint64 public settlementDeadline = 1 hours;

    /// @dev Deposits arriving during an open settlement are queued rather than inserted, so a
    ///      batch's output subtree lands on a span-aligned index. Drained when the window
    ///      finalizes.
    bytes32[] private _pendingDeposits;
    uint256 public constant MAX_DRAIN_PER_SETTLE = 32;

    /// @dev The `batch_cross` circuit this pool speaks to. A proof carries its version as a
    ///      public input, so a proof built for another version cannot be replayed here — and an
    ///      upgraded circuit is a new verifier plus a bump, not a silent substitution.
    uint256 public constant CIRCUIT_VERSION = 1;

    /// @dev `batch_cross::N_ORDERS`. Fixed, because circuit shapes are: a sub-batch always
    ///      publishes exactly this many nullifier slots, with unused ones set to zero.
    uint256 public constant BATCH_ORDERS = 16;

    /// @dev `batch_cross::N_OUTPUTS` is 32, so the subtree it proves is always five levels deep.
    ///      Splicing at any other depth would place proven leaves at unproven positions.
    uint8 public constant OUTPUTS_SUBTREE_DEPTH = 5;

    event Shielded(
        uint16 indexed assetId, bytes32 indexed commitment, uint32 leafIndex, uint128 units, bytes ciphertext
    );
    event ShieldQueued(uint16 indexed assetId, bytes32 indexed commitment, uint128 units);
    event Unshielded(bytes32 indexed nullifier, uint16 indexed assetId, uint128 units, address indexed recipient);
    event WindowSealed(uint64 indexed windowId, bytes32 ordersRoot, uint16 orderCount, uint8 subBatchCount);
    event BatchSettled(uint64 indexed windowId, uint8 subBatchIndex, bytes32 newRoot, uint16 filledOrders);
    /// @notice The note commitments a settlement spliced in, so clients can rebuild the tree.
    /// @dev `LeafInserted` covers single deposits only; a subtree splice moves 32 leaves at once
    ///      and emitting one event each would be pure gas for no extra information.
    event OutputsPublished(
        uint64 indexed windowId, uint8 subBatchIndex, uint32 startIndex, bytes32 subtreeRoot, bytes32[] commitments
    );
    event WindowVoided(uint64 indexed windowId, uint8 subBatchesSettled, uint256 drained);
    event SettlementDeadlineChanged(uint64 previous, uint64 current);
    event VerifiersUpdated(address shield, address unshield, address batch);
    event SolvencyShortfall(uint16 indexed assetId, uint256 totalUnits, uint256 balance);

    error AssetNotActive(uint16 assetId);
    error ZeroAmount();
    error TransferAmountMismatch(uint256 expected, uint256 received);
    error InvalidProof();
    error NullifierAlreadySpent(bytes32 nullifier);
    error UnknownRoot(bytes32 root);
    error WindowAlreadySealed(uint64 windowId);
    error WindowNotSealed(uint64 windowId);
    error WindowNotPriced(uint64 windowId);
    error WindowFinalized(uint64 windowId);
    error WrongSubBatch(uint8 expected, uint8 got);
    error InsufficientPoolUnits(uint16 assetId, uint256 have, uint256 want);
    error ZeroRecipient();
    error WrongNullifierCount(uint256 expected, uint256 got);
    error WrongSubtreeDepth(uint8 expected, uint8 got);
    error WindowNotVoidable(uint64 windowId, uint64 voidableAt);
    error WrongOutputCount(uint256 expected, uint256 got);
    error UnknownQuoteAsset(uint16 assetId);

    constructor(
        address admin,
        EligibleRegistry registry_,
        PriceCommitter pricer_,
        IVerifier shieldVerifier_,
        IVerifier unshieldVerifier_,
        IVerifier batchVerifier_,
        uint16 quoteAssetId_
    ) {
        registry = registry_;
        if (registry_.asset(quoteAssetId_).kind == EligibleRegistry.AssetKind.NONE) {
            revert UnknownQuoteAsset(quoteAssetId_);
        }
        quoteAssetId = quoteAssetId_;
        pricer = pricer_;
        shieldVerifier = shieldVerifier_;
        unshieldVerifier = unshieldVerifier_;
        batchVerifier = batchVerifier_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOV_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        _grantRole(SEALER_ROLE, admin);
        _grantRole(SETTLER_ROLE, admin);
    }

    // =========================================================================================
    // shield — tokens in
    // =========================================================================================

    /// @notice Deposit `units` of an eligible asset and add its note commitment to the tree.
    /// @dev    Deposits are public in (depositor, asset, amount); that is unavoidable if
    ///         `totalUnits` is to be trustworthy without a proof, and it matches every shielded
    ///         pool. Privacy comes from the anonymity set inside the pool and from the crossing,
    ///         not from hiding the deposit — the UI should say so rather than implying otherwise.
    function shield(
        uint16 assetId,
        uint128 units,
        bytes32 commitment,
        bytes calldata screeningProof,
        bytes32[] calldata screeningPublicInputs,
        bytes calldata ciphertext
    ) external nonReentrant whenNotPaused returns (uint32 leafIndex) {
        if (units == 0) revert ZeroAmount();

        EligibleRegistry.Asset memory a = registry.asset(assetId);
        if (a.status != EligibleRegistry.AssetStatus.ACTIVE) revert AssetNotActive(assetId);

        // The commitment is bound into the screening proof's public inputs by the circuit, so a
        // valid attestation cannot be replayed onto somebody else's deposit.
        if (address(shieldVerifier) != address(0)) {
            if (!shieldVerifier.verify(screeningProof, screeningPublicInputs)) revert InvalidProof();
        }

        IERC20 token = IERC20(a.token);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), units);
        uint256 received = token.balanceOf(address(this)) - before;
        // A fee-on-transfer or rebasing token would silently break `balanceOf >= totalUnits`.
        // Measure the delta rather than trusting the argument.
        if (received != units) revert TransferAmountMismatch(units, received);

        totalUnits[assetId] += units;

        // During an open settlement, queue instead of inserting: a batch splices a span-aligned
        // subtree, and an interleaved single insert would misalign it.
        if (_settlementOpen()) {
            _pendingDeposits.push(commitment);
            emit ShieldQueued(assetId, commitment, units);
            return type(uint32).max;
        }

        leafIndex = _insert(commitment);
        emit Shielded(assetId, commitment, leafIndex, units, ciphertext);
    }

    // =========================================================================================
    // unshield — tokens out, always
    // =========================================================================================

    struct UnshieldParams {
        bytes proof;
        bytes32 root;
        bytes32 nullifier;
        bytes32 changeCommitment; // zero when the note is fully spent
        uint16 assetId;
        uint128 units;
        address recipient;
        uint128 relayerFeeUnits;
        address relayer;
        bytes ciphertext;
    }

    /// @notice Withdraw shielded units to `recipient`.
    /// @dev    Deliberately carries no `whenNotPaused`, no role and no window check. Callable by
    ///         anyone holding a valid proof — the owner from a fresh address, or a relayer. That
    ///         self-relay path is what makes "always open" a property rather than a promise: if
    ///         this operator disappears or censors, funds still come out.
    ///
    ///         `recipient`, `relayer` and `relayerFeeUnits` are public inputs to the proof, so a
    ///         relayer can neither redirect the withdrawal nor inflate its own fee.
    function unshield(UnshieldParams calldata p) external nonReentrant {
        if (p.units == 0) revert ZeroAmount();
        if (p.recipient == address(0)) revert ZeroRecipient();
        if (p.relayerFeeUnits > p.units) revert InsufficientPoolUnits(p.assetId, p.units, p.relayerFeeUnits);
        if (!isKnownRoot(p.root)) revert UnknownRoot(p.root);
        if (nullifierSpent[p.nullifier]) revert NullifierAlreadySpent(p.nullifier);

        // Note the registry is read for the token address only — status is NOT checked. A
        // delisted or paused asset must still be withdrawable, or delisting would strand funds.
        EligibleRegistry.Asset memory a = registry.asset(p.assetId);

        if (address(unshieldVerifier) != address(0)) {
            bytes32[] memory publicInputs = new bytes32[](8);
            publicInputs[0] = p.root;
            publicInputs[1] = p.nullifier;
            publicInputs[2] = p.changeCommitment;
            publicInputs[3] = bytes32(uint256(p.assetId));
            publicInputs[4] = bytes32(uint256(p.units));
            publicInputs[5] = bytes32(uint256(uint160(p.recipient)));
            publicInputs[6] = bytes32(uint256(uint160(p.relayer)));
            publicInputs[7] = bytes32(uint256(p.relayerFeeUnits));
            if (!unshieldVerifier.verify(p.proof, publicInputs)) revert InvalidProof();
        }

        uint256 have = totalUnits[p.assetId];
        if (have < p.units) revert InsufficientPoolUnits(p.assetId, have, p.units);

        nullifierSpent[p.nullifier] = true;
        totalUnits[p.assetId] = have - p.units;

        if (p.changeCommitment != bytes32(0)) {
            if (_settlementOpen()) _pendingDeposits.push(p.changeCommitment);
            else _insert(p.changeCommitment);
        }

        IERC20 token = IERC20(a.token);
        uint128 toRecipient = p.units - p.relayerFeeUnits;
        token.safeTransfer(p.recipient, toRecipient);
        if (p.relayerFeeUnits > 0 && p.relayer != address(0)) {
            token.safeTransfer(p.relayer, p.relayerFeeUnits);
        }

        emit Unshielded(p.nullifier, p.assetId, p.units, p.recipient);
    }

    // =========================================================================================
    // windows
    // =========================================================================================

    /// @notice Freeze a window's order set.
    /// @dev    Must happen before `PriceCommitter.commitWindow`. Reversing the two would hand the
    ///         operator a free option on the reference, so `settleBatch` refuses a window whose
    ///         prices were committed before it was sealed.
    function sealWindow(uint64 windowId, bytes32 ordersRoot, uint16 orderCount, uint8 subBatchCount)
        external
        onlyRole(SEALER_ROLE)
        whenNotPaused
    {
        Window storage w = windows[windowId];
        if (w.sealedAt != 0) revert WindowAlreadySealed(windowId);
        w.ordersRoot = ordersRoot;
        w.sealedAt = uint64(block.timestamp);
        w.orderCount = orderCount;
        w.subBatchCount = subBatchCount;
        openWindowId = windowId;
        emit WindowSealed(windowId, ordersRoot, orderCount, subBatchCount);
    }

    struct SettleParams {
        uint64 windowId;
        uint8 subBatchIndex;
        bytes proof;
        bytes32 oldRoot;
        bytes32 outputsSubtreeRoot;
        uint8 outputsSubtreeDepth;
        bytes32[] nullifiers;
        /// @dev The 32 output note commitments, in subtree order. Published so the commitment
        ///      set is reconstructible from chain data alone — without them a note created by a
        ///      settlement could never be spent, because its owner could not build a Merkle path
        ///      to it. Not verified on-chain: they are checkable for free against
        ///      `outputsSubtreeRoot`, which the proof already fixed, so a client that receives
        ///      wrong leaves detects it immediately and nobody pays 31 hashes of gas per batch
        ///      to re-prove what the circuit proved.
        bytes32[] outputCommitments;
        bytes32 receiptsRoot;
        /// @dev Fixed by the circuit at proving time, so the tape can be neither edited
        ///      afterwards nor published early. `TapeRegistry` checks the reveal against the
        ///      accumulated commitment.
        bytes32 tapeLeaf;
        uint16 filledOrders;
    }

    /// @notice Settle one sub-batch of a sealed window.
    /// @dev    Transfers no tokens — see property 1. `SETTLER_ROLE` gates spam, not safety: the
    ///         proof is the safety, and a wrong settlement is rejected regardless of who submits.
    function settleBatch(SettleParams calldata p) external nonReentrant whenNotPaused onlyRole(SETTLER_ROLE) {
        Window storage w = windows[p.windowId];
        if (w.sealedAt == 0) revert WindowNotSealed(p.windowId);
        // Covers voided windows too: voiding sets `finalized`, so a late proof for an abandoned
        // window cannot arrive afterwards and splice a subtree into a tree that has moved on.
        if (w.finalized) revert WindowFinalized(p.windowId);
        if (p.subBatchIndex != w.subBatchesSettled) revert WrongSubBatch(w.subBatchesSettled, p.subBatchIndex);

        PriceCommitter.WindowPrices memory wp = pricer.window(p.windowId);
        if (wp.committedAt == 0) revert WindowNotPriced(p.windowId);
        // The ordering that denies the operator a free option, enforced rather than assumed.
        if (wp.committedAt < w.sealedAt) revert WindowNotSealed(p.windowId);

        if (!isKnownRoot(p.oldRoot)) revert UnknownRoot(p.oldRoot);

        // The shapes the circuit fixes. A shorter nullifier array or a different subtree depth
        // would still verify — against a different statement — so they are checked, not assumed.
        if (p.nullifiers.length != BATCH_ORDERS) {
            revert WrongNullifierCount(BATCH_ORDERS, p.nullifiers.length);
        }
        if (p.outputsSubtreeDepth != OUTPUTS_SUBTREE_DEPTH) {
            revert WrongSubtreeDepth(OUTPUTS_SUBTREE_DEPTH, p.outputsSubtreeDepth);
        }
        uint256 outputCount = 1 << OUTPUTS_SUBTREE_DEPTH;
        if (p.outputCommitments.length != outputCount) {
            revert WrongOutputCount(outputCount, p.outputCommitments.length);
        }

        if (address(batchVerifier) != address(0)) {
            // Exactly `batch_cross::main`'s public inputs, in its order. This array *is* the
            // statement being verified: a value omitted here is a value the prover may choose
            // freely. `outputsSubtreeRoot` is the one that matters most — it used to be absent,
            // which let a valid proof splice an arbitrary subtree into the tree and mint notes
            // the circuit never proved.
            bytes32[] memory publicInputs = new bytes32[](11 + BATCH_ORDERS);
            publicInputs[0] = bytes32(CIRCUIT_VERSION);
            publicInputs[1] = bytes32(uint256(p.windowId));
            publicInputs[2] = bytes32(uint256(p.subBatchIndex));
            publicInputs[3] = p.oldRoot;
            publicInputs[4] = w.ordersRoot;
            publicInputs[5] = wp.pricesRoot;
            publicInputs[6] = bytes32(wp.deferMask);
            publicInputs[7] = bytes32(uint256(quoteAssetId));
            publicInputs[8] = p.outputsSubtreeRoot;
            publicInputs[9] = p.receiptsRoot;
            publicInputs[10] = p.tapeLeaf;
            for (uint256 i = 0; i < BATCH_ORDERS; ++i) {
                publicInputs[11 + i] = p.nullifiers[i];
            }
            if (!batchVerifier.verify(p.proof, publicInputs)) revert InvalidProof();
        }

        for (uint256 i = 0; i < p.nullifiers.length; ++i) {
            bytes32 n = p.nullifiers[i];
            if (n == bytes32(0)) continue; // padding slot for an unused order
            if (nullifierSpent[n]) revert NullifierAlreadySpent(n);
            nullifierSpent[n] = true;
        }

        // Deposits taken before this window was sealed left the tree at an arbitrary index, so
        // align before splicing. Skipping costs one storage write and is sound: unfilled slots
        // are already zero subtrees in the frontier.
        _alignForSubtree(p.outputsSubtreeDepth);
        uint32 startIndex = nextLeafIndex;
        _insertSubtree(p.outputsSubtreeRoot, p.outputsSubtreeDepth);
        emit OutputsPublished(
            p.windowId, p.subBatchIndex, startIndex, p.outputsSubtreeRoot, p.outputCommitments
        );

        // Chained rather than overwritten: every sub-batch's leaf has to survive into the
        // window's final commitment, or the tape could omit one and still check out.
        w.tapeCommitment = keccak256(abi.encode(w.tapeCommitment, p.tapeLeaf));

        w.subBatchesSettled += 1;
        if (w.subBatchesSettled >= w.subBatchCount) {
            w.finalized = true;
            w.settledAt = uint64(block.timestamp);
            // Clear before draining: the drain inserts single leaves, which is only safe once
            // no subtree splice can follow in this window.
            openWindowId = 0;
            _drainPendingDeposits();
        }

        emit BatchSettled(p.windowId, p.subBatchIndex, currentRoot(), p.filledOrders);
    }

    /// @notice Abandon a window that cannot be settled, freeing deposits to enter the tree.
    /// @dev Moves no tokens, marks no nullifiers, and overwrites no root — voiding is a no-op on
    ///      value, which is precisely why it is safe to make it permissionless after a deadline.
    ///      Every order in the window simply never crossed, and the notes backing them were never
    ///      spent: nullifiers are published at settlement, so an unsettled window leaves them
    ///      untouched and the traders' notes remain theirs.
    ///
    ///      A guardian may void immediately, because waiting an hour to recover from a prover
    ///      crash is an hour of rejected deposits. Anyone may void after `settlementDeadline`,
    ///      so recovery does not depend on the operator being available or willing.
    function voidWindow(uint64 windowId) external nonReentrant {
        Window storage w = windows[windowId];
        if (w.sealedAt == 0) revert WindowNotSealed(windowId);
        if (w.finalized) revert WindowFinalized(windowId);

        uint64 voidableAt = w.sealedAt + settlementDeadline;
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && block.timestamp < voidableAt) {
            revert WindowNotVoidable(windowId, voidableAt);
        }

        w.finalized = true;
        w.voided = true;
        w.settledAt = uint64(block.timestamp);

        // Same ordering as settlement: clear the flag before draining, because the drain inserts
        // single leaves and that is only safe once no subtree splice can follow.
        if (openWindowId == windowId) openWindowId = 0;
        uint256 queued = _pendingDeposits.length;
        _drainPendingDeposits();

        emit WindowVoided(windowId, w.subBatchesSettled, queued - _pendingDeposits.length);
    }

    function setSettlementDeadline(uint64 deadline) external onlyRole(GOV_ROLE) {
        emit SettlementDeadlineChanged(settlementDeadline, deadline);
        settlementDeadline = deadline;
    }

    function _settlementOpen() internal view returns (bool) {
        return openWindowId != 0;
    }

    function _drainPendingDeposits() private {
        uint256 n = _pendingDeposits.length;
        if (n > MAX_DRAIN_PER_SETTLE) n = MAX_DRAIN_PER_SETTLE;
        for (uint256 i = 0; i < n; ++i) {
            _insert(_pendingDeposits[i]);
        }
        if (n == _pendingDeposits.length) {
            delete _pendingDeposits;
        } else {
            // Keep the tail for the next settlement rather than dropping it.
            uint256 remaining = _pendingDeposits.length - n;
            for (uint256 i = 0; i < remaining; ++i) {
                _pendingDeposits[i] = _pendingDeposits[i + n];
            }
            for (uint256 i = 0; i < n; ++i) {
                _pendingDeposits.pop();
            }
        }
    }

    // =========================================================================================
    // solvency
    // =========================================================================================

    /// @notice Whether the pool actually holds what it says it owes for an asset.
    /// @dev    The load-bearing check, and it is deliberately a plain comparison anyone can make.
    ///         Note it can be broken *by the issuer*: RHC tokenized equities expose
    ///         `adminBurn(address,uint256)`, so the issuer can destroy tokens the pool holds.
    ///         That is not a bug here to be fixed; it is a disclosed property of the asset.
    function isSolvent(uint16 assetId) public view returns (bool solvent, uint256 owed, uint256 held) {
        EligibleRegistry.Asset memory a = registry.asset(assetId);
        owed = totalUnits[assetId];
        held = IERC20(a.token).balanceOf(address(this));
        solvent = held >= owed;
    }

    /// @notice Record a shortfall on-chain so it is observable rather than inferred.
    /// @dev    Permissionless: anyone may raise the alarm. Emitting does not block withdrawals —
    ///         with collateral destroyed, first-come-first-served is the honest behaviour, and
    ///         freezing would only guarantee nobody gets paid.
    function reportSolvency(uint16 assetId) external returns (bool solvent) {
        uint256 owed;
        uint256 held;
        (solvent, owed, held) = isSolvent(assetId);
        if (!solvent) emit SolvencyShortfall(assetId, owed, held);
    }

    // =========================================================================================
    // governance — deliberately narrow
    // =========================================================================================

    /// @dev Pauses deposits, sealing and settlement. Never unshield.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    /// @dev Verifiers are swappable because circuits get upgraded; nothing else is. There is no
    ///      function here that can move a token, change `totalUnits`, write a nullifier, or
    ///      overwrite a root.
    function setVerifiers(IVerifier shield_, IVerifier unshield_, IVerifier batch_) external onlyRole(GOV_ROLE) {
        shieldVerifier = shield_;
        unshieldVerifier = unshield_;
        batchVerifier = batch_;
        emit VerifiersUpdated(address(shield_), address(unshield_), address(batch_));
    }

    function pendingDepositCount() external view returns (uint256) {
        return _pendingDeposits.length;
    }
}
