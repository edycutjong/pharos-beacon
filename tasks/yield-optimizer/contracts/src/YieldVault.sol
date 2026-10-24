// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// TEST CONTRACT OWNED BY THIS REPO, deployed on Pharos Atlantic testnet only. Atlantic has no yield vault, so the Yield Optimizer's
// testnet move runs between instances of this one. It is an ERC-4626-shaped vault whose share price grows at a rate the owner sets
// (the owner funds the reserve that pays the yield). Not audited, not for real funds.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract YieldVault {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;

    address public immutable owner;
    address public immutable asset;
    string public name;
    uint8 public constant decimals = 18; // shares have 18 decimals, like the RockawayX vault on mainnet

    /// @notice Share price (assets per 1e18 shares, in asset units) was `priceBase` at `priceTime`; it grows linearly at `rateBps` per year.
    uint256 public priceBase; // in asset units per WAD shares, scaled by 1e12 extra precision
    uint256 public priceTime;
    uint256 public rateBps;
    uint256 public entryFeeBps;
    uint256 public exitFeeBps;
    uint256 public lockSeconds;
    uint256 public cap; // max total assets the vault accepts

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public depositedAt;

    event Deposit(address indexed user, uint256 assets, uint256 fee, uint256 shares);
    event Redeem(address indexed user, uint256 shares, uint256 assets, uint256 fee);
    event RateChanged(uint256 rateBps, uint256 priceAtChange);

    error NotOwner();
    error StillLocked(uint256 until);
    error CapExceeded(uint256 cap, uint256 wouldBe);
    error NotEnoughShares();
    error TransferFailed();

    constructor(address asset_, string memory name_, uint256 rateBps_, uint256 entryFeeBps_, uint256 exitFeeBps_, uint256 lockSeconds_, uint256 cap_) {
        owner = msg.sender;
        asset = asset_;
        name = name_;
        rateBps = rateBps_;
        entryFeeBps = entryFeeBps_;
        exitFeeBps = exitFeeBps_;
        lockSeconds = lockSeconds_;
        cap = cap_;
        priceBase = 1e6 * 1e12; // 1.000000 asset (6 decimals) per share at deploy, with 1e12 extra precision
        priceTime = block.timestamp;
    }

    /// @dev assets (asset units, 6 decimals) per 1e18 shares, times 1e12.
    function precisePrice() public view returns (uint256) {
        return priceBase + (priceBase * rateBps * (block.timestamp - priceTime)) / (10_000 * YEAR);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return (shares * precisePrice()) / (WAD * 1e12);
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return (assets * WAD * 1e12) / precisePrice();
    }

    function totalAssets() public view returns (uint256) {
        return convertToAssets(totalSupply);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return convertToShares(assets - (assets * entryFeeBps) / 10_000);
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        uint256 gross = convertToAssets(shares);
        return gross - (gross * exitFeeBps) / 10_000;
    }

    function maxDeposit(address) public view returns (uint256) {
        uint256 have = totalAssets();
        return have >= cap ? 0 : cap - have;
    }

    function maxRedeem(address user) public view returns (uint256) {
        return block.timestamp < depositedAt[user] + lockSeconds ? 0 : balanceOf[user];
    }

    function lockedUntil(address user) public view returns (uint256) {
        return depositedAt[user] + lockSeconds;
    }

    /// @notice Owner changes the yearly rate; the price earned so far is kept (no jump).
    function setRate(uint256 newRateBps) external {
        if (msg.sender != owner) revert NotOwner();
        priceBase = precisePrice();
        priceTime = block.timestamp;
        rateBps = newRateBps;
        emit RateChanged(newRateBps, priceBase);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        uint256 fee = (assets * entryFeeBps) / 10_000;
        shares = convertToShares(assets - fee);
        if (totalAssets() + assets - fee > cap) revert CapExceeded(cap, totalAssets() + assets - fee);
        _pull(msg.sender, assets);
        totalSupply += shares;
        balanceOf[receiver] += shares;
        depositedAt[receiver] = block.timestamp;
        emit Deposit(receiver, assets, fee, shares);
    }

    function redeem(uint256 shares, address receiver, address from) external returns (uint256 assets) {
        if (msg.sender != from) revert NotOwner(); // no allowances in this test vault
        if (block.timestamp < depositedAt[from] + lockSeconds) revert StillLocked(depositedAt[from] + lockSeconds);
        if (balanceOf[from] < shares) revert NotEnoughShares();
        uint256 gross = convertToAssets(shares);
        uint256 fee = (gross * exitFeeBps) / 10_000;
        assets = gross - fee;
        balanceOf[from] -= shares;
        totalSupply -= shares;
        _push(receiver, assets);
        emit Redeem(from, shares, assets, fee);
    }

    /// @notice Owner tops up the reserve that pays the yield (anyone could; the owner is the one who does).
    function fund(uint256 assets) external {
        _pull(msg.sender, assets);
    }

    function _pull(address from, uint256 amount) internal {
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
