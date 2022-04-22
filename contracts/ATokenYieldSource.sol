// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.10;

import { IAToken } from "@aave/core-v3/contracts/interfaces/IAToken.sol";
import { IPool } from "@aave/core-v3/contracts/interfaces/IPool.sol";
import { IPoolAddressesProvider } from "@aave/core-v3/contracts/interfaces/IPoolAddressesProvider.sol";
import { IPoolAddressesProviderRegistry } from "@aave/core-v3/contracts/interfaces/IPoolAddressesProviderRegistry.sol";
import { IRewardsController } from "@aave/periphery-v3/contracts/rewards/interfaces/IRewardsController.sol";
import { WadRayMath } from "@aave/core-v3/contracts/protocol/libraries/math/WadRayMath.sol";

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/draft-IERC20Permit.sol";
import { SafeMath } from "@openzeppelin/contracts/utils/math/SafeMath.sol";

import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { Manageable, Ownable } from "@pooltogether/owner-manager-contracts/contracts/Manageable.sol";
import { IYieldSource } from "@pooltogether/yield-source-interface/contracts/IYieldSource.sol";

/**
 * @title Aave V3 Yield Source contract, implementing PoolTogether's generic yield source interface.
 * @dev This contract inherits from the ERC20 implementation to keep track of users deposits.
 * @notice Yield Source for a PoolTogether prize pool that generates yield by depositing into Aave V3.
 */
