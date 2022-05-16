// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.10;

import { IAToken } from "@aave/core-v3/contracts/interfaces/IAToken.sol";
import { IPool } from "@aave/core-v3/contracts/interfaces/IPool.sol";
import { IPoolAddressesProvider } from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import { IPoolAddressesProviderRegistry } from "@aave/core-v3/contracts/interfaces/IPoolAddressesProviderRegistry.sol";
import { IRewardsController } from "@aave/periphery-v3/contracts/rewards/interfaces/IRewardsController.sol";

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { Manageable, Ownable } from "@pooltogether/owner-manager-contracts/contracts/Manageable.sol";
import { IYieldSource } from "@pooltogether/yield-source-interface/contracts/IYieldSource.sol";

/**
 * @title Aave V3 Yield Source contract, implementing PoolTogether's generic yield source interface.
 * @dev This contract inherits from the ERC20 implementation to keep track of users deposits.
 * @notice Yield Source for a PoolTogether prize pool that generates yield by depositing into Aave V3.
 */
contract AaveV3YieldSource is ERC20, IYieldSource, Manageable, ReentrancyGuard {
  using SafeERC20 for IERC20;

  /* ============ Events ============ */

  /**
   * @notice Emitted when the yield source is initialized.
   * @param aToken Aave aToken address
   * @param rewardsController Aave rewardsController address
   * @param poolAddressesProviderRegistry Aave poolAddressesProviderRegistry address
   * @param name Token name for the underlying ERC20 shares
   * @param symbol Token symbol for the underlying ERC20 shares
   * @param decimals Number of decimals the shares (inherited ERC20) will have. Same as underlying asset to ensure sane exchange rates for shares.
   * @param owner Owner of this contract
   */
  event AaveV3YieldSourceInitialized(
    IAToken indexed aToken,
    IRewardsController rewardsController,
    IPoolAddressesProviderRegistry poolAddressesProviderRegistry,
    string name,
    string symbol,
    uint8 decimals,
    address indexed owner
  );

  /**
   * @notice Emitted when asset tokens are supplied to the yield source.
   * @param from Address that supplied the tokens
   * @param shares Amount of shares minted to the user
   * @param amount Amount of tokens supplied
   * @param to Address that received the shares
   */
  event SuppliedTokenTo(address indexed from, uint256 shares, uint256 amount, address indexed to);

  /**
   * @notice Emitted when asset tokens are redeemed from the yield source.
   * @param from Address who redeemed the tokens
   * @param shares Amount of shares burnt
   * @param amount Amount of tokens redeemed
   */
  event RedeemedToken(address indexed from, uint256 shares, uint256 amount);

  /**
   * @notice Emitted when Aave rewards have been claimed.
   * @param from Address who claimed the rewards
   * @param to Address that received the rewards
   * @param rewardsList List of addresses of the reward tokens
   * @param claimedAmounts List that contains the claimed amount per reward token
   */
  event Claimed(
    address indexed from,
    address indexed to,
    address[] rewardsList,
    uint256[] claimedAmounts
  );

  /**
   * @notice Emitted when decreasing allowance of ERC20 tokens other than yield source's aToken.
   * @param from Address of the caller
   * @param spender Address of the spender
   * @param amount Amount of `token` to decrease allowance by
   * @param token Address of the ERC20 token to decrease allowance for
   */
  event DecreasedERC20Allowance(
    address indexed from,
    address indexed spender,
    uint256 amount,
    IERC20 indexed token
  );

  /**
   * @notice Emitted when increasing allowance of ERC20 tokens other than yield source's aToken.
   * @param from Address of the caller
   * @param spender Address of the spender
   * @param amount Amount of `token` to increase allowance by
   * @param token Address of the ERC20 token to increase allowance for
   */
  event IncreasedERC20Allowance(
    address indexed from,
    address indexed spender,
    uint256 amount,
    IERC20 indexed token
  );

  /**
   * @notice Emitted when ERC20 tokens other than yield source's aToken are withdrawn from the yield source.
   * @param from Address of the caller
   * @param to Address of the recipient
   * @param amount Amount of `token` transferred
   * @param token Address of the ERC20 token transferred
   */
  event TransferredERC20(
    address indexed from,
    address indexed to,
    uint256 amount,
    IERC20 indexed token
  );

  /* ============ Variables ============ */

  /// @notice Yield-bearing Aave aToken address.
  IAToken public immutable aToken;

  /// @notice Aave RewardsController address.
  IRewardsController public immutable rewardsController;

  /// @notice Aave poolAddressesProviderRegistry address.
  IPoolAddressesProviderRegistry public immutable poolAddressesProviderRegistry;

  /// @notice Underlying asset token address.
  address private immutable _tokenAddress;

  /// @notice Underlying asset unit.
  uint256 private immutable _tokenUnit;

  /// @notice ERC20 token decimals.
  uint8 private immutable _decimals;

  /**
   * @dev Aave genesis market PoolAddressesProvider's ID.
   * @dev This variable could evolve in the future if we decide to support other markets.
   */
  uint256 private constant ADDRESSES_PROVIDER_ID = uint256(0);

  /// @dev PoolTogether's Aave Referral Code
  uint16 private constant REFERRAL_CODE = uint16(188);

  /* ============ Constructor ============ */

  /**
   * @notice Initializes the yield source with Aave aToken.
   * @param _aToken Aave aToken address
   * @param _rewardsController Aave rewardsController address
   * @param _poolAddressesProviderRegistry Aave poolAddressesProviderRegistry address
   * @param _name Token name for the underlying ERC20 shares
   * @param _symbol Token symbol for the underlying ERC20 shares
   * @param decimals_ Number of decimals the shares (inherited ERC20) will have. Same as underlying asset to ensure sane exchange rates for shares.
   * @param _owner Owner of this contract
   */
  constructor(
    IAToken _aToken,
    IRewardsController _rewardsController,
    IPoolAddressesProviderRegistry _poolAddressesProviderRegistry,
    string memory _name,
    string memory _symbol,
    uint8 decimals_,
    address _owner
  ) Ownable(_owner) ERC20(_name, _symbol) ReentrancyGuard() {
    require(_owner != address(0), "AaveV3YS/owner-not-zero-address");
    require(address(_aToken) != address(0), "AaveV3YS/aToken-not-zero-address");
    require(decimals_ > 0, "AaveV3YS/decimals-gt-zero");
    require(address(_rewardsController) != address(0), "AaveV3YS/RC-not-zero-address");
    require(address(_poolAddressesProviderRegistry) != address(0), "AaveV3YS/PR-not-zero-address");

    aToken = _aToken;
    _decimals = decimals_;
    _tokenUnit = 10**decimals_;
    _tokenAddress = address(_aToken.UNDERLYING_ASSET_ADDRESS());
    rewardsController = _rewardsController;
    poolAddressesProviderRegistry = _poolAddressesProviderRegistry;

    // Approve once for max amount
    IERC20(_tokenAddress).safeApprove(address(_pool()), type(uint256).max);

    emit AaveV3YieldSourceInitialized(
      _aToken,
      _rewardsController,
      _poolAddressesProviderRegistry,
      _name,
      _symbol,
      decimals_,
      _owner
    );
  }

  /* ============ External Functions ============ */

  /**
   * @notice Returns user total balance (in asset tokens). This includes their deposit and interest.
   * @param _user Address of the user to get balance of token for
   * @return The underlying balance of asset tokens.
   */
  function balanceOfToken(address _user) external view override returns (uint256) {
    return _sharesToToken(balanceOf(_user));
  }

  /**
   * @notice Returns the ERC20 asset token used for deposits.
   * @return The ERC20 asset token address.
   */
  function depositToken() public view override returns (address) {
    return _tokenAddress;
  }

  /**
   * @notice Returns the Yield Source ERC20 token decimals.
   * @dev This value should be equal to the decimals of the token used to deposit into the pool.
   * @return The number of decimals.
   */
  function decimals() public view virtual override returns (uint8) {
    return _decimals;
  }

  /**
   * @notice Supplies asset tokens to the yield source.
   * @dev Shares corresponding to the number of tokens supplied are minted to the user's balance.
   * @dev Asset tokens are supplied to the yield source, then deposited into Aave.
   * @param _depositAmount The amount of asset tokens to be supplied
   * @param _to The user whose balance will receive the tokens
   */
  function supplyTokenTo(uint256 _depositAmount, address _to) external override nonReentrant {
    uint256 _shares = _tokenToShares(_depositAmount);
    _requireSharesGTZero(_shares);

    uint256 _tokenAmount = _sharesToToken(_shares);
    IERC20(_tokenAddress).safeTransferFrom(msg.sender, address(this), _tokenAmount);
    _pool().supply(_tokenAddress, _tokenAmount, address(this), REFERRAL_CODE);

    _mint(_to, _shares);

    emit SuppliedTokenTo(msg.sender, _shares, _tokenAmount, _to);
  }

  /**
   * @notice Redeems asset tokens from the yield source.
   * @dev Shares corresponding to the number of tokens withdrawn are burnt from the user's balance.
   * @dev Asset tokens are withdrawn from Aave, then transferred from the yield source to the user's wallet.
   * @param _redeemAmount The amount of asset tokens to be redeemed
   * @return The actual amount of asset tokens that were redeemed.
   */
  function redeemToken(uint256 _redeemAmount) external override nonReentrant returns (uint256) {
    uint256 _shares = _tokenToShares(_redeemAmount);
    _requireSharesGTZero(_shares);

    _burn(msg.sender, _shares);

    IERC20 _assetToken = IERC20(_tokenAddress);
    uint256 _beforeBalance = _assetToken.balanceOf(address(this));
    _pool().withdraw(_tokenAddress, _redeemAmount, address(this));

    uint256 _balanceDiff;

    unchecked {
      _balanceDiff = _assetToken.balanceOf(address(this)) - _beforeBalance;
    }

    _assetToken.safeTransfer(msg.sender, _balanceDiff);

    emit RedeemedToken(msg.sender, _shares, _redeemAmount);
    return _balanceDiff;
  }

  /**
   * @notice Claims the accrued rewards for the aToken, accumulating any pending rewards.
   * @dev Only callable by the owner or manager.
   * @param _to Address where the claimed rewards will be sent
   */
  function claimRewards(address _to) external onlyManagerOrOwner {
    require(_to != address(0), "AaveV3YS/payee-not-zero-address");

    address[] memory _assets = new address[](1);
    _assets[0] = address(aToken);

    (address[] memory _rewardsList, uint256[] memory _claimedAmounts) = rewardsController
      .claimAllRewards(_assets, _to);

    emit Claimed(msg.sender, _to, _rewardsList, _claimedAmounts);
  }

  /**
   * @notice Decrease allowance of ERC20 tokens other than the aTokens held by this contract.
   * @dev This function is only callable by the owner or asset manager.
   * @dev Current allowance should be computed off-chain to avoid any underflow.
   * @param _token Address of the ERC20 token to decrease allowance for
   * @param _spender Address of the spender of the tokens
   * @param _amount Amount of tokens to decrease allowance by
   */
  function decreaseERC20Allowance(
    IERC20 _token,
    address _spender,
    uint256 _amount
  ) external onlyManagerOrOwner {
    _requireNotATokenAllowance(address(_token));
    _token.safeDecreaseAllowance(_spender, _amount);
    emit DecreasedERC20Allowance(msg.sender, _spender, _amount, _token);
  }

  /**
   * @notice Increase allowance of ERC20 tokens other than the aTokens held by this contract.
   * @dev This function is only callable by the owner or asset manager.
   * @dev Allows another contract or address to withdraw funds from the yield source.
   * @dev Current allowance should be computed off-chain to avoid any overflow.
   * @param _token Address of the ERC20 token to increase allowance for
   * @param _spender Address of the spender of the tokens
   * @param _amount Amount of tokens to increase allowance by
   */
  function increaseERC20Allowance(
    IERC20 _token,
    address _spender,
    uint256 _amount
  ) external onlyManagerOrOwner {
    _requireNotATokenAllowance(address(_token));
    _token.safeIncreaseAllowance(_spender, _amount);
    emit IncreasedERC20Allowance(msg.sender, _spender, _amount, _token);
  }

  /**
   * @notice Transfer ERC20 tokens other than the aTokens held by this contract to the recipient address.
   * @dev This function is only callable by the owner or asset manager.
   * @param _token Address of the ERC20 token to transfer
   * @param _to Address of the recipient of the tokens
   * @param _amount Amount of tokens to transfer
   */
  function transferERC20(
    IERC20 _token,
    address _to,
    uint256 _amount
  ) external onlyManagerOrOwner {
    _requireNotAToken(address(_token), "AaveV3YS/forbid-aToken-transfer");
    _token.safeTransfer(_to, _amount);
    emit TransferredERC20(msg.sender, _to, _amount, _token);
  }

  /* ============ Internal Functions ============ */

  /**
   * @notice Checks that the amount of shares is greater than zero.
   * @param _shares Amount of shares to check
   */
  function _requireSharesGTZero(uint256 _shares) internal pure {
    require(_shares > 0, "AaveV3YS/shares-gt-zero");
  }

  /**
   * @notice Checks that the token address passed is not the aToken address.
   * @param _token Address of the ERC20 token to check
   * @param _errorMessage Error message to be thrown if the token is the aToken
   */
  function _requireNotAToken(address _token, string memory _errorMessage) internal view {
    require(_token != address(aToken), _errorMessage);
  }

  /**
   * @notice Checks that the token address passed for allowance is not the aToken address.
   * @param _token Address of the ERC20 token to check
   */
  function _requireNotATokenAllowance(address _token) internal view {
    _requireNotAToken(_token, "AaveV3YS/forbid-aToken-allowance");
  }

  /**
   * @notice Calculates the price of a full share.
   * @dev We use this calculation to ensure that the price per share can't be manipulated.
   * @return The current price per share
   */
  function _pricePerShare() internal view returns (uint256) {
    uint256 _supply = totalSupply();

    // pricePerShare = (token * yieldSourceBalanceOfAToken) / totalSupply
    return _supply == 0 ? _tokenUnit : (_tokenUnit * aToken.balanceOf(address(this))) / _supply;
  }

  /**
   * @notice Calculates the number of shares that should be minted or burnt when a user deposit or withdraw.
   * @param _tokens Amount of asset tokens
   * @return Number of shares.
   */
  function _tokenToShares(uint256 _tokens) internal view returns (uint256) {
    // shares = (tokens * totalSupply) / yieldSourceBalanceOfAToken
    return _tokens == 0 ? _tokens : (_tokens * _tokenUnit) / _pricePerShare();
  }

  /**
   * @notice Calculates the number of asset tokens a user has in the yield source.
   * @param _shares Amount of shares
   * @return Number of asset tokens.
   */
  function _sharesToToken(uint256 _shares) internal view returns (uint256) {
    // tokens = (shares * yieldSourceBalanceOfAToken) / totalSupply
    return _shares == 0 ? _shares : (_shares * _pricePerShare()) / _tokenUnit;
  }

  /**
   * @notice Retrieves Aave Pool address.
   * @return A reference to Pool interface.
   */
  function _pool() internal view returns (IPool) {
    return
      IPool(
        IPoolAddressesProvider(
          poolAddressesProviderRegistry.getAddressesProvidersList()[ADDRESSES_PROVIDER_ID]
        ).getPool()
      );
  }
}
