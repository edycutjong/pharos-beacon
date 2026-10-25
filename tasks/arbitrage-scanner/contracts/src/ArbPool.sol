// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// TEST CONTRACT OWNED BY THIS REPO, deployed on Pharos Atlantic testnet only, because Atlantic has no DEX: the scanner's
// executed trade needs two venues whose prices differ, so we run two of these with different rates. They move the real
// Atlantic test USDC and WPHRS. Not audited, not for real funds.

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Fixed-rate two-token pool with a swap fee. 1 unit of `tokenA` is worth `rateNum / rateDen` units of `tokenB`
/// before the fee; the fee (in bps) is kept out of the amount paid out. The owner can move the rate (the demo's "market
/// moves") and take its liquidity back.
contract ArbPool {
    address public immutable owner;
    address public immutable tokenA;
    address public immutable tokenB;
    uint256 public immutable feeBps;
    uint256 public rateNum;
    uint256 public rateDen;

    event Swap(address indexed user, address tokenIn, uint256 amountIn, address tokenOut, uint256 amountOut);
    event RateSet(uint256 rateNum, uint256 rateDen);

    error UnknownToken();
    error NotOwner();
    error TooLittleOut(uint256 out, uint256 minOut);
    error TransferFailed();

    constructor(address a, address b, uint256 num, uint256 den, uint256 fee) {
        owner = msg.sender;
        tokenA = a;
        tokenB = b;
        rateNum = num;
        rateDen = den;
        feeBps = fee;
    }

    /// @notice What `amountIn` of `tokenIn` pays out, after the fee.
    function quote(address tokenIn, uint256 amountIn) public view returns (uint256) {
        uint256 gross;
        if (tokenIn == tokenA) gross = (amountIn * rateNum) / rateDen;
        else if (tokenIn == tokenB) gross = (amountIn * rateDen) / rateNum;
        else revert UnknownToken();
        return (gross * (10_000 - feeBps)) / 10_000;
    }

    function swap(address tokenIn, uint256 amountIn, uint256 minOut) external returns (uint256 amountOut) {
        amountOut = quote(tokenIn, amountIn);
        if (amountOut < minOut) revert TooLittleOut(amountOut, minOut);
        address tokenOut = tokenIn == tokenA ? tokenB : tokenA;
        _pull(tokenIn, msg.sender, amountIn);
        _push(tokenOut, msg.sender, amountOut);
        emit Swap(msg.sender, tokenIn, amountIn, tokenOut, amountOut);
    }

    function setRate(uint256 num, uint256 den) external {
        if (msg.sender != owner) revert NotOwner();
        rateNum = num;
        rateDen = den;
        emit RateSet(num, den);
    }

    function sweep(address token, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _push(token, owner, amount);
    }

    function _pull(address token, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, address(this), amount));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (ret.length > 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
