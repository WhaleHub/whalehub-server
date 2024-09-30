import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { CreateStakeDto } from './dto/create-stake.dto';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { Balance } from '@/utils/models/interfaces';
import { SorobanService } from './soroban.service';
import { TokenEntity } from '@/utils/typeorm/entities/token.entity';
import { CreateAddLiquidityDto } from './dto/create-add-lp.dto';
import { TreasuryDepositsEntity } from '@/utils/typeorm/entities/treasuryDeposits.entity';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';
import { CreateRemoveLiquidityDto } from './dto/create-remove-lp.dto';
import { stellarAssets } from '@/utils/stellarAssets';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { DepositType } from '@/utils/models/enums';
import { LpBalanceEntity } from '@/utils/typeorm/entities/lp-balances.entity';
import { aquaPools, getPoolKey, parseBufferString } from '@/utils/constants';

const WHLAQUA_CODE = 'WHLAQUA';
export const AQUA_CODE = 'AQUA';
export const AQUA_ISSUER =
  'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA';
export const yXLM_CODE = 'yXLM';
export const yXLM_ISSUER =
  'GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55';

export const ICE_CODE = 'ICE';
export const ICE_ISSUER =
  'GAXSGZ2JM3LNWOO4WRGADISNMWO4HQLG4QBGUZRKH5ZHL3EQBGX73ICE';

export const GOV_ICE_CODE = 'governICE';
export const UP_ICE_CODE = 'upvoteICE';
export const DOWN_ICE_CODE = 'downvoteICE';

export const ICE_ASSETS = [
  `${ICE_CODE}:${ICE_ISSUER}`,
  `${GOV_ICE_CODE}:${ICE_ISSUER}`,
  `${UP_ICE_CODE}:${ICE_ISSUER}`,
  `${DOWN_ICE_CODE}:${ICE_ISSUER}`,
];

@Injectable()
export class StellarService {
  private server: Horizon.Server;
  private issuerKeypair: Keypair;
  private lpSignerKeypair: Keypair;
  private rpcUrl: string;
  private treasureAddress: string;
  private whlAqua: Asset;
  private readonly logger = new Logger(StellarService.name);

  constructor(
    private configService: ConfigService,

    private sorobanService: SorobanService,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,

    @InjectRepository(TokenEntity)
    private tokenRepository: Repository<TokenEntity>,

    @InjectRepository(PoolsEntity)
    private poolRepository: Repository<PoolsEntity>,

    @InjectRepository(LpBalanceEntity)
    private lpBalances: Repository<LpBalanceEntity>,
  ) {
    this.issuerKeypair = Keypair.fromSecret(
      this.configService.get('ISSUER_SECRET_KEY'),
    );
    this.lpSignerKeypair = Keypair.fromSecret(
      this.configService.get('LP_SIGNER_SECRET_KEY'),
    );
    this.rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.server = new Horizon.Server(this.rpcUrl, { allowHttp: true });
    this.whlAqua = new Asset(WHLAQUA_CODE, this.issuerKeypair.publicKey());
    this.treasureAddress = this.configService.get<string>('TREASURE_ADDRESS');
  }

  // async create(createTokenDto: CreateTokenDto): Promise<string> {
  //   try {
  //     const asset = new Asset(createTokenDto.code, createTokenDto.issuer);

  //     const tokenData = await this.tokenRepository.findOneBy({
  //       code: createTokenDto.code,
  //       issuer: createTokenDto.issuer,
  //     });

  //     if (tokenData)
  //       throw new HttpException(
  //         'Asset already created',
  //         HttpStatus.BAD_REQUEST,
  //       );

  //     const user = new UserEntity();
  //     user.account = asset.issuer;
  //     await user.save();

  //     const token = new TokenEntity();
  //     token.code = createTokenDto.code;
  //     token.issuer = this.issuingKeypair.publicKey();
  //     //[x] ensure to deploy token asset contract
  //     token.sacAddress = 'token address';

  //     console.log('token created');

  //     await token.save();

  //     return 'token created';
  //   } catch (err) {
  //     console.log(err);
  //   }
  // }

