import { Signer } from '@ethersproject/abstract-signer';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { MockContract } from 'ethereum-waffle';
import { ethers, waffle } from 'hardhat';

import {
  ATokenYieldSourceHarness,
  ATokenYieldSourceHarness__factory,
  ERC20Mintable,
} from '../types';

import IAToken from '../abis/IAToken.json';
import IRewardsController from '../abis/IRewardsController.json';
import IPool from '../abis/IPool.json';
import IPoolAddressesProvider from '../abis/IPoolAddressesProvider.json';
import IPoolAddressesProviderRegistry from '../abis/IPoolAddressesProviderRegistry.json';
import SafeERC20Wrapper from '../abis/SafeERC20Wrapper.json';

import { permitSignature } from './utils/permitSignature';

const { constants, getContractFactory, getSigners, provider, utils } = ethers;
const { AddressZero, MaxUint256 } = constants;
const { parseEther: toWei } = utils;

const DECIMALS = 6;
const REFERRAL_CODE = 188;

describe('ATokenYieldSource', () => {
  let contractsOwner: Signer;
  let yieldSourceOwner: SignerWithAddress;
  let wallet2: SignerWithAddress;

  let aToken: MockContract;
  let rewardsController: MockContract;
  let pool: MockContract;
  let poolAddressesProvider: MockContract;
  let poolAddressesProviderRegistry: MockContract;

  let aTokenYieldSource: ATokenYieldSourceHarness;

  let erc20Token: MockContract;
  let usdcToken: ERC20Mintable;

  let constructorTest = false;

  const deployATokenYieldSource = async (
    aTokenAddress: string,
    rewardsControllerAddress: string,
    poolAddressesProviderRegistryAddress: string,
    decimals: number,
    owner: string,
  ): Promise<ATokenYieldSourceHarness> => {
    const ATokenYieldSource = (await ethers.getContractFactory(
      'ATokenYieldSourceHarness',
    )) as ATokenYieldSourceHarness__factory;

    return await ATokenYieldSource.deploy(
      aTokenAddress,
      rewardsControllerAddress,
      poolAddressesProviderRegistryAddress,
      'PoolTogether aUSDC Yield',
      'PTaUSDCY',
      decimals,
      owner,
    );
  };

  const supplyTokenTo = async (
    user: SignerWithAddress,
    amount: BigNumber,
    aTokenTotalSupply: BigNumber,
  ) => {
    const tokenAddress = await aTokenYieldSource.tokenAddress();
    const userAddress = user.address;

    await usdcToken.mint(userAddress, amount);
    await usdcToken.connect(user).approve(aTokenYieldSource.address, MaxUint256);

    await pool.mock.supply
      .withArgs(tokenAddress, amount, aTokenYieldSource.address, REFERRAL_CODE)
      .returns();

    // aTokenTotalSupply should never be 0 since we mint shares to the user after depositing in Aave
    await aToken.mock.balanceOf.withArgs(aTokenYieldSource.address).returns(aTokenTotalSupply);

    await aTokenYieldSource.connect(user).supplyTokenTo(amount, userAddress);
  };

  const sharesToToken = async (shares: BigNumber, yieldSourceTotalSupply: BigNumber) => {
    const totalShares = await aTokenYieldSource.callStatic.totalSupply();

    // tokens = (shares * yieldSourceTotalSupply) / totalShares
    return shares.mul(yieldSourceTotalSupply).div(totalShares);
  };

  beforeEach(async () => {
    const { deployMockContract } = waffle;

    [contractsOwner, yieldSourceOwner, wallet2] = await getSigners();

    const ERC20MintableContract = await getContractFactory('ERC20Mintable', contractsOwner);

    erc20Token = await deployMockContract(contractsOwner, SafeERC20Wrapper);

    usdcToken = (await ERC20MintableContract.deploy('USD Coin', 'USDC', 6)) as ERC20Mintable;

    aToken = await deployMockContract(contractsOwner, IAToken);
    await aToken.mock.UNDERLYING_ASSET_ADDRESS.returns(usdcToken.address);

    pool = await deployMockContract(contractsOwner, IPool);

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
      aTokenYieldSource = await deployATokenYieldSource(
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

    it('should deploy a new ATokenYieldSource', async () => {
      const aTokenYieldSource = await deployATokenYieldSource(
        aToken.address,
        rewardsController.address,
        poolAddressesProviderRegistry.address,
        DECIMALS,
        yieldSourceOwner.address,
      );

      await expect(aTokenYieldSource.deployTransaction)
        .to.emit(aTokenYieldSource, 'ATokenYieldSourceInitialized')
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
        deployATokenYieldSource(
          AddressZero,
          rewardsController.address,
          poolAddressesProviderRegistry.address,
          DECIMALS,
          yieldSourceOwner.address,
        ),
      ).to.be.revertedWith('ATokenYS/aToken-not-zero-address');
    });

    it('should fail if rewardsController is address zero', async () => {
      await expect(
        deployATokenYieldSource(
          aToken.address,
          AddressZero,
          poolAddressesProviderRegistry.address,
          DECIMALS,
          yieldSourceOwner.address,
        ),
      ).to.be.revertedWith('ATokenYS/rewardsController-not-zero-address');
    });

    it('should fail if poolAddressesProviderRegistry is address zero', async () => {
      await expect(
        deployATokenYieldSource(
          aToken.address,
          rewardsController.address,
          AddressZero,
          DECIMALS,
          yieldSourceOwner.address,
        ),
      ).to.be.revertedWith('ATokenYS/poolRegistry-not-zero-address');
    });

    it('should fail if owner is address zero', async () => {
      await expect(
        deployATokenYieldSource(
          aToken.address,
          rewardsController.address,
          poolAddressesProviderRegistry.address,
          DECIMALS,
          AddressZero,
        ),
      ).to.be.revertedWith('ATokenYS/owner-not-zero-address');
    });

    it('should fail if token decimal is not greater than 0', async () => {
      await expect(
        deployATokenYieldSource(
          aToken.address,
          rewardsController.address,
          poolAddressesProviderRegistry.address,
          0,
          yieldSourceOwner.address,
        ),
      ).to.be.revertedWith('ATokenYS/decimals-gt-zero');
    });
  });

  describe('approveMaxAmount()', () => {
    it('should approve Aave pool to spend max uint256 amount', async () => {
      expect(
        await aTokenYieldSource.connect(yieldSourceOwner).callStatic.approveMaxAmount(),
      ).to.equal(true);

      expect(await usdcToken.allowance(aTokenYieldSource.address, pool.address)).to.equal(
        MaxUint256,
      );
    });

    it('should fail if not owner', async () => {
      await expect(
        aTokenYieldSource.connect(wallet2).callStatic.approveMaxAmount(),
      ).to.be.revertedWith('Ownable/caller-not-owner');
    });
  });

  describe('decimals()', () => {
    it('should return the ERC30 token decimals number', async () => {
      expect(await aTokenYieldSource.decimals()).to.equal(DECIMALS);
    });
  });

  describe('depositToken()', () => {
    it('should return the underlying token', async () => {
      expect(await aTokenYieldSource.depositToken()).to.equal(usdcToken.address);
    });
  });

  describe('balanceOfToken()', () => {
    it('should return user balance', async () => {
      const firstAmount = toWei('100');
      const yieldSourceTotalSupply = firstAmount.mul(2);

      await supplyTokenTo(yieldSourceOwner, firstAmount, firstAmount);
      await supplyTokenTo(yieldSourceOwner, firstAmount, yieldSourceTotalSupply);

      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(yieldSourceTotalSupply);

      const shares = await aTokenYieldSource.callStatic.balanceOf(yieldSourceOwner.address);
      const tokens = await sharesToToken(shares, yieldSourceTotalSupply);

      expect(await aTokenYieldSource.callStatic.balanceOfToken(yieldSourceOwner.address)).to.equal(
        tokens,
      );
    });
  });

  describe('_tokenToShares()', () => {
    it('should return shares amount', async () => {
      await aTokenYieldSource.mint(yieldSourceOwner.address, toWei('100'));
      await aTokenYieldSource.mint(wallet2.address, toWei('100'));
      await aToken.mock.balanceOf.withArgs(aTokenYieldSource.address).returns(toWei('1000'));

      expect(await aTokenYieldSource.tokenToShares(toWei('10'))).to.equal(toWei('2'));
    });

    it('should return 0 if tokens param is 0', async () => {
      expect(await aTokenYieldSource.tokenToShares('0')).to.equal('0');
    });

    it('should return tokens if totalSupply is 0', async () => {
      expect(await aTokenYieldSource.tokenToShares(toWei('100'))).to.equal(toWei('100'));
    });

    it('should return shares even if aToken total supply has a lot of decimals', async () => {
      await aTokenYieldSource.mint(yieldSourceOwner.address, toWei('1'));
      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(toWei('0.000000000000000005'));

      expect(await aTokenYieldSource.tokenToShares(toWei('0.000000000000000005'))).to.equal(
        toWei('1'),
      );
    });

    it('should return shares even if aToken total supply increases', async () => {
      await aTokenYieldSource.mint(yieldSourceOwner.address, toWei('100'));
      await aTokenYieldSource.mint(wallet2.address, toWei('100'));
      await aToken.mock.balanceOf.withArgs(aTokenYieldSource.address).returns(toWei('100'));

      expect(await aTokenYieldSource.tokenToShares(toWei('1'))).to.equal(toWei('2'));

      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(ethers.utils.parseUnits('100', 36));
      expect(await aTokenYieldSource.tokenToShares(toWei('1'))).to.equal(2);
    });

    it('should fail to return shares if aToken total supply increases too much', async () => {
      await aTokenYieldSource.mint(yieldSourceOwner.address, toWei('100'));
      await aTokenYieldSource.mint(wallet2.address, toWei('100'));
      await aToken.mock.balanceOf.withArgs(aTokenYieldSource.address).returns(toWei('100'));

      expect(await aTokenYieldSource.tokenToShares(toWei('1'))).to.equal(toWei('2'));

      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(ethers.utils.parseUnits('100', 37));
      await expect(aTokenYieldSource.supplyTokenTo(toWei('1'), wallet2.address)).to.be.revertedWith(
        'ATokenYS/shares-gt-zero',
      );
    });
  });

  describe('_sharesToToken()', () => {
    it('should return tokens amount', async () => {
      await aTokenYieldSource.mint(yieldSourceOwner.address, toWei('100'));
      await aTokenYieldSource.mint(wallet2.address, toWei('100'));
      await aToken.mock.balanceOf.withArgs(aTokenYieldSource.address).returns(toWei('1000'));

      expect(await aTokenYieldSource.sharesToToken(toWei('2'))).to.equal(toWei('10'));
    });

    it('should return shares if totalSupply is 0', async () => {
      expect(await aTokenYieldSource.sharesToToken(toWei('100'))).to.equal(toWei('100'));
    });

    it('should return tokens even if totalSupply has a lot of decimals', async () => {
      await aTokenYieldSource.mint(yieldSourceOwner.address, toWei('0.000000000000000005'));
      await aToken.mock.balanceOf.withArgs(aTokenYieldSource.address).returns(toWei('100'));

      expect(await aTokenYieldSource.sharesToToken(toWei('0.000000000000000005'))).to.equal(
        toWei('100'),
      );
    });

    it('should return tokens even if aToken total supply increases', async () => {
      await aTokenYieldSource.mint(yieldSourceOwner.address, toWei('100'));
      await aTokenYieldSource.mint(wallet2.address, toWei('100'));
      await aToken.mock.balanceOf.withArgs(aTokenYieldSource.address).returns(toWei('100'));

      expect(await aTokenYieldSource.sharesToToken(toWei('2'))).to.equal(toWei('1'));

      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(ethers.utils.parseUnits('100', 36));
      expect(await aTokenYieldSource.sharesToToken(2)).to.equal(toWei('1'));
    });
  });

  describe('supplyTokenTo()', () => {
    let amount: BigNumber;
    let tokenAddress: any;

    beforeEach(async () => {
      amount = toWei('100');
      tokenAddress = await aTokenYieldSource.tokenAddress();
    });

    it('should supply assets if totalSupply is 0', async () => {
      await supplyTokenTo(yieldSourceOwner, amount, amount);
      expect(await aTokenYieldSource.totalSupply()).to.equal(amount);
    });

    it('should supply assets if totalSupply is not 0', async () => {
      await supplyTokenTo(yieldSourceOwner, amount, amount);
      await supplyTokenTo(wallet2, amount, amount.mul(2));
      expect(await aTokenYieldSource.totalSupply()).to.equal(amount.add(amount.div(2)));
    });

    it('should revert on error', async () => {
      await pool.mock.deposit
        .withArgs(tokenAddress, amount, aTokenYieldSource.address, REFERRAL_CODE)
        .reverts();

      await expect(
        aTokenYieldSource.supplyTokenTo(amount, aTokenYieldSource.address),
      ).to.be.revertedWith('');
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
      await supplyTokenTo(yieldSourceOwner, yieldSourceOwnerBalance, yieldSourceOwnerBalance);

      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(yieldSourceOwnerBalance);

      await pool.mock.withdraw
        .withArgs(usdcToken.address, redeemAmount, aTokenYieldSource.address)
        .returns(redeemAmount);

      await aTokenYieldSource.connect(yieldSourceOwner).redeemToken(redeemAmount);

      expect(await aTokenYieldSource.callStatic.balanceOf(yieldSourceOwner.address)).to.equal(
        yieldSourceOwnerBalance.sub(redeemAmount),
      );
    });

    it('should not be able to redeem assets if balance is 0', async () => {
      await expect(
        aTokenYieldSource.connect(yieldSourceOwner).redeemToken(redeemAmount),
      ).to.be.revertedWith('ERC20: burn amount exceeds balance');
    });

    it('should fail to redeem if amount superior to balance', async () => {
      const yieldSourceOwnerLowBalance = toWei('10');

      await aTokenYieldSource.mint(yieldSourceOwner.address, yieldSourceOwnerLowBalance);
      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(yieldSourceOwnerLowBalance);
      await pool.mock.withdraw
        .withArgs(usdcToken.address, redeemAmount, aTokenYieldSource.address)
        .returns(redeemAmount);

      await expect(
        aTokenYieldSource.connect(yieldSourceOwner).redeemToken(redeemAmount),
      ).to.be.revertedWith('ERC20: burn amount exceeds balance');
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
      await expect(aTokenYieldSource.connect(yieldSourceOwner).claimRewards(wallet2.address))
        .to.emit(aTokenYieldSource, 'Claimed')
        .withArgs(yieldSourceOwner.address, wallet2.address, claimAmount);
    });

    it('should claimRewards if assetManager', async () => {
      await aTokenYieldSource.connect(yieldSourceOwner).setManager(wallet2.address);

      await expect(aTokenYieldSource.connect(wallet2).claimRewards(wallet2.address))
        .to.emit(aTokenYieldSource, 'Claimed')
        .withArgs(wallet2.address, wallet2.address, claimAmount);
    });

    it('should fail to claimRewards if recipient is address zero', async () => {
      await expect(
        aTokenYieldSource.connect(yieldSourceOwner).claimRewards(AddressZero),
      ).to.be.revertedWith('ATokenYS/payee-not-zero-address');
    });

    it('should fail to claimRewards if not yieldSourceOwner or assetManager', async () => {
      await expect(
        aTokenYieldSource.connect(wallet2).claimRewards(wallet2.address),
      ).to.be.revertedWith('Manageable/caller-not-manager-or-owner');
    });
  });

  describe('transferERC20()', () => {
    it('should transferERC20 if yieldSourceOwner', async () => {
      const transferAmount = toWei('10');

      await erc20Token.mock.transfer.withArgs(wallet2.address, transferAmount).returns();

      await aTokenYieldSource
        .connect(yieldSourceOwner)
        .transferERC20(erc20Token.address, wallet2.address, transferAmount);
    });

    it('should transferERC20 if assetManager', async () => {
      const transferAmount = toWei('10');

      await erc20Token.mock.transfer.withArgs(yieldSourceOwner.address, transferAmount).returns();

      await aTokenYieldSource.connect(yieldSourceOwner).setManager(wallet2.address);

      await aTokenYieldSource
        .connect(wallet2)
        .transferERC20(erc20Token.address, yieldSourceOwner.address, transferAmount);
    });

    it('should not allow to transfer aToken', async () => {
      await expect(
        aTokenYieldSource
          .connect(yieldSourceOwner)
          .transferERC20(aToken.address, wallet2.address, toWei('10')),
      ).to.be.revertedWith('ATokenYS/forbid-aToken-transfer');
    });

    it('should fail to transferERC20 if not yieldSourceOwner or assetManager', async () => {
      await expect(
        aTokenYieldSource
          .connect(wallet2)
          .transferERC20(erc20Token.address, yieldSourceOwner.address, toWei('10')),
      ).to.be.revertedWith('Manageable/caller-not-manager-or-owner');
    });
  });

  describe('sponsor()', () => {
    let amount: BigNumber;
    let tokenAddress: any;

    beforeEach(async () => {
      amount = toWei('500');
      tokenAddress = await aTokenYieldSource.tokenAddress();
    });

    it('should sponsor Yield Source', async () => {
      const wallet2Amount = toWei('100');

      await supplyTokenTo(wallet2, wallet2Amount, wallet2Amount);

      await pool.mock.supply
        .withArgs(tokenAddress, amount, aTokenYieldSource.address, REFERRAL_CODE)
        .returns();

      await usdcToken.mint(yieldSourceOwner.address, amount);
      await usdcToken.connect(yieldSourceOwner).approve(aTokenYieldSource.address, MaxUint256);

      await aTokenYieldSource.connect(yieldSourceOwner).sponsor(amount);

      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(amount.add(wallet2Amount));

      expect(await aTokenYieldSource.callStatic.balanceOfToken(wallet2.address)).to.equal(
        amount.add(wallet2Amount),
      );
    });

    it('should revert on error', async () => {
      await pool.mock.supply
        .withArgs(tokenAddress, amount, aTokenYieldSource.address, REFERRAL_CODE)
        .reverts();

      await expect(aTokenYieldSource.connect(yieldSourceOwner).sponsor(amount)).to.be.revertedWith(
        '',
      );
    });
  });

  describe('sponsorWithPermit()', () => {
    let amount: BigNumber;
    let tokenAddress: any;
    let signature: any;

    beforeEach(async () => {
      amount = toWei('500');
      tokenAddress = await aTokenYieldSource.tokenAddress();

      signature = await permitSignature({
        permitToken: tokenAddress,
        fromWallet: yieldSourceOwner,
        spender: aTokenYieldSource.address,
        amount,
        provider,
      });
    });

    it('should sponsor Yield Source', async () => {
      const wallet2Amount = toWei('100');

      await supplyTokenTo(wallet2, wallet2Amount, wallet2Amount);

      await pool.mock.supply
        .withArgs(tokenAddress, amount, aTokenYieldSource.address, REFERRAL_CODE)
        .returns();

      await usdcToken.mint(yieldSourceOwner.address, amount);

      await pool.mock.supplyWithPermit
        .withArgs(
          tokenAddress,
          amount,
          aTokenYieldSource.address,
          REFERRAL_CODE,
          signature.deadline,
          signature.v,
          signature.r,
          signature.s,
        )
        .returns();

      await aTokenYieldSource.connect(yieldSourceOwner).sponsorWithPermit(amount, signature);

      await aToken.mock.balanceOf
        .withArgs(aTokenYieldSource.address)
        .returns(amount.add(wallet2Amount));

      expect(await aTokenYieldSource.callStatic.balanceOfToken(wallet2.address)).to.equal(
        amount.add(wallet2Amount),
      );
    });

    it('should revert on error', async () => {
      await pool.mock.supplyWithPermit
        .withArgs(
          tokenAddress,
          amount,
          aTokenYieldSource.address,
          REFERRAL_CODE,
          signature.deadline,
          signature.v,
          signature.r,
          signature.s,
        )
        .reverts();

      await expect(
        aTokenYieldSource.connect(yieldSourceOwner).sponsorWithPermit(amount, signature),
      ).to.be.revertedWith('');
    });
  });

  describe('_poolProvider()', () => {
    it('should return Aave PoolAddressesProvider address', async () => {
      const poolAddressesProviderList =
        await poolAddressesProviderRegistry.getAddressesProvidersList();

      expect(await aTokenYieldSource.poolProvider()).to.equal(poolAddressesProviderList[0]);
    });
  });

  describe('_pool()', () => {
    it('should return Aave Pool address', async () => {
      expect(await aTokenYieldSource.pool()).to.equal(pool.address);
    });
  });
});