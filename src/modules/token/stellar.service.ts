import { Injectable, Logger } from '@nestjs/common';
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
  private issuingSecret: string;
  private signerSecret: string;
  private issuingKeypair: Keypair;
  private signerKeypair: Keypair;
  private rpcUrl: string;
  whlAqua: Asset;

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
    this.issuingSecret = this.configService.get<string>(
      'SOROBAN_ISSUER_SECRET_KEY',
    );
    this.signerSecret = this.configService.get<string>(
      'SOROBAN_SIGNER_SECRET_KEY',
    );
    this.rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.server = new Horizon.Server(this.rpcUrl, { allowHttp: true });

    this.issuingKeypair = Keypair.fromSecret(this.issuingSecret);
    this.signerKeypair = Keypair.fromSecret(this.signerSecret);

    this.whlAqua = new Asset(WHLAQUA_CODE, this.issuingKeypair.publicKey());
  }

  async create(createTokenDto: CreateTokenDto): Promise<string> {
    try {
      const asset = new Asset(createTokenDto.code, createTokenDto.issuer);

      const tokenData = await this.tokenRepository.findOneBy({
        code: createTokenDto.code,
        issuer: createTokenDto.issuer,
      });

      //[x] should throw an error
      if (tokenData) return;

      const user = new UserEntity();
      user.account = asset.issuer;
      await user.save();

      const token = new TokenEntity();
      token.code = createTokenDto.code;
      token.issuer = this.issuingKeypair.publicKey();
      //[x] ensure to deploy token asset contract
      token.sacAddress = 'token address';

      console.log('token created');

      await token.save();

      return 'token created';
    } catch (err) {
      console.log(err);
    }
  }

  async lock(createStakeDto: CreateStakeDto): Promise<void> {
    try {
      // gets pool fees
      // const getFeeInfos = Promise.all([
      //   this.getCreationFeeToken(),
      //   this.getCreationFee(POOL_TYPE.constant),
      //   this.getCreationFee(POOL_TYPE.stable),
      // ]).then(([token, constantFee, stableFee]) => ({
      //   token,
      //   constantFee,
      //   stableFee,
      // }));

      // const feeInfos = await getFeeInfos;

      // Load the account details
      const account = await this.server.loadAccount(
        this.issuingKeypair.publicKey(),
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

      transferAquaTxn.sign(this.issuingKeypair);

      const transferAquaResponse =
        await this.server.submitTransaction(transferAquaTxn);
      const transferAquaHash = transferAquaResponse.hash;
      console.log('Transfer AQUA transaction hash:', transferAquaHash);

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
      const stakeRecordDB = await stake.save();

      // Record the treasury amount in the database
      const treasury = new TreasuryDepositsEntity();
      treasury.account = user;
      treasury.amount = createStakeDto.treasuryAmount.toString();
      // await treasury.save();

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
        builtTrustlineTxn.sign(this.issuingKeypair);

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

      // claimableTransaction.sign(this.issuingKeypair);
      // const claimableResponse =
      //   await this.server.submitTransaction(claimableTransaction);
      // const claimableHash = claimableResponse.hash;
      // console.log('Claimable balance transaction hash:', claimableHash);

      // // Check the status of the claimable balance transaction
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

      // console.log('Balance ID:', balanceId);
      // console.log('Claimable balance transaction was successful.');

      // const claimableRecord = new ClaimableRecordsEntity();
      // claimableRecord.account = user;
      // claimableRecord.balanceId = balanceId;
      // claimableRecord.amount = createStakeDto.amount.toString();
      // await claimableRecord.save();

      await this.transferAsset(
        this.issuingKeypair,
        this.signerKeypair.publicKey(),
        additionalAmountForLiquidity.toString(),
        this.whlAqua,
      );

      await this.checkBalance(this.signerKeypair.publicKey(), this.whlAqua);

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
        this.issuingKeypair,
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
      console.log(`Balance of ${asset.code}: ${balance.balance}`);
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
      console.log(`Transfer token tracker successful: `, txn.hash);
    } catch (error) {
      console.error('Transaction failed:', error.response.data);
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
      // await this.server.loadAccount(this.signerKeypair.publicKey());

      // const transferTxn = new StellarSdk.Transaction(
      //   createAddLiquidityDto.signedTxXdr,
      //   Networks.PUBLIC,
      // );

      // transferTxn.sign(this.issuingKeypair);

      // const txn = await this.server.submitTransaction(transferTxn);
      // console.log('Transfer transaction hash:', txn.hash);

      // await this.checkTransactionStatus(this.server, txn.hash);

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

  //[x] UPDATE TO RUN WEEKLY
  @Cron(CronExpression.EVERY_10_SECONDS)
  async redeemAquaRewardsForICE() {
    //[x] fetch all staked whlaqua and aqua records
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
    //[x] so far a user still has ice locked this will run every week.
    this.logger.debug('Trying to distribute locked AQUA/WHLAQUA pool rewards');

    const totalPoolPerPairAmount = {};
    const groupedBySender = {};
    const userTotalAmountForAsset = {};
    let totalPoolAmountForAllAssets = 0;

    poolRecords.forEach((record) => {
      const { senderPublicKey, assetA, assetB, assetAAmount, assetBAmount } =
        record;

      // Create a unique asset pair key, regardless of the order of assetA and assetB
      const assetPair = [assetA.code, assetB.code].sort().join(':');

      // Ensure assets values are changed to numbers
      const assetAValue = parseFloat(assetAAmount);
      const assetBValue = parseFloat(assetBAmount);

      // Initialize the total amount for the asset pair if it doesn't exist
      if (!totalPoolPerPairAmount[assetPair]) {
        totalPoolPerPairAmount[assetPair] = { assetA: 0, assetB: 0 };
      }

      // Initialize the sender's record if it doesn't exist
      if (!groupedBySender[senderPublicKey]) {
        groupedBySender[senderPublicKey] = {};
      }

      // Initialize the sender's asset pair if it doesn't exist
      if (!groupedBySender[senderPublicKey][assetPair]) {
        groupedBySender[senderPublicKey][assetPair] = [];
      }

      // Initialize userTotalAmountForAsset if it doesn't exist for this sender
      if (!userTotalAmountForAsset[senderPublicKey]) {
        userTotalAmountForAsset[senderPublicKey] = {};
      }

      if (!userTotalAmountForAsset[senderPublicKey][assetPair]) {
        userTotalAmountForAsset[senderPublicKey][assetPair] = {
          assetA: 0,
          assetB: 0,
          total: 0,
        };
      }

      // Update user's total amount for the asset pair
      userTotalAmountForAsset[senderPublicKey][assetPair].assetA += assetAValue;
      userTotalAmountForAsset[senderPublicKey][assetPair].assetB += assetAValue;

      // Calculate the total (sum of assetA and assetB) for the user
      userTotalAmountForAsset[senderPublicKey][assetPair].total =
        userTotalAmountForAsset[senderPublicKey][assetPair].assetA +
        userTotalAmountForAsset[senderPublicKey][assetPair].assetB;

      // Add the record to the sender's grouped records
      groupedBySender[senderPublicKey][assetPair].push(record);

      // Add the amounts of assetA and assetB to the total amount for this asset pair
      totalPoolPerPairAmount[assetPair].assetA += assetAValue;
      totalPoolPerPairAmount[assetPair].assetB += assetBValue;
    });

    // Calculate the total pool amount for each asset pair (sum of assetA + assetB)
    Object.keys(totalPoolPerPairAmount).forEach((pair) => {
      const { assetA, assetB } = totalPoolPerPairAmount[pair];
      const sum = assetA + assetB;

      totalPoolAmountForAllAssets += sum;

      totalPoolPerPairAmount[pair] = sum.toFixed(7);
    });

    // Log outputs for verification
    console.log('Grouped by Sender:', groupedBySender);
    console.log('User Total Amount for Asset:', userTotalAmountForAsset);
    console.log('Total Pool Amount per Pair:', totalPoolPerPairAmount);

    //[x] Ensure AQUA pools can claim rewards
    //[x] fetch all lp_balances for the pool
    //[x] calculate each user percentage
    //[x] get pool aqua reward
    //[x] swap pool reward to JWLAQUA
    //[x] withdraw to sponsor wallet
    //[x] distribute rewards based on user percentage(s)
    // this.logger.debug('Distributed locked AQUA/WHLAQUA pool rewards');
  }

  async redeemRewardPoolRewards() {
    // try {
    //   const account = await this.server.loadAccount(
    //     redeemRewardDto.senderPublicKey,
    //   );
    //   const summarizedAssets = redeemRewardDto.summarizedAssets;
    //   const extractedAssets = {};
    //   for (const assetCode in summarizedAssets) {
    //     if (stellarAssets[assetCode]) {
    //       extractedAssets[assetCode] = stellarAssets[assetCode];
    //     }
    //   }
    //   const assets = Object.values(extractedAssets) as Asset[];
    //   await this.sorobanService.claimReward(
    //     assets,
    //     redeemRewardDto.senderPublicKey,
    //   );
    // } catch (err) {
    //   console.log('Error redeeming: ', err);
    // }
  }

  async fetchStakedForTwoAssets(poolRecords: PoolsEntity[]) {}
}
