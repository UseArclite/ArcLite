// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Poseidon2} from "./libraries/Poseidon2.sol";

interface IPoolWindows {
    struct Window {
        bytes32 ordersRoot;
        bytes32 tapeCommitment;
        uint64 sealedAt;
        uint64 settledAt;
        uint16 orderCount;
        uint8 subBatchCount;
        uint8 subBatchesSettled;
        bool finalized;
        bool voided;
    }

    function windows(uint64 windowId) external view returns (Window memory);
}

/// @title The delayed aggregate tape.
/// @notice What crossed, per asset, published after a delay.
///
/// The property that makes this credible is commitment-then-reveal. `batch_cross` fixes
/// `tapeLeaf` at proving time from the per-asset matched volumes, and `RwaDarkPool` chains those
/// leaves into `tapeCommitment` as each sub-batch settles. By the time anyone may publish, the
/// numbers are already determined — so the operator can neither edit the tape afterwards nor
/// release it early. Both halves matter: a tape you can edit is marketing, and a tape you can
/// publish instantly is a real-time feed that defeats the point of a dark venue.
///
/// Publishing is permissionless. The commitment is the authority, not the caller, and a tape that
/// only the operator can publish is a tape that goes unpublished the moment it is inconvenient.
///
/// @dev The tape carries **aggregates only**. It reveals how much of each asset crossed in a
///      window and nothing about who traded or in what size — the circuit commits to the volumes
///      directly rather than to the receipts root, precisely so that a reveal cannot expose the
///      book.
contract TapeRegistry {
    /// @dev Upper bound on the table, matching `arclite::price::MAX_ASSETS`. The tape leaf
    ///      chains only the *live* rows, so a publish costs one pair of hashes per traded asset
    ///      rather than 32 — the difference between ~1 M gas and ~9 M.
    uint256 public constant MAX_ASSETS = 32;

    /// @dev `keccak256("arclite.tape.v1") % P` is *not* what the circuit uses — it uses the
    ///      short ASCII tag "tape", so this mirrors that exactly. A domain separator that differs
    ///      by one byte produces a leaf nothing can ever match.
    uint256 internal constant DOMAIN_TAPE = 0x74617065; // "tape"

    IPoolWindows public immutable pool;

    /// @notice How long after settlement the tape may be published.
    uint64 public immutable tapeDelay;

    /// @notice Windows with fewer orders than this are never published.
    /// @dev k-anonymity. A window holding one order would publish that order's size as the
    ///      asset's whole volume — an aggregate of one is not an aggregate. Suppression is the
    ///      honest outcome: the tape simply has no entry for that window, rather than a
    ///      deniable-looking number.
    uint16 public immutable kAnonymity;

    struct Entry {
        uint16 assetId;
        uint128 volume;
    }

    mapping(uint64 => bool) public published;
    mapping(uint64 => Entry[]) private _entries;

    error WindowNotSettled(uint64 windowId);
    error WindowVoided(uint64 windowId);
    error TooEarly(uint64 windowId, uint64 publishableAt);
    error AlreadyPublished(uint64 windowId);
    error Suppressed(uint64 windowId, uint16 orderCount, uint16 required);
    error CommitmentMismatch(bytes32 expected, bytes32 got);
    error WrongVolumeCount(uint256 expected, uint256 got);

    event TapePublished(uint64 indexed windowId, uint64 publishedAt, uint256 entryCount);

    constructor(IPoolWindows pool_, uint64 tapeDelay_, uint16 kAnonymity_) {
        pool = pool_;
        tapeDelay = tapeDelay_;
        kAnonymity = kAnonymity_;
    }

    /// @notice Reveal a window's aggregate volumes against the commitment fixed at settlement.
    /// @param assetIds The table's live asset ids, in the order the circuit saw them.
    /// @param volumes  Matched units per row, aligned with `assetIds`. A traded asset may still
    ///                 have zero volume — a window where nothing crossed on it.
    /// @dev The row count is not validated against anything: it does not need to be. Claiming a
    ///      different number of rows produces a different chain, which fails the commitment
    ///      check. The reveal is self-validating, so there is no separate trusted input.
    function publishTape(
        uint64 windowId,
        uint8 subBatchCount,
        uint16[] calldata assetIds,
        uint128[] calldata volumes
    ) external {
        if (published[windowId]) revert AlreadyPublished(windowId);
        if (assetIds.length != volumes.length) revert WrongVolumeCount(assetIds.length, volumes.length);
        if (assetIds.length > MAX_ASSETS) revert WrongVolumeCount(MAX_ASSETS, assetIds.length);

        IPoolWindows.Window memory w = pool.windows(windowId);
        if (!w.finalized) revert WindowNotSettled(windowId);
        // A voided window crossed nothing, so it has no tape. Publishing an all-zero tape for it
        // would be accurate but misleading: it reads as "the venue was open and nothing traded".
        if (w.voided) revert WindowVoided(windowId);
        if (w.orderCount < kAnonymity) revert Suppressed(windowId, w.orderCount, kAnonymity);

        uint64 publishableAt = w.settledAt + tapeDelay;
        if (block.timestamp < publishableAt) revert TooEarly(windowId, publishableAt);

        // Rebuild the chain the pool accumulated, one leaf per sub-batch, exactly as the circuit
        // computed each one. This is the whole check: if the revealed volumes are not the proven
        // ones, the chain lands somewhere else.
        bytes32 chain = bytes32(0);
        for (uint8 i = 0; i < subBatchCount; ++i) {
            chain = keccak256(abi.encode(chain, _tapeLeaf(windowId, i, assetIds, volumes)));
        }
        if (chain != w.tapeCommitment) revert CommitmentMismatch(w.tapeCommitment, chain);

        Entry[] storage stored = _entries[windowId];
        uint256 count;
        for (uint256 i = 0; i < assetIds.length; ++i) {
            // A traded asset that crossed nothing is committed to but not worth a tape row.
            if (volumes[i] == 0) continue;
            stored.push(Entry({assetId: assetIds[i], volume: volumes[i]}));
            count++;
        }

        published[windowId] = true;
        emit TapePublished(windowId, uint64(block.timestamp), count);
    }

    /// @dev Mirrors `batch_cross`'s tape leaf: a Poseidon2 chain over a header and then every
    ///      table row's (assetId, matchedVolume).
    function _tapeLeaf(
        uint64 windowId,
        uint8 subBatchIndex,
        uint16[] calldata assetIds,
        uint128[] calldata volumes
    ) internal pure returns (bytes32) {
        uint256 h = Poseidon2.hash2(
            Poseidon2.hash2(DOMAIN_TAPE, uint256(windowId)),
            // The circuit's version is a constant here; a proof from another version could not
            // have produced a commitment this contract can match anyway.
            Poseidon2.hash2(uint256(subBatchIndex), 1)
        );
        for (uint256 i = 0; i < assetIds.length; ++i) {
            h = Poseidon2.hash2(h, Poseidon2.hash2(uint256(assetIds[i]), uint256(volumes[i])));
        }
        return bytes32(h);
    }

    function entries(uint64 windowId) external view returns (Entry[] memory) {
        return _entries[windowId];
    }

    /// @notice When a window's tape becomes publishable, and whether it ever will.
    function status(uint64 windowId)
        external
        view
        returns (bool isPublished, bool isPublishable, bool isSuppressed, uint64 publishableAt)
    {
        IPoolWindows.Window memory w = pool.windows(windowId);
        isPublished = published[windowId];
        isSuppressed = w.voided || (w.finalized && w.orderCount < kAnonymity);
        publishableAt = w.settledAt == 0 ? 0 : w.settledAt + tapeDelay;
        isPublishable =
            w.finalized && !isSuppressed && !isPublished && block.timestamp >= publishableAt;
    }
}