  async lock(createStakeDto: CreateStakeDto): Promise<void> {
    try {
      // Load the account details
      const account = await this.server.loadAccount(
        this.issuerKeypair.publicKey(),
      );

      // Calculate the amounts to stake and for liquidity
      const amountToLock = createStakeDto.amount * 0.9;
      const additionalAmountForLiquidity = Number(createStakeDto.amount) * 1.1;

      const aquaAmountForPool = Number(createStakeDto.amount) * 0.1;
      const whlAquaAmountForPool = additionalAmountForLiquidity * 0.1;

      //TODO: store this to DB
      const tokenRepresentativeAmountForUser =
        additionalAmountForLiquidity - whlAquaAmountForPool;

      // Create and submit the first transaction for transferring AQUA
      const transferAquaTxn = new Transaction(
        createStakeDto.signedTxXdr,
        Networks.PUBLIC,
      );

      transferAquaTxn.sign(this.issuerKeypair);

      const transferAquaResponse =
        await this.server.submitTransaction(transferAquaTxn);
      const transferAquaHash = transferAquaResponse.hash;
      this.logger.debug(`Transfer AQUA transaction hash: ${transferAquaHash}`);

      // Check if the first transaction was successful
      const depositAquaTransactionResult = await this.checkTransactionStatus(
        this.server,
        transferAquaHash,
      );

      if (!depositAquaTransactionResult.successful) {
        throw new Error('Transfer AQUA transaction failed.');
      }

      // Ensure the user account exists in the database
      let user = await this.userRepository.findOneBy({
        account: createStakeDto.senderPublicKey,
      });

      if (!user) {
        user = new UserEntity();
        user.account = createStakeDto.senderPublicKey;
        await this.userRepository.save(user);
      }

      // Record the stake amount in the database
      const stake = new StakeEntity();
      stake.account = user;
      stake.amount = createStakeDto.amount.toString();
      await stake.save();

      // Record the treasury amount in the database
      // const treasury = new TreasuryDepositsEntity();
      // treasury.account = user;
      // treasury.amount = createStakeDto.treasuryAmount.toString();
      // await treasury
      //   .save()
      //   .then(() =>
      //     this.logger.debug(
      //       `Records saved to treasury address: ${treasury.account}`,
      //     ),
      //   )
      //   .catch((err) => this.logger.error(err));

      // Check existing trustlines
      const existingTrustlines = account.balances.map(
        (balance: Balance) => balance.asset_code,
      );

      //transaction
      const trustlineTransaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      });

      // List of governance assets to check
      const assetsToCheck = [
        { code: ICE_CODE, issuer: ICE_ISSUER },
        { code: GOV_ICE_CODE, issuer: ICE_ISSUER },
        { code: UP_ICE_CODE, issuer: ICE_ISSUER },
        { code: DOWN_ICE_CODE, issuer: ICE_ISSUER },
      ];

      let trustlineOperationAdded = false;

      // Add trustline operations only if they don't already exist
      for (const asset of assetsToCheck) {
        if (!existingTrustlines.includes(asset.code)) {
          trustlineTransaction.addOperation(
            Operation.changeTrust({
              asset: new Asset(asset.code, asset.issuer),
              limit: '1000000000',
            }),
          );
          trustlineOperationAdded = true;
          console.log(`Adding trustline for asset: ${asset.code}`);
        } else {
          console.log(`Trustline for asset ${asset.code} already exists.`);
        }
      }

      if (trustlineOperationAdded) {
        const builtTrustlineTxn = trustlineTransaction.setTimeout(180).build();
        builtTrustlineTxn.sign(this.issuerKeypair);

        const trustlineResponse =
          await this.server.submitTransaction(builtTrustlineTxn);
        const trustlineHash = trustlineResponse.hash;
        await this.checkTransactionStatus(this.server, trustlineHash);
      } else {
        console.log('No new trustline was added.');
      }

      //[x] will be used later
      const unlockTime = Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60; // 2 years in seconds

