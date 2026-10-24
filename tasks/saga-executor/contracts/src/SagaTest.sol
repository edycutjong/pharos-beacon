// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// TEST CONTRACTS OWNED BY THIS REPO, deployed on Pharos Atlantic testnet only, because Atlantic has no DEX or vault to
// run a swap and a deposit against. They move the real Atlantic test USDC and WPHRS. Not audited, not for real funds.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Fixed-rate two-token pool, no fee: 1 unit of `tokenA` pays `rateNum / rateDen` units of `tokenB`. The fixed rate
/// makes a swap exactly reversible (the saga's rollback swaps back and must land on the same balance).
contract SagaPool {
    address public immutable owner;
    address public immutable tokenA;
    address public immutable tokenB;
    uint256 public immutable rateNum;
    uint256 public immutable rateDen;

    event Swap(address indexed user, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut);

    error UnknownToken();
    error NotEnoughLiquidity(uint256 wanted, uint256 have);
    error TransferFailed();

    constructor(address a, address b, uint256 num, uint256 den) {
        owner = msg.sender;
        tokenA = a;
        tokenB = b;
        rateNum = num;
        rateDen = den;
    }

    function quote(address tokenIn, uint256 amountIn) public view returns (uint256) {
        if (tokenIn == tokenA) return (amountIn * rateNum) / rateDen;
        if (tokenIn == tokenB) return (amountIn * rateDen) / rateNum;
        revert UnknownToken();
    }

    function swap(address tokenIn, uint256 amountIn) external returns (uint256 amountOut) {
        amountOut = quote(tokenIn, amountIn);
        address tokenOut = tokenIn == tokenA ? tokenB : tokenA;
        (bool ok, bytes memory ret) = tokenIn.call(abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, address(this), amountIn));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        (ok, ret) = tokenOut.call(abi.encodeWithSelector(IERC20.transfer.selector, msg.sender, amountOut));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        emit Swap(msg.sender, tokenIn, amountIn, tokenOut, amountOut);
    }
}

/// @notice Vault that takes `asset` 1:1 for shares. The owner can close it or cap it, which is how the demo forces the
/// deposit step to fail for real (the contract refuses, nobody fakes an error in the client).
contract SagaVault {
    address public immutable owner;
    address public immutable asset;
    bool public open = true;
    uint256 public cap = type(uint256).max;
    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    event Deposit(address indexed user, uint256 assets);
    event Withdraw(address indexed user, uint256 assets);
    event Status(bool open, uint256 cap);

    error VaultClosed();
    error CapExceeded(uint256 cap, uint256 wouldBe);
    error NotOwner();
    error TransferFailed();
    error NotEnoughShares();

    constructor(address asset_) {
        owner = msg.sender;
        asset = asset_;
    }

    function setStatus(bool open_, uint256 cap_) external {
        if (msg.sender != owner) revert NotOwner();
        open = open_;
        cap = cap_;
        emit Status(open_, cap_);
    }

    function deposit(uint256 assets) external {
        if (!open) revert VaultClosed();
        if (totalShares + assets > cap) revert CapExceeded(cap, totalShares + assets);
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, address(this), assets));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        sharesOf[msg.sender] += assets;
        totalShares += assets;
        emit Deposit(msg.sender, assets);
    }

    function withdraw(uint256 assets) external {
        if (sharesOf[msg.sender] < assets) revert NotEnoughShares();
        sharesOf[msg.sender] -= assets;
        totalShares -= assets;
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(IERC20.transfer.selector, msg.sender, assets));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        emit Withdraw(msg.sender, assets);
    }
}
