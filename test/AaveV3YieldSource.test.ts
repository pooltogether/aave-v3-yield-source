import { Signer } from '@ethersproject/abstract-signer';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { MockContract } from 'ethereum-waffle';
import { ethers, waffle } from 'hardhat';

import {
  AaveV3YieldSourceHarness,
  AaveV3YieldSourceHarness__factory,
  AavePool,
  ATokenMintable,
  ERC20Mintable,
} from '../types';

import IRewardsController from '../abis/IRewardsController.json';
import IPoolAddressesProvider from '../abis/IPoolAddressesProvider.json';
import IPoolAddressesProviderRegistry from '../abis/IPoolAddressesProviderRegistry.json';
import SafeERC20Wrapper from '../abis/SafeERC20Wrapper.json';

const { constants, getContractFactory, getSigners, utils } = ethers;
const { AddressZero, MaxUint256, Zero } = constants;
const { parseUnits } = utils;

const DECIMALS = 6;

const toWei = (amount: string) => parseUnits(amount, DECIMALS);

describe('AaveV3YieldSource', () => {
  let contractsOwner: Signer;
  let yieldSourceOwner: SignerWithAddress;
  let wallet2: SignerWithAddress;
  let attacker: SignerWithAddress;

  let aToken: ATokenMintable;
  let rewardsController: MockContract;
  let pool: AavePool;
  let poolAddressesProvider: MockContract;
  let poolAddressesProviderRegistry: MockContract;

  let aaveV3YieldSource: AaveV3YieldSourceHarness;

  let erc20Token: MockContract;
  let usdcToken: ERC20Mintable;

  let constructorTest = false;

  const deployAaveV3YieldSource = async (
    aTokenAddress: string,
    rewardsControllerAddress: string,
    poolAddressesProviderRegistryAddress: string,
    decimals: number,
    owner: string,
  ): Promise<AaveV3YieldSourceHarness> => {
    const AaveV3YieldSource = (await ethers.getContractFactory(
      'AaveV3YieldSourceHarness',
    )) as AaveV3YieldSourceHarness__factory;

    return await AaveV3YieldSource.deploy(
      aTokenAddress,
      rewardsControllerAddress,
      poolAddressesProviderRegistryAddress,
      'PoolTogether aUSDC Yield',
      'PTaUSDCY',
      decimals,
      owner,
    );
  };

  const supplyTokenTo = async (user: SignerWithAddress, amount: BigNumber) => {
    const userAddress = user.address;

    await usdcToken.mint(userAddress, amount);
    await usdcToken.connect(user).approve(aaveV3YieldSource.address, MaxUint256);

    await aaveV3YieldSource.connect(user).supplyTokenTo(amount, userAddress);
  };

  const sharesToToken = async (shares: BigNumber, yieldSourceTotalSupply: BigNumber) => {
    const totalShares = await aaveV3YieldSource.totalSupply();

    // tokens = (shares * yieldSourceBalanceOfAToken) / totalSupply
    return shares.mul(yieldSourceTotalSupply).div(totalShares);
  };

  const tokenToShares = async (token: BigNumber, yieldSourceTotalSupply: BigNumber) => {
    const totalShares = await aaveV3YieldSource.totalSupply();

    // shares = (tokens * totalSupply) / yieldSourceBalanceOfAToken
    return token.mul(totalShares).div(yieldSourceTotalSupply);
  };

  beforeEach(async () => {
    const { deployMockContract } = waffle;

    [contractsOwner, yieldSourceOwner, wallet2, attacker] = await getSigners();

    const ERC20MintableContract = await getContractFactory('ERC20Mintable', contractsOwner);

    erc20Token = await deployMockContract(contractsOwner, SafeERC20Wrapper);

    usdcToken = (await ERC20MintableContract.deploy('USD Coin', 'USDC', DECIMALS)) as ERC20Mintable;

    const ATokenMintableContract = await getContractFactory('ATokenMintable', contractsOwner);

    aToken = (await ATokenMintableContract.deploy(
      usdcToken.address,
      'Aave interest bearing USDC',
      'aUSDC',
      DECIMALS,
    )) as ATokenMintable;

    const AavePoolContract = await getContractFactory('AavePool', contractsOwner);

    pool = (await AavePoolContract.deploy(usdcToken.address, aToken.address)) as AavePool;

    rewardsController = await deployMockContract(contractsOwner, IRewardsController);

    poolAddressesProvider = await deployMockContract(contractsOwner, IPoolAddressesProvider);

    poolAddressesProviderRegistry = await deployMockContract(
      contractsOwner,
      IPoolAddressesProviderRegistry,
    );

    await poolAddressesProvider.mock.getPool.returns(pool.address);
    await poolAddressesProviderRegistry.mock.getAddressesProvidersList.returns([
      poolAddressesProvider.address,
    ]);

    if (!constructorTest) {
      aaveV3YieldSource = await deployAaveV3YieldSource(
        aToken.address,
        rewardsController.address,
        poolAddressesProviderRegistry.address,
        DECIMALS,
        yieldSourceOwner.address,
      );
    }
  });

  describe('constructor()', () => {
    beforeEach(() => {
      constructorTest = true;
    });

    afterEach(() => {
      constructorTest = false;
    });

    it('should deploy a new AaveV3YieldSource', async () => {
      const aaveV3YieldSource = await deployAaveV3YieldSource(
        aToken.address,
        rewardsController.address,
        poolAddressesProviderRegistry.address,
        DECIMALS,
        yieldSourceOwner.address,
      );

      await expect(aaveV3YieldSource.deployTransaction)
        .to.emit(aaveV3YieldSource, 'AaveV3YieldSourceInitialized')
        .withArgs(
          aToken.address,
          rewardsController.address,
          poolAddressesProviderRegistry.address,
          'PoolTogether aUSDC Yield',
          'PTaUSDCY',
          DECIMALS,
          yieldSourceOwner.address,
        );
    });

    it('should fail if aToken is address zero', async () => {
      await expect(
        deployAaveV3YieldSource(
          AddressZero,
          rewardsController.address,
          poolAddressesProviderRegistry.address,
          DECIMALS,
          yieldSourceOwner.address,
        ),
      ).to.be.revertedWith('AaveV3YS/aToken-not-zero-address');
    });

    it('should fail if rewardsController is address zero', async () => {
      await expect(
        deployAaveV3YieldSource(
          aToken.address,
          AddressZero,
          poolAddressesProviderRegistry.address,
          DECIMALS,
          yieldSourceOwner.address,
        ),
      ).to.be.revertedWith('AaveV3YS/RC-not-zero-address');
    });

    it('should fail if poolAddressesProviderRegistry is address zero', async () => {
      await expect(
        deployAaveV3YieldSource(
          aToken.address,
          rewardsController.address,
          AddressZero,
          DECIMALS,
          yieldSourceOwner.address,
        ),
      ).to.be.revertedWith('AaveV3YS/PR-not-zero-address');
    });

    it('should fail if owner is address zero', async () => {
      await expect(
        deployAaveV3YieldSource(
          aToken.address,
          rewardsController.address,
          poolAddressesProviderRegistry.address,
          DECIMALS,
          AddressZero,
        ),
      ).to.be.revertedWith('AaveV3YS/owner-not-zero-address');
    });

    it('should fail if token decimal is not greater than 0', async () => {
      await expect(
        deployAaveV3YieldSource(
          aToken.address,
          rewardsController.address,
          poolAddressesProviderRegistry.address,
          0,
          yieldSourceOwner.address,
        ),
      ).to.be.revertedWith('AaveV3YS/decimals-gt-zero');
    });
  });

  describe('decimals()', () => {
    it('should return the ERC20 token decimals number', async () => {
      expect(await aaveV3YieldSource.decimals()).to.equal(DECIMALS);
    });
  });

  describe('depositToken()', () => {
    it('should return the underlying token', async () => {
      expect(await aaveV3YieldSource.depositToken()).to.equal(usdcToken.address);
    });
  });

  describe('balanceOfToken()', () => {
    it('should return user balance', async () => {
      const firstAmount = toWei('100');
      const yieldSourceTotalSupply = firstAmount.mul(2);

      await supplyTokenTo(yieldSourceOwner, firstAmount);
      await supplyTokenTo(yieldSourceOwner, firstAmount);

      const shares = await aaveV3YieldSource.balanceOf(yieldSourceOwner.address);
      const tokens = await sharesToToken(shares, yieldSourceTotalSupply);

      expect(await aaveV3YieldSource.balanceOfToken(yieldSourceOwner.address)).to.equal(tokens);
    });
  });

  describe('_tokenToShares()', () => {
    it('should return shares amount', async () => {
      const amount = toWei('100');

      await supplyTokenTo(yieldSourceOwner, amount);
      await supplyTokenTo(wallet2, amount);

      const tokens = toWei('10');
      const shares = await tokenToShares(tokens, amount.mul(2));

      expect(await aaveV3YieldSource.tokenToShares(tokens)).to.equal(shares);
    });

    it('should return 0 if tokens param is 0', async () => {
      expect(await aaveV3YieldSource.tokenToShares(toWei('0'))).to.equal(toWei('0'));
    });

    it('should return tokens if totalSupply is 0', async () => {
      expect(await aaveV3YieldSource.tokenToShares(toWei('100'))).to.equal(toWei('100'));
    });

    it('should return shares even if aToken total supply is very small', async () => {
      const amount = toWei('0.000005');
      const shares = toWei('1');

      await aaveV3YieldSource.mint(yieldSourceOwner.address, shares);
      await aToken.mint(aaveV3YieldSource.address, amount);

      expect(await aaveV3YieldSource.tokenToShares(amount)).to.equal(shares);
    });

    it('should return shares even if aToken total supply increases', async () => {
      const amount = toWei('100');
      const tokens = toWei('1');

      await aaveV3YieldSource.mint(yieldSourceOwner.address, amount);
      await aaveV3YieldSource.mint(wallet2.address, amount);
      await aToken.mint(aaveV3YieldSource.address, amount);

      expect(await aaveV3YieldSource.tokenToShares(tokens)).to.equal(toWei('2'));

      await aToken.mint(aaveV3YieldSource.address, parseUnits('100', 12).sub(amount));

      expect(await aaveV3YieldSource.tokenToShares(tokens)).to.equal(2);
    });

    it('should fail to return shares if aToken total supply increases too much', async () => {
      const amount = toWei('100');

      await aaveV3YieldSource.mint(yieldSourceOwner.address, amount);
      await aaveV3YieldSource.mint(wallet2.address, amount);
      await aToken.mint(aaveV3YieldSource.address, amount);

      expect(await aaveV3YieldSource.tokenToShares(toWei('1'))).to.equal(toWei('2'));

      await aToken.mint(aaveV3YieldSource.address, parseUnits('100', 13).sub(amount));

      await expect(aaveV3YieldSource.supplyTokenTo(toWei('1'), wallet2.address)).to.be.revertedWith(
        'AaveV3YS/shares-gt-zero',
      );
    });
  });

  describe('_sharesToToken()', () => {
    it('should return tokens amount', async () => {
      const amount = toWei('100');

      await aaveV3YieldSource.mint(yieldSourceOwner.address, amount);
      await aaveV3YieldSource.mint(wallet2.address, amount);
      await aToken.mint(aaveV3YieldSource.address, toWei('1000'));

      expect(await aaveV3YieldSource.sharesToToken(toWei('2'))).to.equal(toWei('10'));
    });

    it('should return shares if totalSupply is 0', async () => {
      const shares = toWei('100');
      expect(await aaveV3YieldSource.sharesToToken(shares)).to.equal(shares);
    });

    it('should return tokens even if shares are very small', async () => {
      const shares = toWei('0.000005');
      const tokens = toWei('100');

      await aaveV3YieldSource.mint(yieldSourceOwner.address, shares);
      await aToken.mint(aaveV3YieldSource.address, tokens);

      expect(await aaveV3YieldSource.sharesToToken(shares)).to.equal(tokens);
    });

    it('should return tokens even if aToken total supply increases', async () => {
      const amount = toWei('100');
      const tokens = toWei('1');

      await aaveV3YieldSource.mint(yieldSourceOwner.address, amount);
      await aaveV3YieldSource.mint(wallet2.address, amount);
      await aToken.mint(aaveV3YieldSource.address, amount);

      expect(await aaveV3YieldSource.sharesToToken(toWei('2'))).to.equal(tokens);

      await aToken.mint(aaveV3YieldSource.address, parseUnits('100', 12).sub(amount));

      expect(await aaveV3YieldSource.sharesToToken(2)).to.equal(tokens);
    });
  });

  describe('supplyTokenTo()', () => {
    let amount: BigNumber;
    let tokenAddress: any;

    beforeEach(async () => {
      amount = toWei('100');
      tokenAddress = await aaveV3YieldSource.depositToken();
    });

    it('should supply assets if totalSupply is 0', async () => {
      await supplyTokenTo(yieldSourceOwner, amount);
      expect(await aaveV3YieldSource.totalSupply()).to.equal(amount);
    });

    it('should supply assets if totalSupply is not 0', async () => {
      await supplyTokenTo(yieldSourceOwner, amount);
      await supplyTokenTo(wallet2, amount);

      expect(await aaveV3YieldSource.totalSupply()).to.equal(amount.mul(2));
    });

    it('should fail to manipulate share price significantly', async () => {
      const attackAmount = toWei('10');
      const aTokenAmount = toWei('1000');
      const attackerBalance = attackAmount.add(aTokenAmount);

      await supplyTokenTo(attacker, attackAmount);

      // Attacker sends 1000 aTokens directly to the contract to manipulate share price
      await aToken.mint(attacker.address, aTokenAmount);
      await aToken.connect(attacker).approve(aaveV3YieldSource.address, aTokenAmount);
      await aToken.connect(attacker).transfer(aaveV3YieldSource.address, aTokenAmount);

      await supplyTokenTo(wallet2, amount);

      expect(await aaveV3YieldSource.balanceOfToken(attacker.address)).to.equal(attackerBalance);

      // We account for a small loss in precision due to the attack
      expect(await aaveV3YieldSource.balanceOfToken(wallet2.address)).to.be.gte(
        amount.sub(toWei('0.0001')),
      );
    });

    it('should succeed to manipulate share price significantly but users should not be able to deposit smaller amounts', async () => {
      const attackAmount = BigNumber.from(1);
      const aTokenAmount = toWei('1000');

      await supplyTokenTo(attacker, attackAmount);

      // Attacker sends 1000 aTokens directly to the contract to manipulate share price
      await aToken.mint(attacker.address, aTokenAmount);
      await aToken.connect(attacker).approve(aaveV3YieldSource.address, aTokenAmount);
      await aToken.connect(attacker).transfer(aaveV3YieldSource.address, aTokenAmount);

      await expect(supplyTokenTo(wallet2, amount)).to.be.revertedWith('AaveV3YS/shares-gt-zero');
    });
  });

  describe('redeemToken()', () => {
    let yieldSourceOwnerBalance: BigNumber;
    let redeemAmount: BigNumber;

    beforeEach(() => {
      yieldSourceOwnerBalance = toWei('300');
      redeemAmount = toWei('100');
    });

    it('should redeem assets', async () => {
      await supplyTokenTo(yieldSourceOwner, yieldSourceOwnerBalance);

      await aaveV3YieldSource.connect(yieldSourceOwner).redeemToken(redeemAmount);

      expect(await aaveV3YieldSource.balanceOf(yieldSourceOwner.address)).to.equal(
        yieldSourceOwnerBalance.sub(redeemAmount),
      );
    });

    it('should not be able to redeem assets if balance is 0', async () => {
      await expect(
        aaveV3YieldSource.connect(yieldSourceOwner).redeemToken(redeemAmount),
      ).to.be.revertedWith('ERC20: burn amount exceeds balance');
    });

    it('should fail to redeem if amount is greater than balance', async () => {
      const yieldSourceOwnerLowBalance = toWei('10');

      await supplyTokenTo(yieldSourceOwner, yieldSourceOwnerLowBalance);

      await expect(
        aaveV3YieldSource.connect(yieldSourceOwner).redeemToken(redeemAmount),
      ).to.be.revertedWith('ERC20: burn amount exceeds balance');
    });

    it('should succeed to manipulate share price but fail to redeem without burning any shares', async () => {
      const amount = toWei('100000');
      const attackAmount = BigNumber.from(1);
      const aTokenAmount = toWei('10000');

      await supplyTokenTo(attacker, attackAmount);

      // Attacker sends 10000 aTokens directly to the contract to manipulate share price
      await aToken.mint(attacker.address, aTokenAmount);
      await aToken.connect(attacker).approve(aaveV3YieldSource.address, aTokenAmount);
      await aToken.connect(attacker).transfer(aaveV3YieldSource.address, aTokenAmount);

      await supplyTokenTo(wallet2, amount);

      const sharePrice = await aaveV3YieldSource.sharesToToken(BigNumber.from(1));

      // Redeem 1 wei less than the full amount of a share to burn 0 share instead of 1 because of rounding error
      // The actual amount of shares to be burnt should be 0.99 but since Solidity truncates down, it will be 0
      const attackerRedeemAmount = sharePrice.sub(1);

      await expect(
        aaveV3YieldSource.connect(attacker).redeemToken(attackerRedeemAmount),
      ).to.be.revertedWith('AaveV3YS/shares-gt-zero');
    });
  });

  describe('claimRewards()', () => {
    const claimAmount = toWei('100');

    beforeEach(async () => {
      await rewardsController.mock.claimAllRewards
        .withArgs([aToken.address], wallet2.address)
        .returns([erc20Token.address], [claimAmount]);
    });

    it('should claimRewards if yieldSourceOwner', async () => {
      await expect(aaveV3YieldSource.connect(yieldSourceOwner).claimRewards(wallet2.address))
        .to.emit(aaveV3YieldSource, 'Claimed')
        .withArgs(yieldSourceOwner.address, wallet2.address, [erc20Token.address], [claimAmount]);
    });

    it('should claimRewards if assetManager', async () => {
      await aaveV3YieldSource.connect(yieldSourceOwner).setManager(wallet2.address);

      await expect(aaveV3YieldSource.connect(wallet2).claimRewards(wallet2.address))
        .to.emit(aaveV3YieldSource, 'Claimed')
        .withArgs(wallet2.address, wallet2.address, [erc20Token.address], [claimAmount]);
    });

    it('should fail to claimRewards if recipient is address zero', async () => {
      await expect(
        aaveV3YieldSource.connect(yieldSourceOwner).claimRewards(AddressZero),
      ).to.be.revertedWith('AaveV3YS/payee-not-zero-address');
    });

    it('should fail to claimRewards if not yieldSourceOwner or assetManager', async () => {
      await expect(
        aaveV3YieldSource.connect(wallet2).claimRewards(wallet2.address),
      ).to.be.revertedWith('Manageable/caller-not-manager-or-owner');
    });
  });

  describe('increaseERC20Allowance()', () => {
    it('should increase allowance if yieldSourceOwner', async () => {
      const approveAmount = toWei('10');

      usdcToken.mint(aaveV3YieldSource.address, approveAmount);

      await aaveV3YieldSource
        .connect(yieldSourceOwner)
        .increaseERC20Allowance(usdcToken.address, yieldSourceOwner.address, approveAmount);

      usdcToken
        .connect(wallet2)
        .transferFrom(aaveV3YieldSource.address, wallet2.address, approveAmount);
    });

    it('should increase allowance of the underlying asset deposited into the Aave pool', async () => {
      await aaveV3YieldSource
        .connect(yieldSourceOwner)
        .decreaseERC20Allowance(usdcToken.address, pool.address, MaxUint256);

      expect(await usdcToken.allowance(aaveV3YieldSource.address, pool.address)).to.equal(
        toWei('0'),
      );

      await aaveV3YieldSource
        .connect(yieldSourceOwner)
        .increaseERC20Allowance(usdcToken.address, pool.address, MaxUint256);

      expect(await usdcToken.allowance(aaveV3YieldSource.address, pool.address)).to.equal(
        MaxUint256,
      );
    });

    it('should increase allowance if assetManager', async () => {
      const approveAmount = toWei('10');

      await aaveV3YieldSource.connect(yieldSourceOwner).setManager(wallet2.address);

      usdcToken.mint(aaveV3YieldSource.address, approveAmount);

      await aaveV3YieldSource
        .connect(wallet2)
        .increaseERC20Allowance(usdcToken.address, wallet2.address, approveAmount);

      usdcToken
        .connect(wallet2)
        .transferFrom(aaveV3YieldSource.address, wallet2.address, approveAmount);
    });

    it('should not allow to increase allowance of aToken', async () => {
      await expect(
        aaveV3YieldSource
          .connect(yieldSourceOwner)
          .increaseERC20Allowance(aToken.address, wallet2.address, toWei('10')),
      ).to.be.revertedWith('AaveV3YS/forbid-aToken-change');
    });

    it('should fail to increase allowance if not yieldSourceOwner or assetManager', async () => {
      await expect(
        aaveV3YieldSource
          .connect(wallet2)
          .increaseERC20Allowance(usdcToken.address, yieldSourceOwner.address, toWei('10')),
      ).to.be.revertedWith('Manageable/caller-not-manager-or-owner');
    });
  });

  describe('decreaseERC20Allowance()', () => {
    beforeEach(async () => {
      await aaveV3YieldSource
        .connect(yieldSourceOwner)
        .increaseERC20Allowance(usdcToken.address, wallet2.address, MaxUint256);
    });

    it('should decrease allowance if yieldSourceOwner', async () => {
      usdcToken.mint(aaveV3YieldSource.address, MaxUint256);

      await aaveV3YieldSource
        .connect(yieldSourceOwner)
        .decreaseERC20Allowance(usdcToken.address, wallet2.address, MaxUint256);

      await expect(
        usdcToken
          .connect(wallet2)
          .transferFrom(aaveV3YieldSource.address, wallet2.address, MaxUint256),
      ).to.be.revertedWith('ERC20: insufficient allowance');
    });

    it('should decrease allowance if assetManager', async () => {
      await aaveV3YieldSource.connect(yieldSourceOwner).setManager(wallet2.address);

      usdcToken.mint(aaveV3YieldSource.address, MaxUint256);

      await aaveV3YieldSource
        .connect(wallet2)
        .decreaseERC20Allowance(usdcToken.address, wallet2.address, MaxUint256);

      await expect(
        usdcToken
          .connect(wallet2)
          .transferFrom(aaveV3YieldSource.address, wallet2.address, MaxUint256),
      ).to.be.revertedWith('ERC20: insufficient allowance');
    });

    it('should not allow to decrease allowance of aToken', async () => {
      await expect(
        aaveV3YieldSource
          .connect(yieldSourceOwner)
          .decreaseERC20Allowance(aToken.address, wallet2.address, MaxUint256),
      ).to.be.revertedWith('AaveV3YS/forbid-aToken-change');
    });

    it('should fail to decrease allowance if not yieldSourceOwner or assetManager', async () => {
      await expect(
        aaveV3YieldSource
          .connect(wallet2)
          .decreaseERC20Allowance(usdcToken.address, yieldSourceOwner.address, MaxUint256),
      ).to.be.revertedWith('Manageable/caller-not-manager-or-owner');
    });
  });

  describe('transferERC20()', () => {
    it('should transferERC20 if yieldSourceOwner', async () => {
      const transferAmount = toWei('10');

      usdcToken.mint(aaveV3YieldSource.address, transferAmount);

      await aaveV3YieldSource
        .connect(yieldSourceOwner)
        .transferERC20(usdcToken.address, wallet2.address, transferAmount);
    });

    it('should transferERC20 if assetManager', async () => {
      const transferAmount = toWei('10');

      usdcToken.mint(aaveV3YieldSource.address, transferAmount);

      await aaveV3YieldSource.connect(yieldSourceOwner).setManager(wallet2.address);

      await aaveV3YieldSource
        .connect(wallet2)
        .transferERC20(usdcToken.address, yieldSourceOwner.address, transferAmount);
    });

    it('should not allow to transfer aToken', async () => {
      await expect(
        aaveV3YieldSource
          .connect(yieldSourceOwner)
          .transferERC20(aToken.address, wallet2.address, toWei('10')),
      ).to.be.revertedWith('AaveV3YS/forbid-aToken-change');
    });

    it('should fail to transferERC20 if not yieldSourceOwner or assetManager', async () => {
      await expect(
        aaveV3YieldSource
          .connect(wallet2)
          .transferERC20(usdcToken.address, yieldSourceOwner.address, toWei('10')),
      ).to.be.revertedWith('Manageable/caller-not-manager-or-owner');
    });
  });

  describe('_pool()', () => {
    it('should return Aave Pool address', async () => {
      expect(await aaveV3YieldSource.pool()).to.equal(pool.address);
    });
  });
});