      // const claimableTransaction = new TransactionBuilder(account, {
      //   fee: BASE_FEE,
      //   networkPassphrase: Networks.PUBLIC,
      // })
      //   .addOperation(
      //     Operation.createClaimableBalance({
      //       claimants: [
      //         new Claimant(
      //           account.accountId(),
      //           //TODO: Ensure to use the correct predicate
      //           Claimant.predicateNot(Claimant.predicateUnconditional()),
      //         ),
      //       ],
      //       asset: new Asset(AQUA_CODE, AQUA_ISSUER),
      //       amount: `${amountToLock}`,
      //     }),
      //   )
      //   .setTimeout(1000)
      //   .build();

      // claimableTransaction.sign(this.issuerKeypair);
      // const claimableResponse =
      //   await this.server.submitTransaction(claimableTransaction);
      // const claimableHash = claimableResponse.hash;
      // console.log('Claimable balance transaction hash:', claimableHash);

      // Check the status of the claimable balance transaction
      // const claimableResult = await this.checkTransactionStatus(
      //   this.server,
      //   claimableHash,
      // );

      // if (!claimableResult.successful) {
      //   throw new Error('Claimable balance transaction failed.');
      // }

      // const operationResult = claimableResult.results[0].value() as any;
      // const createClaimableBalanceResult =
      //   operationResult.createClaimableBalanceResult();

      // let balanceId = createClaimableBalanceResult.balanceId().toXDR('hex');

      // this.logger.debug(
      //   `Claimable balance transaction was successful ID: ${balanceId}`,
      // );

      // const claimableRecord = new ClaimableRecordsEntity();
      // claimableRecord.account = user;
      // claimableRecord.balanceId = balanceId;
      // claimableRecord.amount = createStakeDto.amount.toString();
      // await claimableRecord.save();

      await this.transferAsset(
        this.issuerKeypair,
        this.lpSignerKeypair.publicKey(),
        additionalAmountForLiquidity.toString(),
        this.whlAqua,
      );

      await this.checkBalance(this.lpSignerKeypair.publicKey(), this.whlAqua);

      const assets = [this.whlAqua, new Asset(AQUA_CODE, AQUA_ISSUER)];

      const amounts = new Map<string, string>();
      amounts.set(
        assets[0].code,
        Number(whlAquaAmountForPool).toFixed(7).toString(),
      );
      amounts.set(
        assets[1].code,
        Number(aquaAmountForPool).toFixed(7).toString(),
      );

      //send token to new signer for staking
      await this.sorobanService.depositAQUAWHLHUB(
        assets,
        amounts,
        createStakeDto.senderPublicKey,
        DepositType.LOCKER,
      );

