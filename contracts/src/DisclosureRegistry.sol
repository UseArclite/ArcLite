// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Scoped disclosure to auditors.
/// @notice A trader hands an auditor the viewing key for one epoch of their own activity.
///
/// ## Scoping is cryptographic, not a contract flag
///
/// A note's randomness derives from `ivk_epoch = poseidon2(ivk, epoch)`, so the key for epoch 7
/// reconstructs epoch 7's notes and is useless for epoch 8. The grant below carries that key
/// sealed to the auditor, and the *scope is the key itself*. Nothing here relies on the contract
/// being asked nicely to limit what it returns — a flag an operator could flip would be a much
/// weaker promise than a key that mathematically cannot open another epoch.
///
/// ## Revocation is forward-only, and this contract will not pretend otherwise
///
/// Once an auditor holds `ivk_epoch`, they hold it. Revoking stops the grant being *presented* as
/// current, and stops nothing else: the auditor can still decrypt that epoch, forever, with no
/// way for anyone to know whether they did. `revoke` is therefore named for what it does — it
/// withdraws standing, not access — and `REVOCATION_IS_FORWARD_ONLY` exists so an integrator
/// reading the ABI cannot miss it. The UI must say the same thing rather than implying a granted
/// key can be taken back.
///
/// ## The access log is an attestation, not evidence
///
/// `logAccess` records that an auditor *says* they used a grant. Decryption happens on their
/// machine and leaves no trace anywhere else, so an empty log means nothing. It is useful as a
/// voluntary audit trail and worthless as proof that nobody looked. Treating it as the latter
/// would be the most dangerous misreading of this contract, so it is stated here rather than
/// left for someone to assume.
contract DisclosureRegistry {
    /// @notice Read this before integrating. Revoking a grant does not revoke knowledge.
    bool public constant REVOCATION_IS_FORWARD_ONLY = true;

    struct Auditor {
        /// @dev X25519 public key the viewing key is sealed to. The contract never sees plaintext.
        bytes32 encryptionKey;
        string name;
        bool active;
        uint64 registeredAt;
    }

    struct Grant {
        address grantor;
        address auditor;
        uint64 epoch;
        uint64 grantedAt;
        uint64 revokedAt;
        /// @dev `ivk_epoch` sealed to the auditor's key. Opaque here by design: a contract that
        ///      could read it would be a contract that published it.
        bytes sealedKey;
    }

    mapping(address => Auditor) public auditors;
    address[] private _auditorList;

    Grant[] private _grants;
    /// @dev Grantor to their own grant ids, so a trader can enumerate what they have disclosed
    ///      without scanning every grant ever made.
    mapping(address => uint256[]) private _byGrantor;
    mapping(address => uint256[]) private _byAuditor;
    /// @dev One live grant per (grantor, auditor, epoch): regranting the same scope should
    ///      replace, not accumulate, or the list becomes impossible to reason about.
    mapping(bytes32 => uint256) private _liveGrant;

    mapping(uint256 => uint64) public accessCount;

    address public governance;

    error NotGovernance();
    error NotGrantor();
    error NotTheAuditor();
    error UnknownAuditor(address auditor);
    error AuditorInactive(address auditor);
    error AuditorAlreadyRegistered(address auditor);
    error EmptyKey();
    error AlreadyRevoked(uint256 grantId);
    error NoSuchGrant(uint256 grantId);
    error GrantRevoked(uint256 grantId);

    event AuditorRegistered(address indexed auditor, bytes32 encryptionKey, string name);
    event AuditorDeactivated(address indexed auditor);
    event DisclosureGranted(
        uint256 indexed grantId, address indexed grantor, address indexed auditor, uint64 epoch
    );
    event DisclosureRevoked(uint256 indexed grantId, address indexed grantor, uint64 revokedAt);
    event DisclosureAccessed(uint256 indexed grantId, address indexed auditor, uint64 at);
    event GovernanceTransferred(address indexed previous, address indexed current);

    constructor(address governance_) {
        governance = governance_;
    }

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    // -------------------------------------------------------------------------------------
    // auditors
    // -------------------------------------------------------------------------------------

    /// @notice Publish an auditor's encryption key so traders can seal viewing keys to it.
    /// @dev Governance-gated because the key is what a grant is sealed to: anyone able to
    ///      register an auditor could publish their own key under a trusted name and receive
    ///      disclosures meant for someone else. The name is a label, not an identity claim.
    function registerAuditor(address auditor, bytes32 encryptionKey, string calldata name)
        external
        onlyGovernance
    {
        if (auditor == address(0)) revert UnknownAuditor(auditor);
        if (encryptionKey == bytes32(0)) revert EmptyKey();
        if (auditors[auditor].registeredAt != 0) revert AuditorAlreadyRegistered(auditor);

        auditors[auditor] = Auditor({
            encryptionKey: encryptionKey,
            name: name,
            active: true,
            registeredAt: uint64(block.timestamp)
        });
        _auditorList.push(auditor);
        emit AuditorRegistered(auditor, encryptionKey, name);
    }

    /// @notice Stop new grants to an auditor. Existing ones keep working.
    /// @dev Deliberately does not touch live grants. Deactivating cannot un-disclose what has
    ///      already been sealed to them, and quietly marking their grants revoked would tell
    ///      traders their data was withdrawn when it was not.
    function deactivateAuditor(address auditor) external onlyGovernance {
        if (auditors[auditor].registeredAt == 0) revert UnknownAuditor(auditor);
        auditors[auditor].active = false;
        emit AuditorDeactivated(auditor);
    }

    function transferGovernance(address next) external onlyGovernance {
        emit GovernanceTransferred(governance, next);
        governance = next;
    }

    // -------------------------------------------------------------------------------------
    // grants
    // -------------------------------------------------------------------------------------

    /// @notice Disclose one epoch of your own activity to an auditor.
    /// @param sealedKey `ivk_epoch` encrypted to the auditor's published key, sealed off-chain.
    /// @dev The caller is always the grantor. There is no "grant on behalf of": disclosure that
    ///      someone else can initiate for you is not disclosure, it is surveillance with extra
    ///      steps.
    function grant(address auditor, uint64 epoch, bytes calldata sealedKey)
        external
        returns (uint256 grantId)
    {
        Auditor memory a = auditors[auditor];
        if (a.registeredAt == 0) revert UnknownAuditor(auditor);
        if (!a.active) revert AuditorInactive(auditor);
        if (sealedKey.length == 0) revert EmptyKey();

        bytes32 scope = keccak256(abi.encode(msg.sender, auditor, epoch));
        uint256 existing = _liveGrant[scope];
        // Replace rather than accumulate. A re-grant of the same scope is a new sealed key, not a
        // second disclosure, and leaving both live would double-count in every UI that reads this.
        if (existing != 0 && _grants[existing - 1].revokedAt == 0) {
            _grants[existing - 1].revokedAt = uint64(block.timestamp);
            emit DisclosureRevoked(existing - 1, msg.sender, uint64(block.timestamp));
        }

        _grants.push(
            Grant({
                grantor: msg.sender,
                auditor: auditor,
                epoch: epoch,
                grantedAt: uint64(block.timestamp),
                revokedAt: 0,
                sealedKey: sealedKey
            })
        );
        grantId = _grants.length - 1;
        // Stored one-based so zero can mean "none", which `_grants` cannot express.
        _liveGrant[scope] = grantId + 1;
        _byGrantor[msg.sender].push(grantId);
        _byAuditor[auditor].push(grantId);

        emit DisclosureGranted(grantId, msg.sender, auditor, epoch);
    }

    /// @notice Withdraw a grant's standing. Does **not** revoke the auditor's knowledge.
    /// @dev See the contract notes. The auditor still holds `ivk_epoch` and can still decrypt
    ///      that epoch. What changes is that the grant no longer reads as current, and
    ///      `logAccess` refuses it — which is a record-keeping effect, not a security one.
    function revoke(uint256 grantId) external {
        if (grantId >= _grants.length) revert NoSuchGrant(grantId);
        Grant storage g = _grants[grantId];
        if (g.grantor != msg.sender) revert NotGrantor();
        if (g.revokedAt != 0) revert AlreadyRevoked(grantId);

        g.revokedAt = uint64(block.timestamp);
        emit DisclosureRevoked(grantId, msg.sender, uint64(block.timestamp));
    }

    /// @notice An auditor's own attestation that they used a grant.
    /// @dev Voluntary and unverifiable — decryption happens on their machine. Useful as a trail,
    ///      worthless as proof that nobody looked.
    function logAccess(uint256 grantId) external {
        if (grantId >= _grants.length) revert NoSuchGrant(grantId);
        Grant memory g = _grants[grantId];
        if (g.auditor != msg.sender) revert NotTheAuditor();
        if (g.revokedAt != 0) revert GrantRevoked(grantId);

        accessCount[grantId] += 1;
        emit DisclosureAccessed(grantId, msg.sender, uint64(block.timestamp));
    }

    // -------------------------------------------------------------------------------------
    // views
    // -------------------------------------------------------------------------------------

    function grantCount() external view returns (uint256) {
        return _grants.length;
    }

    function grantAt(uint256 grantId) external view returns (Grant memory) {
        if (grantId >= _grants.length) revert NoSuchGrant(grantId);
        return _grants[grantId];
    }

    function grantsByGrantor(address grantor) external view returns (uint256[] memory) {
        return _byGrantor[grantor];
    }

    function grantsByAuditor(address auditor) external view returns (uint256[] memory) {
        return _byAuditor[auditor];
    }

    function auditorList() external view returns (address[] memory) {
        return _auditorList;
    }

    /// @notice Whether a grant is currently standing — not whether the auditor can decrypt.
    function isLive(uint256 grantId) external view returns (bool) {
        return grantId < _grants.length && _grants[grantId].revokedAt == 0;
    }
}