contract ATokenYieldSource is ERC20, IYieldSource, Manageable, ReentrancyGuard {
  using SafeMath for uint256;
  using SafeERC20 for IERC20;
  using WadRayMath for uint256;

  /* ============ Events ============ */

  /**
   * @notice Emitted when the yield source is initialized
   * @param aToken Aave aToken address
   * @param rewardsController Aave rewardsController address
   * @param poolAddressesProviderRegistry Aave poolAddressesProviderRegistry address
   * @param name Token name for the underlying ERC20 shares
   * @param symbol Token symbol for the underlying ERC20 shares
   * @param decimals Number of decimals the shares (inhereted ERC20) will have. Same as underlying asset to ensure sane ExchangeRates.
   * @param owner Owner of this contract
   */
  event ATokenYieldSourceInitialized(
    IAToken indexed aToken,
    IRewardsController rewardsController,
    IPoolAddressesProviderRegistry poolAddressesProviderRegistry,
    string name,
    string symbol,
    uint8 decimals,
    address owner
  );

  /**
   * @notice Emitted when Aave rewards have been claimed
   * @param from Address who claimed the rewards
   * @param to Address that received the rewards
   * @param amount Amount of rewards claimed
   */
  event Claimed(address indexed from, address indexed to, uint256 amount);

  /**
   * @notice Emitted when asset tokens are redeemed from the yield source
   * @param from Address who redeemed the tokens
   * @param shares Amount of shares burnt
   * @param amount Amount of tokens redeemed
   */
  event RedeemedToken(address indexed from, uint256 shares, uint256 amount);

  /**
   * @notice Emitted when asset tokens are supplied to sponsor the yield source
   * @param from Address that supplied the tokens
   * @param amount Amount of tokens supplied
   */
  event Sponsored(address indexed from, uint256 amount);

  /**
   * @notice Emitted when asset tokens are supplied to the yield source.
   * @param from Address that supplied the tokens
   * @param shares Amount of shares minted to the user
   * @param amount Amount of tokens supplied
   * @param to Address that received the shares
   */
  event SuppliedTokenTo(address indexed from, uint256 shares, uint256 amount, address indexed to);

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

  /* ============ Structs ============ */

  /**
   * @notice Secp256k1 signature values.
   * @param deadline Timestamp at which the signature expires
   * @param v `v` portion of the signature
   * @param r `r` portion of the signature
   * @param s `s` portion of the signature
   */
  struct Signature {
    uint256 deadline;
    uint8 v;
    bytes32 r;
    bytes32 s;
  }

  /* ============ Variables ============ */

  /// @notice Yield-bearing Aave aToken address.
  IAToken public aToken;

  /// @notice Aave RewardsController address.
  IRewardsController public rewardsController;

  /// @notice Aave poolAddressesProviderRegistry address.
  IPoolAddressesProviderRegistry public poolAddressesProviderRegistry;

  /// @notice ERC20 token decimals.
  uint8 private immutable _decimals;

  /**
   * @dev Aave genesis market PoolAddressesProvider's ID
   * @dev This variable could evolve in the future if we decide to support other markets
   */
  uint256 private constant ADDRESSES_PROVIDER_ID = uint256(0);

  /// @dev PoolTogether's Aave Referral Code
  uint16 private constant REFERRAL_CODE = uint16(188);

  /* ============ Constructor ============ */

  /**
   * @notice Initializes the yield source with Aave aToken
   * @param _aToken Aave aToken address
   * @param _rewardsController Aave rewardsController address
   * @param _poolAddressesProviderRegistry Aave poolAddressesProviderRegistry address
   * @param _name Token name for the underlying ERC20 shares
   * @param _symbol Token symbol for the underlying ERC20 shares
   * @param decimals_ Number of decimals the shares (inhereted ERC20) will have. Same as underlying asset to ensure sane ExchangeRates.
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
    require(address(_aToken) != address(0), "ATokenYS/aToken-not-zero-address");
    aToken = _aToken;

    require(
      address(_rewardsController) != address(0),
      "ATokenYS/rewardsController-not-zero-address"
    );

    rewardsController = _rewardsController;

    require(
      address(_poolAddressesProviderRegistry) != address(0),
      "ATokenYS/poolRegistry-not-zero-address"
    );

    poolAddressesProviderRegistry = _poolAddressesProviderRegistry;

    require(_owner != address(0), "ATokenYS/owner-not-zero-address");

    require(decimals_ > 0, "ATokenYS/decimals-gt-zero");
    _decimals = decimals_;

    // Approve once for max amount
    IERC20(_tokenAddress()).safeApprove(address(_pool()), type(uint256).max);

    emit ATokenYieldSourceInitialized(
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
   * @notice Approve Aave pool contract to spend max uint256 amount.
   * @dev Emergency function to re-approve max amount if approval amount dropped too low.
   * @return true if operation is successful
   */
  function approveMaxAmount() external onlyOwner returns (bool) {
    address _poolAddress = address(_pool());
    IERC20 _underlyingAsset = IERC20(_tokenAddress());
    uint256 _allowance = _underlyingAsset.allowance(address(this), _poolAddress);

    _underlyingAsset.safeIncreaseAllowance(_poolAddress, type(uint256).max.sub(_allowance));
    return true;
  }

  /**
   * @notice Returns user total balance (in asset tokens). This includes their deposit and interest.
   * @param addr User address
   * @return The underlying balance of asset tokens.
   */
  function balanceOfToken(address addr) external override returns (uint256) {
    return _sharesToToken(balanceOf(addr));
  }

  /**
   * @notice Returns the ERC20 asset token used for deposits.
   * @return The ERC20 asset token address.
   */
  function depositToken() public view override returns (address) {
    return _tokenAddress();
  }

  /**
   * @notice Returns the Yield Source ERC20 token decimals.
   * @dev This value should be equal to the decimals of the token used to deposit into the pool.
   * @return The number of decimals
   */
  function decimals() public view virtual override returns (uint8) {
    return _decimals;
  }

  /**
   * @notice Supplies asset tokens to the yield source.
   * @dev Shares corresponding to the number of tokens supplied are minted to the user's balance
   * @dev Asset tokens are supplied to the yield source, then deposited into Aave
   * @param _mintAmount The amount of asset tokens to be supplied
   * @param _to The user whose balance will receive the tokens
   */
  function supplyTokenTo(uint256 _mintAmount, address _to) external override nonReentrant {
    uint256 _shares = _tokenToShares(_mintAmount);

    require(_shares > 0, "ATokenYS/shares-gt-zero");
    _supplyToAave(_mintAmount);
    _mint(_to, _shares);

    emit SuppliedTokenTo(msg.sender, _shares, _mintAmount, _to);
  }

  /**
   * @notice Redeems asset tokens from the yield source.
   * @dev Shares corresponding to the number of tokens withdrawn are burnt from the user's balance.
   * @dev Asset tokens are withdrawn from Aave, then transferred from the yield source to the user's wallet.
   * @param _redeemAmount The amount of asset tokens to be redeemed
   * @return The actual amount of asset tokens that were redeemed.
   */
  function redeemToken(uint256 _redeemAmount) external override nonReentrant returns (uint256) {
    address _underlyingAssetAddress = _tokenAddress();
    IERC20 _assetToken = IERC20(_underlyingAssetAddress);

    uint256 _shares = _tokenToShares(_redeemAmount);
    _burn(msg.sender, _shares);

    uint256 _beforeBalance = _assetToken.balanceOf(address(this));
    _pool().withdraw(_underlyingAssetAddress, _redeemAmount, address(this));
    uint256 _afterBalance = _assetToken.balanceOf(address(this));

    uint256 _balanceDiff = _afterBalance.sub(_beforeBalance);
    _assetToken.safeTransfer(msg.sender, _balanceDiff);

    emit RedeemedToken(msg.sender, _shares, _redeemAmount);
    return _balanceDiff;
  }

  /**
   * @notice Claims the accrued rewards for the aToken, accumulating any pending rewards.
   * @dev Only callable by the owner or manager.
   * @param _to Address where the claimed rewards will be sent.
   * @return True if operation was successful.
   */
  function claimRewards(address _to) external onlyManagerOrOwner returns (bool) {
    require(_to != address(0), "ATokenYS/payee-not-zero-address");

    address[] memory _assets = new address[](1);
    _assets[0] = address(aToken);

    (, uint256[] memory _claimedAmounts) = rewardsController.claimAllRewards(_assets, _to);

    emit Claimed(msg.sender, _to, _claimedAmounts[0]);
    return true;
  }

  /**
   * @notice Transfer ERC20 tokens other than the aTokens held by this contract to the recipient address.
   * @dev This function is only callable by the owner or asset manager
   * @param _token The ERC20 token to transfer
   * @param _to The recipient of the tokens
   * @param _amount The amount of tokens to transfer
   */
  function transferERC20(
    IERC20 _token,
    address _to,
    uint256 _amount
  ) external onlyManagerOrOwner {
    require(address(_token) != address(aToken), "ATokenYS/forbid-aToken-transfer");
    _token.safeTransfer(_to, _amount);
    emit TransferredERC20(msg.sender, _to, _amount, _token);
  }

  /**
   * @notice Allows someone to deposit into the yield source without receiving any shares.
   * @dev This allows anyone to distribute tokens among the share holders.
   * @param _sponsorAmount The amount of tokens to deposit
   */
  function sponsor(uint256 _sponsorAmount) external nonReentrant {
    _supplyToAave(_sponsorAmount);
    emit Sponsored(msg.sender, _sponsorAmount);
  }

  /**
   * @notice Allows someone to deposit into the yield source without receiving any shares.
   * @dev This allows anyone to distribute tokens among the share holders.
   * @param _sponsorAmount The amount of tokens to deposit
   * @param _permitSignature Permit signature
   */
  function sponsorWithPermit(uint256 _sponsorAmount, Signature calldata _permitSignature)
    external
    nonReentrant
  {
    _supplyToAaveWithPermit(_sponsorAmount, _permitSignature);
    emit Sponsored(msg.sender, _sponsorAmount);
  }

  /* ============ Internal Functions ============ */

  /**
   * @notice Calculates the number of shares that should be mint or burned when a user deposit or withdraw.
   * @param _tokens Amount of tokens
   * @return Number of shares.
   */
  function _tokenToShares(uint256 _tokens) internal view returns (uint256) {
    uint256 _supply = totalSupply();

    // shares = tokens * (totalShares / yieldSourceTotalSupply)
    return _supply == 0 ? _tokens : _tokens.wadMul(_supply.wadDiv(aToken.balanceOf(address(this))));
  }

  /**
   * @notice Calculates the number of tokens a user has in the yield source.
   * @param _shares Amount of shares
   * @return Number of tokens.
   */
  function _sharesToToken(uint256 _shares) internal view returns (uint256) {
    uint256 _supply = totalSupply();

    // tokens = (shares * yieldSourceTotalSupply) / totalShares
    return _supply == 0 ? _shares : _shares.mul(aToken.balanceOf(address(this))).div(_supply);
  }

  /**
   * @notice Deposits asset tokens into the yield source.
   * @param _assetToken ERC20 asset token address
   * @param _amount Amount of asset tokens to be deposited
   */
  function _depositAssetTokens(IERC20 _assetToken, uint256 _amount) internal {
    _assetToken.safeTransferFrom(msg.sender, address(this), _amount);
  }

  /**
   * @notice Supply asset tokens to Aave.
   * @param _mintAmount Amount of asset tokens to be supplied
   */
  function _supplyToAave(uint256 _mintAmount) internal {
    address _underlyingAssetAddress = _tokenAddress();

    _depositAssetTokens(IERC20(_underlyingAssetAddress), _mintAmount);
    _pool().supply(_underlyingAssetAddress, _mintAmount, address(this), REFERRAL_CODE);
  }

  /**
   * @notice Supply asset tokens to Aave with permit.
   * @param _mintAmount Amount of asset tokens to be supplied
   * @param _permitSignature Permit signature
   */
  function _supplyToAaveWithPermit(uint256 _mintAmount, Signature calldata _permitSignature)
    internal
  {
    address _underlyingAssetAddress = _tokenAddress();

    IERC20Permit(_underlyingAssetAddress).permit(
      msg.sender,
      address(this),
      _mintAmount,
      _permitSignature.deadline,
      _permitSignature.v,
      _permitSignature.r,
      _permitSignature.s
    );

    _depositAssetTokens(IERC20(_underlyingAssetAddress), _mintAmount);
    _pool().supplyWithPermit(
      _underlyingAssetAddress,
      _mintAmount,
      address(this),
      REFERRAL_CODE,
      _permitSignature.deadline,
      _permitSignature.v,
      _permitSignature.r,
      _permitSignature.s
    );
  }

  /**
   * @notice Returns the underlying asset token address.
   * @return Underlying asset token address.
   */
  function _tokenAddress() internal view returns (address) {
    return aToken.UNDERLYING_ASSET_ADDRESS();
  }

  /**
   * @notice Retrieves Aave PoolAddressesProvider address.
   * @return A reference to PoolAddressesProvider interface.
   */
  function _poolProvider() internal view returns (IPoolAddressesProvider) {
    return
      IPoolAddressesProvider(
        poolAddressesProviderRegistry.getAddressesProvidersList()[ADDRESSES_PROVIDER_ID]
      );
  }

  /**
   * @notice Retrieves Aave Pool address.
   * @return A reference to Pool interface.
   */
  function _pool() internal view returns (IPool) {
    return IPool(_poolProvider().getPool());
  }
}