      await this.transferAsset(
        this.issuerKeypair,
        createStakeDto.senderPublicKey,
        `${tokenRepresentativeAmountForUser}`,
        this.whlAqua,
      );
    } catch (err) {
      this.logger.error('Error during staking process:', err.data.extras);
    }
  }

  async checkTransactionStatus(
    server: Horizon.Server,
    hash: string,
  ): Promise<{
    successful: boolean;
    results: StellarSdk.xdr.OperationResult[];
  }> {
    while (true) {
      try {
        const transactionResult = await server
          .transactions()
          .transaction(hash)
          .call();

        if (transactionResult.successful) {
          let txResult = StellarSdk.xdr.TransactionResult.fromXDR(
            transactionResult.result_xdr,
            'base64',
          );

          let results = txResult.result().results();

          return { successful: transactionResult.successful, results };
        } else {
          console.error(
            'Transaction failed. Result:',
            transactionResult.successful,
          );
          return null;
        }
      } catch (error) {
        console.error('Error fetching transaction status:', error);
      }

      // Wait for 5 seconds before retrying
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  async checkBalance(publicKey: string, asset: Asset) {
    const account = await this.server.loadAccount(publicKey);
    const balance = account.balances.find(
      (balance: Balance) =>
        balance.asset_code === asset.code &&
        balance.asset_issuer === asset.issuer,
    );

    if (balance) {
      this.logger.debug(
        `Balance of ${asset.code} for ${publicKey} : ${balance.balance}`,
      );
      return balance.balance;
    } else {
      console.log(`No balance found for ${asset.code}`);
    }
  }

  async transferAsset(
    senderKeypair: Keypair,
    destinationPublicKey: string,
    amount: string,
    asset: Asset,
  ) {
    const senderAccount = await this.server.loadAccount(
      senderKeypair.publicKey(),
    );

    let roundedAmount = Number(amount).toFixed(7);

    const transaction = new TransactionBuilder(senderAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(
        Operation.payment({
          destination: destinationPublicKey,
          asset: asset,
          amount: roundedAmount,
        }),
      )
      .setTimeout(30)
      .build();

    transaction.sign(senderKeypair);

    try {
      const txn = await this.server.submitTransaction(transaction);
      this.logger.debug(`Transfer token successful: ${txn.hash}`);
    } catch (error) {
      this.logger.error(`Transaction failed: ${error.response.data}`);
    }
  }

  public async getAssetDetails(asset: Asset) {
    try {
      const assetRecords = await this.server
        .assets()
        .forCode(asset.code)
        .forIssuer(asset.issuer)
        .call();

      console.log('Asset Details:', assetRecords);
      return assetRecords;
    } catch (error) {
      console.error('Error fetching asset details:', error);
    }
  }

  async addLiquidity(createAddLiquidityDto: CreateAddLiquidityDto) {
    try {
      await this.server.loadAccount(this.lpSignerKeypair.publicKey());

      const transferTxn = new StellarSdk.Transaction(
        createAddLiquidityDto.signedTxXdr,
        Networks.PUBLIC,
      );

      transferTxn.sign(this.issuerKeypair);

      const txn = await this.server.submitTransaction(transferTxn);
      console.log('Transfer transaction hash:', txn.hash);

      await this.checkTransactionStatus(this.server, txn.hash);

      this.sorobanService.addLiquidityTxn(createAddLiquidityDto);
    } catch (err) {
      console.error('Error during staking process:', err);
    }
  }

  async getUser(userPublicKey: string): Promise<UserEntity> {
    try {
      const userRecord = await this.userRepository
        .createQueryBuilder('user')
        .leftJoinAndSelect('user.stakes', 'stakes')
        .leftJoinAndSelect('user.treasurydeposits', 'treasurydeposits')
        .leftJoinAndSelect('user.claimableRecords', 'claimableRecords')
        .leftJoinAndSelect('user.pools', 'pools')
        .leftJoinAndSelect('user.lpBalances', 'lp_balance')
        .addSelect([
          'claimableRecords.id',
          'claimableRecords.balanceId',
          'pools.assetA',
          'pools.assetB',
          'pools.senderPublicKey',
          'pools.assetAAmount',
          'pools.assetBAmount',
          'pools.id',
          'pools.depositType',
          'lp_balance.assetA',
        ])
        .where('user.account = :userPublicKey', { userPublicKey })
        .getOne();

      return userRecord;
    } catch (err) {
      console.log(err);
    }
  }

  async removeLiquidity(removeLiquidityDto: CreateRemoveLiquidityDto) {
    const account = await this.userRepository.findOneBy({
      account: removeLiquidityDto.senderPublicKey,
    });

    const assets = removeLiquidityDto?.summarizedAssets;

    console.log(assets);
  }

  async swapToWhlaqua(amount: number): Promise<number> {
    const assets = [new Asset(AQUA_CODE, AQUA_ISSUER), this.whlAqua];
    const poolId = 'CD4ASKG2XVZRAUXSXPCGUSBIX4JOC2TNA2FDBAPUNJB7RSUG5YGRQRSF';

    // get pool reserves
    const poolReserves = await this.sorobanService.getPoolReserves(
      assets,
      poolId,
    );

    const reserveAqua = parseFloat(poolReserves.get('AQUA'));
    const reserveWhlaqua = parseFloat(poolReserves.get('WHLAQUA'));

    // //estimate swap
    // const estimateAmount = await this.estimateSwap(
    //   reserveAqua,
    //   reserveWhlaqua,
    //   Number(amount),
    // );

    const aquaAddress = this.sorobanService.getAssetContractId(
      new Asset(AQUA_CODE, AQUA_ISSUER),
    );

    const whlAddress = this.sorobanService.getAssetContractId(this.whlAqua);

    this.logger.debug(`AQUA token address: ${aquaAddress}`);
    this.logger.debug(`WHLAQUA token address: ${whlAddress}`);

    const swapAmount = await this.sorobanService.getSwapTx(
      amount,
      poolId,
      assets,
    );

    this.logger.debug(`Swapping ${amount} AQUA to WHLAQUA`);
    return swapAmount;
  }

  async estimateSwap(
    reserveAqua: number,
    reserveWhlaqua: number,
    amountInAqua: number = 10,
  ) {
    if (reserveAqua <= 0 || reserveWhlaqua <= 0 || amountInAqua <= 0) {
      throw new Error('Invalid reserve or input amounts');
    }

    const amountOutWhlaqua =
      (reserveWhlaqua * amountInAqua) / (reserveAqua + amountInAqua);

    return amountOutWhlaqua;
  }

  // @Cron(CronExpression.EVERY_10_SECONDS)
  async redeemLockedAquaRewards() {
    // Fetch all staked whlaqua and aqua records

    const account = await this.server.loadAccount(
      this.lpSignerKeypair.publicKey(),
    );

    const poolRecords = await this.poolRepository.find({
      select: [
        'assetA',
        'assetB',
        'assetAAmount',
        'assetBAmount',
        'poolHash',
        'senderPublicKey',
      ],
      where: { depositType: DepositType.LOCKER },
    });

    if (poolRecords.length === 0) return;

    this.logger.debug('Trying to distribute locked AQUA/WHLAQUA pool rewards');

    let groupedBySender = {};
    let totalPoolPerPairAmount = {};
    let userTotalAmountForAsset = {};
    let totalPoolAmountForAllAssets = 0;
    let totalAquaPoolRewardAmount;
    let lastPoolKey: string;

    // Iterate over pool records to group data
    for (const record of poolRecords) {
      const {
        senderPublicKey,
        assetA: a,
        assetB: b,
        assetAAmount,
        assetBAmount,
      } = record;

      const assetA = new Asset(a.code, a.issuer);
      const assetB = new Asset(b.code, b.issuer);
      const assets = [assetA, assetB].sort();
      const poolKey = getPoolKey(assets[0], assets[1]);
      lastPoolKey = poolKey;

      const aquaPool = await this.sorobanService.getPools(assets);
      if (aquaPool.length <= 0) continue; // skip if no pool

      const poolAddresses = aquaPools[poolKey];
      totalAquaPoolRewardAmount = await this.sorobanService.getPoolRewards(
        account.accountId(),
        poolAddresses.poolHash,
      );
      totalAquaPoolRewardAmount.to_claim = 4;

      const assetAValue = parseFloat(assetAAmount);
      const assetBValue = parseFloat(assetBAmount);

      // Update totals
      totalPoolPerPairAmount[poolKey] = totalPoolPerPairAmount[poolKey] || {
        assetA: 0,
        assetB: 0,
      };
      groupedBySender[senderPublicKey] = groupedBySender[senderPublicKey] || {};
      groupedBySender[senderPublicKey][poolKey] =
        groupedBySender[senderPublicKey][poolKey] || [];
      userTotalAmountForAsset[senderPublicKey] =
        userTotalAmountForAsset[senderPublicKey] || {};
      userTotalAmountForAsset[senderPublicKey][poolKey] =
        userTotalAmountForAsset[senderPublicKey][poolKey] || {
          assetA: 0,
          assetB: 0,
          total: 0,
        };

      userTotalAmountForAsset[senderPublicKey][poolKey].assetA += assetAValue;
      userTotalAmountForAsset[senderPublicKey][poolKey].assetB += assetBValue;
      userTotalAmountForAsset[senderPublicKey][poolKey].total = (
        userTotalAmountForAsset[senderPublicKey][poolKey].assetA +
        userTotalAmountForAsset[senderPublicKey][poolKey].assetB
      ).toFixed(7);

      groupedBySender[senderPublicKey][poolKey].push(record);

      totalPoolPerPairAmount[poolKey].assetA += assetAValue;
      totalPoolPerPairAmount[poolKey].assetB += assetBValue;
    }

    // Calculate total pool for each pair
    Object.keys(totalPoolPerPairAmount).forEach((pair) => {
      const { assetA, assetB } = totalPoolPerPairAmount[pair];
      totalPoolAmountForAllAssets += assetA + assetB;
      totalPoolPerPairAmount[pair] = (assetA + assetB).toFixed(7);
    });

    // Claim rewards for the pool (once)
    const to_claim = totalAquaPoolRewardAmount.to_claim; // Assume this was fetched earlier
    // if (to_claim < 25000) return;
    // return;
    //TODO: get asset using the code
    const assets = lastPoolKey
      .split(':')
      .map((code) =>
        code === 'XLM' ? Asset.native() : new Asset(code, AQUA_ISSUER),
      ) as Asset[];

    const rewardClaimed = await this.sorobanService.claimLockReward(
      assets,
      account.accountId(),
    );

    this.logger.debug('Rewards claimed, proceeding with swap');
    const poolAddresses = aquaPools[lastPoolKey];

    // Swap AQUA to WHLAQUA
    const swappedAmount = await this.swapToWhlaqua(rewardClaimed);

    this.logger.debug(
      `Swapped AQUA to WHLAQUA, total swapped amount: ${swappedAmount}`,
    );

    Object.entries(userTotalAmountForAsset).map(([userPublicKey, assetPairs]) =>
      Promise.all(
        Object.entries(assetPairs).map(async ([pair, userPairData]) => {
          const totalPoolForPair = totalPoolPerPairAmount[pair] || 0;
          if (totalPoolForPair === 0) return;

          const userClaimAmount = parseFloat(userPairData.total);
          if (swappedAmount === 0) return;

          const poolAddresses = aquaPools[pair];

          // Calculate the user's percentage of the total claimable amount
          const userPercentage = (userClaimAmount / swappedAmount) * 100;

          // Convert percentage to decimal
          const userPercentageDecimal = userPercentage / 100;

          const userShare = (userPercentageDecimal * swappedAmount).toFixed(7);

          console.log({ userShare, swappedAmount, userPercentage });

          // [x] Swap AQUA to WHLAQUA (you can add the swap logic here)
          await this.transferAsset(
            this.lpSignerKeypair,
            userPublicKey,
            userShare,
            this.whlAqua,
          );
        }),
      ),
    );

    this.logger.log('All transactions have been processed');
  }

  // @Cron(CronExpression.EVERY_10_SECONDS)
  async redeemLPRewards() {
    // Fetch all staked whlaqua and aqua records
    const poolRecords = await this.poolRepository.find({
      select: [
        'assetA',
        'assetB',
        'assetAAmount',
        'assetBAmount',
        'poolHash',
        'senderPublicKey',
      ],
      where: { depositType: DepositType.LIQUIDITY_PROVISION },
    });

    if (poolRecords.length === 0) return;

    // this.signerKeypair.publicKey(),
    const account = await this.server.loadAccount(
      this.lpSignerKeypair.publicKey(),
    );

    this.logger.debug('Trying to distribute locked AQUA/WHLAQUA LP rewards');

    let groupedBySender = {};
    let totalPoolPerPairAmount = {};
    let userTotalAmountForAsset = {};
    let totalPoolAmountForAllAssets = 0;
    let totalAquaPoolRewardAmount;
    let lastPoolKey: string;

    for (const record of poolRecords) {
      const {
        senderPublicKey,
        assetA: a,
        assetB: b,
        assetAAmount,
        assetBAmount,
      } = record;

      const assetA = new Asset(a.code, a.issuer);
      const assetB = new Asset(b.code, b.issuer);
      const assets = [assetA, assetB].sort();
      const poolKey = getPoolKey(assets[0], assets[1]);
      lastPoolKey = poolKey;

      const aquaPool = await this.sorobanService.getPools(assets);
      if (aquaPool.length <= 0) continue; // skip if no pool

      const poolAddresses = aquaPools[poolKey];
      totalAquaPoolRewardAmount = await this.sorobanService.getPoolRewards(
        account.accountId(),
        poolAddresses.poolHash,
      );

      // totalAquaPoolRewardAmount.to_claim = 4;

      const assetAValue = parseFloat(assetAAmount);
      const assetBValue = parseFloat(assetBAmount);

      // Update totals
      totalPoolPerPairAmount[poolKey] = totalPoolPerPairAmount[poolKey] || {
        assetA: 0,
        assetB: 0,
      };

      groupedBySender[senderPublicKey] = groupedBySender[senderPublicKey] || {};
      groupedBySender[senderPublicKey][poolKey] =
        groupedBySender[senderPublicKey][poolKey] || [];
      userTotalAmountForAsset[senderPublicKey] =
        userTotalAmountForAsset[senderPublicKey] || {};
      userTotalAmountForAsset[senderPublicKey][poolKey] =
        userTotalAmountForAsset[senderPublicKey][poolKey] || {
          assetA: 0,
          assetB: 0,
          total: 0,
        };
      userTotalAmountForAsset[senderPublicKey][poolKey].assetA += assetAValue;
      userTotalAmountForAsset[senderPublicKey][poolKey].assetB += assetBValue;
      userTotalAmountForAsset[senderPublicKey][poolKey].total = (
        userTotalAmountForAsset[senderPublicKey][poolKey].assetA +
        userTotalAmountForAsset[senderPublicKey][poolKey].assetB
      ).toFixed(7);

      groupedBySender[senderPublicKey][poolKey].push(record);

      totalPoolPerPairAmount[poolKey].assetA += assetAValue;
      totalPoolPerPairAmount[poolKey].assetB += assetBValue;
    }

    // Calculate total pool for each pair
    Object.keys(totalPoolPerPairAmount).forEach((pair) => {
      const { assetA, assetB } = totalPoolPerPairAmount[pair];
      totalPoolAmountForAllAssets += assetA + assetB;
      totalPoolPerPairAmount[pair] = (assetA + assetB).toFixed(7);
    });

    // Claim rewards for the pool (once)
    const to_claim = totalAquaPoolRewardAmount.to_claim;
    // if (to_claim < 25000) return;

    //TODO: get asset using the code
    const assets = lastPoolKey
      .split(':')
      .map((code) =>
        code === 'XLM' ? Asset.native() : new Asset(code, AQUA_ISSUER),
      ) as Asset[];

    const rewardAmount = await this.sorobanService.claimLPReward(
      assets,
      account.accountId(),
    );

    this.logger.debug('Rewards claimed, proceeding with swap');

    const poolAddresses = aquaPools[lastPoolKey];

    //TODO: update with the the rewardAmount
    const distributionAmount = Number(10 * 0.7).toFixed(7);
    const treasuryAmount = Number(10 * 0.3).toFixed(7);

    // Swap AQUA(Rewards) to WHLAQUA
    const swappedAmount = await this.swapToWhlaqua(1);

    this.logger.debug(
      `Swapped AQUA to WHLAQUA, total swapped amount: ${swappedAmount}`,
    );

    Object.entries(userTotalAmountForAsset).map(([userPublicKey, assetPairs]) =>
      Promise.all(
        Object.entries(assetPairs).map(async ([pair, userPairData]) => {
          const totalPoolForPair = totalPoolPerPairAmount[pair] || 0;
          if (totalPoolForPair === 0) return;

          const userClaimAmount = parseFloat(userPairData.total);
          if (swappedAmount === 0) return; // Avoid division by zero

          const poolAddresses = aquaPools[pair];

          // Calculate the user's percentage of the total claimable amount
          const userPercentage = (userClaimAmount / swappedAmount) * 100;

          // Convert percentage to decimal
          const userPercentageDecimal = userPercentage / 100;

          const userShare = (userPercentageDecimal * swappedAmount).toFixed(7);

          console.log({ userShare, swappedAmount, userPercentage });

          // await this.transferAsset(
          //   this.signerKeypair,
          //   userPublicKey,
          //   userShare,
          //   this.whlAqua,
          // );
        }),
      ),
    );

    //TODO: transfer amount to treasury
    return;
    await this.transferAsset(
      this.lpSignerKeypair,
      this.lpSignerKeypair.publicKey(),
      treasuryAmount,
      new Asset(AQUA_CODE, AQUA_ISSUER),
    );

    this.logger.log('All transactions have been processed');
  }

  //@Cron(CronExpression.EVERY_WEEK)
  // @Cron(CronExpression.EVERY_10_SECONDS)
  async redeemAquaRewardsForICE() {
    // Ensure AQUA pools can claim rewards

    // Fetch all staked whlaqua and aqua records
    const poolRecords = await this.poolRepository.find({
      select: [
        'assetA',
        'assetB',
        'assetAAmount',
        'assetBAmount',
        'poolHash',
        'senderPublicKey',
      ],
      where: { depositType: DepositType.LOCKER },
    });

    if (poolRecords.length === 0) return;

    const account = await this.server.loadAccount(
      this.lpSignerKeypair.publicKey(),
    );

    this.logger.debug('Trying to distribute locked AQUA/WHLAQUA pool rewards');

    let groupedBySender = {};
    let totalPoolPerPairAmount = {};
    let userTotalAmountForAsset = {};
    let totalPoolAmountForAllAssets = 0;
    let to_claim = 0;

    for (const record of poolRecords) {
      const {
        senderPublicKey,
        assetA: a,
        assetB: b,
        assetAAmount,
        assetBAmount,
      } = record;

      const assetA = new Asset(a.code, a.issuer);
      const assetB = new Asset(b.code, b.issuer);
      const assets = [Asset.native(), assetB].sort();
      const poolKey = getPoolKey(assets[0], assets[1]);

      const aquaPool = await this.sorobanService.getPools(assets);
      if (aquaPool.length <= 0) continue; // skip if no pool

      const poolAddresses = aquaPools[poolKey];
      const totalAquaPoolRewardAmount =
        await this.sorobanService.getPoolRewards(
          account.accountId(),
          poolAddresses.poolHash,
        );

      to_claim = totalAquaPoolRewardAmount.to_claim;

      const assetAValue = parseFloat(assetAAmount);
      const assetBValue = parseFloat(assetBAmount);

      // Update totals
      totalPoolPerPairAmount[poolKey] = totalPoolPerPairAmount[poolKey] || {
        assetA: 0,
        assetB: 0,
      };
      groupedBySender[senderPublicKey] = groupedBySender[senderPublicKey] || {};
      groupedBySender[senderPublicKey][poolKey] =
        groupedBySender[senderPublicKey][poolKey] || [];
      userTotalAmountForAsset[senderPublicKey] =
        userTotalAmountForAsset[senderPublicKey] || {};
      userTotalAmountForAsset[senderPublicKey][poolKey] =
        userTotalAmountForAsset[senderPublicKey][poolKey] || {
          assetA: 0,
          assetB: 0,
          total: 0,
        };

      userTotalAmountForAsset[senderPublicKey][poolKey].assetA += assetAValue;
      userTotalAmountForAsset[senderPublicKey][poolKey].assetB += assetBValue;
      userTotalAmountForAsset[senderPublicKey][poolKey].total = (
        userTotalAmountForAsset[senderPublicKey][poolKey].assetA +
        userTotalAmountForAsset[senderPublicKey][poolKey].assetB
      ).toFixed(7);

      groupedBySender[senderPublicKey][poolKey].push(record);

      totalPoolPerPairAmount[poolKey].assetA += assetAValue;
      totalPoolPerPairAmount[poolKey].assetB += assetBValue;
    }

    // Calculate total pool for each pair
    Object.keys(totalPoolPerPairAmount).forEach((pair) => {
      const { assetA, assetB } = totalPoolPerPairAmount[pair];
      totalPoolAmountForAllAssets += assetA + assetB;
      totalPoolPerPairAmount[pair] = (assetA + assetB).toFixed(7);
    });

    // if (to_claim < 25000) return;

    // Execute all reward claims in parallel and wait for completion
    const rewardPromises = Object.entries(userTotalAmountForAsset).map(
      ([userPublicKey, assetPairs]) =>
        Promise.all(
          Object.entries(assetPairs).map(async ([pair, userPairData]) => {
            const totalPoolForPair = totalPoolPerPairAmount[pair] || 0;
            if (totalPoolForPair === 0) return;

            const userClaimAmount = userPairData.total;

            const poolAddresses = aquaPools[pair];

            await this.sorobanService.claimLockReward(
              [Asset.native(), new Asset(AQUA_CODE, AQUA_ISSUER)],
              account.accountId(),
            );

            console.log(userClaimAmount);
          }),
        ),
    );

    // Wait for all reward claims to complete
    await Promise.all(rewardPromises);

    this.logger.log('All transactions have been processed');
  }
}
