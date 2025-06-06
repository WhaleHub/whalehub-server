import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { CreateStakeDto } from './dto/create-stake.dto';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { Balance } from '@/utils/models/interfaces';
import { SorobanService } from './soroban.service';
import { CreateAddLiquidityDto } from './dto/create-add-lp.dto';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';
import { UnlockAquaDto } from './dto/create-remove-lp.dto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { CLAIMS, DepositType } from '@/utils/models/enums';
import { aquaPools, getPoolKey } from '@/utils/constants';
import { StakeBlubDto } from './dto/stake-blub.dto';

const BLUB_CODE = 'BLUB';
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
  public issuerKeypair: Keypair;
  public lpSignerKeypair: Keypair;
  private rpcUrl: string;
  private signerKeyPair: Keypair;
  private treasureAddress: string;
  private blub: Asset;
  private readonly logger = new Logger(StellarService.name);

  constructor(
    private configService: ConfigService,

    private sorobanService: SorobanService,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,

    @InjectRepository(PoolsEntity)
    private poolRepository: Repository<PoolsEntity>,

    @InjectRepository(ClaimableRecordsEntity)
    private claimableRecords: Repository<ClaimableRecordsEntity>,
  ) {
    this.issuerKeypair = Keypair.fromSecret(
      this.configService.get('ISSUER_SECRET_KEY'),
    );
    this.lpSignerKeypair = Keypair.fromSecret(
      this.configService.get('LP_SIGNER_SECRET_KEY'),
    );
    this.rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.server = new Horizon.Server(this.rpcUrl, { allowHttp: true });
    this.blub = new Asset(BLUB_CODE, this.issuerKeypair.publicKey());
    this.treasureAddress = this.configService.get<string>('TREASURE_ADDRESS');
    this.signerKeyPair = Keypair.fromSecret(
      this.configService.get('SIGNER_SECRET_KEY'),
    );
  }

  async lock(createStakeDto: CreateStakeDto): Promise<void> {
    try {
      // Load the account details
      await this.server.loadAccount(this.issuerKeypair.publicKey());

      const signerAccount = await this.server.loadAccount(
        this.signerKeyPair.publicKey(),
      );

      // Calculate the amounts to stake and for liquidity
      const amountToLock = Number((createStakeDto.amount * 0.9).toFixed(7));
      const additionalAmountForLiquidity = Number(
        (createStakeDto.amount * 1.0).toFixed(7),
      );
      this.logger.debug(
        `Starting to add to lock: ${amountToLock} and ${additionalAmountForLiquidity}`,
      );
      const aquaAmountForPool = createStakeDto.amount * 0.1;
      const BlubAmountForPool = additionalAmountForLiquidity * 0.1;

      // Create and submit the first transaction for transferring AQUA
      const transferAquaTxn = new Transaction(
        createStakeDto.signedTxXdr,
        Networks.PUBLIC,
      );

      try {
        const transferAquaResponse =
          await this.server.submitTransaction(transferAquaTxn);
        const transferAquaHash = transferAquaResponse.hash;
        this.logger.debug(
          `Transfer AQUA transaction hash: ${transferAquaHash}`,
        );

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
        await stake
          .save()
          .then(() =>
            this.logger.debug(`Saved stake amount: ${stake.amount} to db`),
          );

        // Check existing trustlines
        const existingTrustlines = signerAccount.balances.map(
          (balance: Balance) => balance.asset_code,
        );

        //transaction
        const trustlineTransaction = new TransactionBuilder(signerAccount, {
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
          const builtTrustlineTxn = trustlineTransaction
            .setTimeout(180)
            .build();
          builtTrustlineTxn.sign(this.signerKeyPair);

          const trustlineResponse =
            await this.server.submitTransaction(builtTrustlineTxn);
          const trustlineHash = trustlineResponse.hash;
          const status = await this.checkTransactionStatus(
            this.server,
            trustlineHash,
          );
          console.log(`trustlineOperationAdded`);
          console.log(`trustlineOperationAdded`, status);
        } else {
          console.log('No new trustline was added.');
        }

        const unlockTime =
          Math.floor(Date.now() / 1000) + 2 * 365 * 24 * 60 * 60; //2 years

        const claimableTransaction = new TransactionBuilder(signerAccount, {
          fee: BASE_FEE,
          networkPassphrase: Networks.PUBLIC,
        })
          .addOperation(
            Operation.createClaimableBalance({
              claimants: [
                new Claimant(
                  signerAccount.accountId(),
                  Claimant.predicateAnd(
                    Claimant.predicateNot(Claimant.predicateUnconditional()),
                    Claimant.predicateBeforeAbsoluteTime(unlockTime.toString()),
                  ),
                ),
              ],
              asset: new Asset(AQUA_CODE, AQUA_ISSUER),
              amount: `${amountToLock}`,
            }),
          )
          .setTimeout(5000)
          .build();

        claimableTransaction.sign(this.signerKeyPair);
        try {
          this.logger.debug(`starting to deposit`);
          this.logger.debug(this.signerKeyPair.publicKey());
          const claimableResponse =
            await this.server.submitTransaction(claimableTransaction);
          this.logger.debug(claimableResponse);

          const claimableHash = claimableResponse.hash;
          this.logger.debug(
            `Claimable balance transaction hash: ${claimableHash}`,
          );

          // Check the status of the claimable balance transaction
          const claimableResult = await this.checkTransactionStatus(
            this.server,
            claimableHash,
          );

          if (!claimableResult.successful) {
            throw new Error('Claimable balance transaction failed.');
          }

          const operationResult = claimableResult.results[0].value() as any;
          const createClaimableBalanceResult =
            operationResult.createClaimableBalanceResult();

          let balanceId = createClaimableBalanceResult.balanceId().toXDR('hex');

          this.logger.debug(
            `Claimable balance transaction was successful ID: ${balanceId}`,
          );

          const claimableRecord = new ClaimableRecordsEntity();
          claimableRecord.account = user;
          claimableRecord.balanceId = balanceId;
          //here need to set a full amount, not 90%
          //claimableRecord.amount = amountToLock;
          claimableRecord.amount = createStakeDto.amount.toString();
          try {
            this.logger.debug(`Trying to to save claimableRecord:`);
            await claimableRecord.save();
          } catch (e) {
            this.logger.debug(`Failed to save claimableRecord: ${e}`);
          }

          this.logger.debug(
            `Successfully transferred asset to lp public key: ${this.signerKeyPair.publicKey()}`,
          );

          await this.checkBalance(this.signerKeyPair.publicKey(), this.blub);

          const assets = [this.blub, new Asset(AQUA_CODE, AQUA_ISSUER)];

          const amounts = new Map<string, string>();
          const amountA = Number(BlubAmountForPool.toFixed(7)).toString();
          const amountB = Number(aquaAmountForPool.toFixed(7)).toString();
          this.logger.debug(
            `Starting to add to pool: ${amountA} and ${amountB}`,
          );
          amounts.set(assets[0].code, amountA);
          amounts.set(assets[1].code, amountB);

          //send token to new signer for staking
          const sourceAccount = await this.server.loadAccount(
            this.issuerKeypair.publicKey(),
          );
          const transaction = new TransactionBuilder(sourceAccount, {
            fee: BASE_FEE,
            networkPassphrase: Networks.PUBLIC,
          })
            .addOperation(
              Operation.payment({
                destination: this.signerKeyPair.publicKey(),
                asset: this.blub,
                amount: amountA,
              }),
            )
            .setTimeout(30)
            .build();

          transaction.sign(this.issuerKeypair);

          const responseOfSendingBlub =
            await this.server.submitTransaction(transaction);

          this.logger.debug(
            `Successfully transferred blub asset : ${responseOfSendingBlub}`,
          );

          await this.sorobanService.depositAQUABlUB(
            assets,
            amounts,
            createStakeDto.senderPublicKey,
            DepositType.LOCKER,
          );
        } catch (err) {
          console.log(err);
          this.logger.error(
            'Error during staking process:',
            err?.data?.extras || err?.data || err?.message || err,
          );
        }
      } catch (err) {
        console.log(err);
        this.logger.error(
          'Error during staking process:',
          err?.data?.extras || err?.data || err?.message || err,
        );
      }
    } catch (err) {
      console.log(err);
      this.logger.error(
        'Error during staking process:',
        err?.data?.extras || err?.data || err?.message || err,
      );
    }
  }

  async stakeBlub(stakeBlubDto: StakeBlubDto): Promise<void> {
    try {
      await this.server.loadAccount(this.issuerKeypair.publicKey());

      const signerAccount = await this.server.loadAccount(
        this.issuerKeypair.publicKey(),
      );

      let user = await this.userRepository.findOneBy({
        account: stakeBlubDto.senderPublicKey,
      });

      const transferBlubTxn = new Transaction(
        stakeBlubDto.signedTxXdr,
        Networks.PUBLIC,
      );

      const txn = await this.server.submitTransaction(transferBlubTxn);
      const transferBlubHash = txn.hash;
      this.logger.debug(`Transfer BLUB transaction hash: ${transferBlubHash}`);

      // const claimableRecords = await this.claimableRecords.find({
      //   where: {
      //     claimed: CLAIMS.UNCLAIMED,
      //     account: { account: stakeBlubDto.senderPublicKey },
      //   },
      //   relations: ['account'],
      //   take: 1,
      // });

      const claimableRecords = await this.claimableRecords.find({
        where: {
          // claimed: CLAIMS.UNCLAIMED,
          account: { account: stakeBlubDto.senderPublicKey },
        },
        relations: ['account'],
        take: 1,
      });

      if (claimableRecords.length === 0) {
        throw new HttpException(
          'No unclaimed records found',
          HttpStatus.NOT_FOUND,
        );
      }

      const claimableRecord = claimableRecords[0];
      console.log(claimableRecords);

      const currentAmount = Number(claimableRecord.amount);
      const updatedAmount = currentAmount + Number(stakeBlubDto.amount);

      claimableRecord.amount = `${updatedAmount.toFixed(7)}`;
      //need to add this to work with unclaimed;
      claimableRecord.claimed = CLAIMS.UNCLAIMED;

      await this.claimableRecords.save(claimableRecord);

      this.logger.debug(`Record updated. New amount: ${updatedAmount}`);

      if (!user)
        throw new HttpException('Account not found', HttpStatus.FORBIDDEN);
    } catch (err) {
      console.log(err);
    }
  }

  async checkTransactionStatus(
    server: Horizon.Server,
    hash: string,
  ): Promise<{
    successful: boolean;
    results: xdr.OperationResult[];
  }> {
    while (true) {
      try {
        const transactionResult = await server
          .transactions()
          .transaction(hash)
          .call();

        if (transactionResult.successful) {
          let txResult = xdr.TransactionResult.fromXDR(
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
      console.log(error);
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

      const transferTxn = new Transaction(
        createAddLiquidityDto.signedTxXdr,
        Networks.PUBLIC,
      );

      //must sign with issuer
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

  async getPublicKeyLockedRewards(userPublicKey: string): Promise<any> {
    const user = await this.userRepository.findOneBy({
      account: userPublicKey,
    });

    if (!user)
      throw new HttpException('Public key not found', HttpStatus.NOT_FOUND);

    const userLockedRecords = await this.poolRepository.findOne({
      where: {
        senderPublicKey: user.account,
        depositType: DepositType.LOCKER,
      },
    });

    if (!userLockedRecords)
      throw new HttpException(
        'You rewards yet to be unlocked',
        HttpStatus.NOT_FOUND,
      );

    const locks = await this.poolRepository.find({
      where: {
        depositType: DepositType.LOCKER,
      },
    });

    const userLocks = locks.filter(
      (lock) => lock.senderPublicKey === userPublicKey,
    );

    let totalAssetA = 0;
    let totalAssetB = 0;

    locks.forEach((pool) => {
      const assetAAmount = parseFloat(pool.assetAAmount);
      const assetBAmount = parseFloat(pool.assetBAmount);

      if (!isNaN(assetAAmount)) totalAssetA += assetAAmount;
      if (!isNaN(assetBAmount)) totalAssetB += assetBAmount;
    });

    const lockTotalAmount = totalAssetA + totalAssetB;

    // Initialize user total amounts for assets
    let userTotalAAmount = 0;
    let userTotalBAmount = 0;

    userLocks.forEach((pool) => {
      const userAssetAAmount = parseFloat(pool.assetAAmount);
      const userAssetBAmount = parseFloat(pool.assetBAmount);

      if (!isNaN(userAssetAAmount)) userTotalAAmount += userAssetAAmount;
      if (!isNaN(userAssetBAmount)) userTotalBAmount += userAssetBAmount;
    });

    const userTotalDepositAmount = userTotalAAmount + userTotalBAmount;
    const userPercentage =
      lockTotalAmount > 0 ? userTotalDepositAmount / lockTotalAmount : 0;

    const assets = [this.blub, new Asset(AQUA_CODE, AQUA_ISSUER)].sort();

    const rewardEstimation = await this.sorobanService.userRewardEstimation(
      assets,
      this.lpSignerKeypair.publicKey(),
    );

    return {
      lockedAquaRewardEstimation: (rewardEstimation * userPercentage).toFixed(
        7,
      ),
    };
  }

  async swapToWhlaqua(amount: number): Promise<number> {
    const assets = [new Asset(AQUA_CODE, AQUA_ISSUER), this.blub];
    const poolId = 'CBL7MWLEZ4SU6YC5XL4T3WXKNKNO2UQVDVONOQSW5VVCYFWORROHY4AM';

    // get pool reserves
    const poolReserves = await this.sorobanService.getPoolReserves(
      assets,
      poolId,
    );

    const aquaAddress = this.sorobanService.getAssetContractId(
      new Asset(AQUA_CODE, AQUA_ISSUER),
    );

    const blubAddress = this.sorobanService.getAssetContractId(this.blub);

    this.logger.debug(`AQUA token address: ${aquaAddress}`);
    this.logger.debug(`Blub token address: ${blubAddress}`);

    const swapAmount = await this.sorobanService.getSwapTx(
      amount,
      poolId,
      assets,
    );

    this.logger.debug(`Swapping ${amount.toFixed(7)} AQUA to WHLAQUA`);
    return swapAmount;
  }

  async unlockAqua(unlockAquaDto: UnlockAquaDto) {
    const account = await this.server.loadAccount(
      unlockAquaDto.senderPublicKey,
    );

    const user = await this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.claimableRecords', 'claimableRecords')
      .leftJoinAndSelect('user.pools', 'pools')
      .where('user.account = :accountId', { accountId: account.accountId() })
      //testing this one
      // .andWhere('pools.claimed = :unclaimed', { unclaimed: CLAIMS.UNCLAIMED })
      .andWhere('pools.depositType = :locker', { locker: DepositType.LOCKER })
      .getOne();

    if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);

    // Calculate total unclaimed amount from claimable records and pool amounts
    let totalClaimableRecordsAmount = user.claimableRecords
      .filter((record) => record.claimed === CLAIMS.UNCLAIMED)
      .reduce((total, record) => total + parseFloat(record.amount), 0);

    let totalPoolAssetBAmount = user.pools
      .filter((pool) => pool.claimed === CLAIMS.UNCLAIMED)
      .reduce((total, pool) => total + parseFloat(pool.assetBAmount), 0);

    let totalAmount = totalClaimableRecordsAmount + totalPoolAssetBAmount;
    console.log({ totalClaimableRecordsAmount });
    console.log({ totalPoolAssetBAmount });
    console.log({ totalAmount });

    if (totalAmount <= 0)
      throw new HttpException('Nothing to claim', HttpStatus.FORBIDDEN);

    const { amountToUnstake } = unlockAquaDto;
    if (amountToUnstake > totalAmount)
      throw new HttpException('Insufficient balance', HttpStatus.FORBIDDEN);

    // Calculate proportional amounts to adjust
    //let amountToDeductFromClaimableRecords = amountToUnstake * 0.9;

    //need to deduct full
    let amountToDeductFromClaimableRecords = amountToUnstake * 1.0;
    let amountToDeductFromPool = amountToUnstake * 0.1;

    let remainingClaimableAdjustment = amountToDeductFromClaimableRecords;
    let remainingPoolAdjustment = amountToDeductFromPool;

    // Adjust claimable records (90%)
    try {
      for (const record of user.claimableRecords) {
        if (
          record.claimed === CLAIMS.UNCLAIMED &&
          remainingClaimableAdjustment > 0
        ) {
          let recordAmount = parseFloat(record.amount);
          if (remainingClaimableAdjustment >= recordAmount) {
            // Fully consume this record
            remainingClaimableAdjustment -= recordAmount;
            record.amount = '0.0000000'; // This record is fully used
            record.claimed = CLAIMS.CLAIMED; // Mark it as claimed
          } else {
            // Partially adjust this record
            record.amount = (
              recordAmount - remainingClaimableAdjustment
            ).toFixed(7);
            remainingClaimableAdjustment = 0;
            break;
          }
        }
      }

      // Adjust pool amounts (10%)
      // for (const pool of user.pools) {
      //   if (pool.claimed === CLAIMS.UNCLAIMED && remainingPoolAdjustment > 0) {
      //     let poolAmount = parseFloat(pool.assetBAmount);
      //     if (remainingPoolAdjustment >= poolAmount) {
      //       // Fully consume this pool amount
      //       remainingPoolAdjustment -= poolAmount;
      //       pool.assetBAmount = '0.0000000'; // This pool is fully used
      //       pool.claimed = CLAIMS.CLAIMED; // Mark it as claimed
      //     } else {
      //       // Partially adjust this pool amount
      //       pool.assetBAmount = (poolAmount - remainingPoolAdjustment).toFixed(7);
      //       remainingPoolAdjustment = 0;
      //       break;
      //     }
      //   }
      // }

      // Final check to ensure all adjustments were made
      // if (remainingClaimableAdjustment > 0 || remainingPoolAdjustment > 0) {
      //   throw new HttpException(
      //     'Unable to adjust all amounts',
      //     HttpStatus.INTERNAL_SERVER_ERROR,
      //   );
      // }

      console.log(remainingClaimableAdjustment);
      if (remainingClaimableAdjustment > 0) {
        throw new HttpException(
          'Unable to adjust all amounts',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      }

      // Save the adjusted claimable records and pools
      await this.claimableRecords.save(user.claimableRecords);
      await this.poolRepository.save(user.pools);

      await this.claimableRecords.save(user.claimableRecords);
      await this.poolRepository.save(user.pools);

      await this.transferAsset(
        this.issuerKeypair,
        unlockAquaDto.senderPublicKey,
        `${amountToUnstake}`,
        this.blub,
      );

      this.logger.debug(
        `Successfully sent: ${amountToUnstake} to ${unlockAquaDto.senderPublicKey}`,
      );
    } catch (e) {
      console.log(e);
      throw e;
    }
  }

  // @Cron('0 7 */7 * *')
  @Cron(CronExpression.EVERY_WEEK)
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
      where: {
        depositType: DepositType.LIQUIDITY_PROVISION,
        claimed: CLAIMS.UNCLAIMED,
      },
    });

    if (poolRecords.length === 0) return;

    const account = await this.server.loadAccount(
      this.lpSignerKeypair.publicKey(),
    );

    this.logger.debug('Trying to distribute LP AQUA/WHLAQUA LP rewards');

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
    if (to_claim < 25000) return;

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

    const distributionAmount = Math.round(Number(rewardAmount * 0.7));
    const treasuryAmount = Number((rewardAmount * 0.3).toFixed(7));

    // Swap AQUA(Rewards) to WHLAQUA
    const swappedAmount = await this.swapToWhlaqua(distributionAmount);

    this.logger.debug(
      `Swapped AQUA to WHLAQUA, total swapped amount: ${swappedAmount}`,
    );

    // Ensure all user transfers are completed before proceeding
    await Promise.all(
      Object.entries(userTotalAmountForAsset).map(
        ([userPublicKey, assetPairs]) =>
          Promise.all(
            Object.entries(assetPairs).map(async ([pair, userPairData]) => {
              const totalPoolForPair = totalPoolPerPairAmount[pair] || 0;
              if (totalPoolForPair === 0) return;

              const userClaimAmount = parseFloat(userPairData.total);

              // Calculate the user's percentage of the total claimable amount
              const userPercentage = userClaimAmount / swappedAmount;
              const userShare = (userPercentage * swappedAmount).toFixed(7);

              try {
                // Transfer assets to the user
                await this.transferAsset(
                  this.lpSignerKeypair,
                  userPublicKey,
                  userShare,
                  this.blub,
                );
                this.logger.log(
                  `LP reward sent to ${userPublicKey} with share: ${userShare}`,
                );
              } catch (error) {
                this.logger.error(
                  `Failed to send LP reward to ${userPublicKey}, error: ${error.message}`,
                );
              }
            }),
          ),
      ),
    );

    try {
      await this.transferAsset(
        this.lpSignerKeypair,
        this.treasureAddress,
        treasuryAmount.toString(),
        new Asset(AQUA_CODE, AQUA_ISSUER),
      );
      this.logger.log('Treasury transfer successful');
    } catch (error) {
      this.logger.error(
        `Failed to transfer treasury amount: ${error.message}`,
        { treasuryAmount },
      );
    }

    this.logger.log('All transactions have been processed successfully');
  }

  // @Cron('*/2 * * * *')
  @Cron(CronExpression.EVERY_WEEK)
  async redeemAquaRewardsForICE() {
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
      where: { depositType: DepositType.LOCKER, claimed: CLAIMS.UNCLAIMED },
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
      const totalAquaPoolRewardAmount =
        await this.sorobanService.getPoolRewards(
          account.accountId(),
          poolAddresses.poolHash,
        );

      to_claim = totalAquaPoolRewardAmount.to_claim;
      if (to_claim < 25000) return;

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

    if (to_claim < 25000) return;

    const assets = lastPoolKey
      .split(':')
      .map((code) =>
        code === 'XLM' ? Asset.native() : new Asset(code, AQUA_ISSUER),
      ) as Asset[];

    const rewardAmount = await this.sorobanService.claimLockReward(
      assets,
      account.accountId(),
    );

    const distributionAmount = Number(rewardAmount * 0.7);
    const treasuryAmount = Number((rewardAmount * 0.3).toFixed(7));

    const swappedAmount = await this.swapToWhlaqua(distributionAmount);

    this.logger.debug(
      `Swapped AQUA to WHLAQUA, total swapped amount: ${swappedAmount}`,
    );

    const rewardPromises = Object.entries(userTotalAmountForAsset).map(
      ([userPublicKey, assetPairs]) =>
        Promise.all(
          Object.entries(assetPairs).map(async ([pair, userPairData]) => {
            const totalPoolForPair = totalPoolPerPairAmount[pair] || 0;
            if (totalPoolForPair === 0) return;

            const userClaimAmount = parseFloat(userPairData.total);

            // Calculate the user's percentage of the total claimable amount
            const userPercentage = (userClaimAmount / swappedAmount) * 100;

            // Convert percentage to decimal
            const userPercentageDecimal = userPercentage / 100;

            const userShare = (userPercentageDecimal * swappedAmount).toFixed(
              7,
            );

            try {
              await this.transferAsset(
                this.lpSignerKeypair,
                userPublicKey,
                userShare,
                this.blub,
              );

              this.logger.debug(
                `Reward sent to ${userPublicKey}, userShare: ${userShare}`,
              );
            } catch (error) {
              this.logger.error(
                `Failed to send reward to ${userPublicKey}, error: ${error.message}`,
              );
            }
          }),
        ),
    );

    try {
      // Wait for all reward claims to complete
      await Promise.all(rewardPromises);

      // Transfer the remaining treasury amount after all user claims
      await this.transferAsset(
        this.lpSignerKeypair,
        this.treasureAddress,
        treasuryAmount.toString(),
        new Asset(AQUA_CODE, AQUA_ISSUER),
      );

      this.logger.debug(
        `Reward sent to treasury address: ${this.treasureAddress}`,
      );

      this.logger.log('All transactions have been processed');
    } catch (error) {
      this.logger.error(
        `Error processing reward transactions: ${error.message}`,
      );
    }
  }

  async establishTrust() {
    try {
      return;
      const receiverAccount = await this.server.loadAccount('');
      const usdcToken = new Asset(
        'USDC',
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      );

      const aquaToken = new Asset(
        'AQUA',
        'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
      );

      const totalSupply = '1000000000';

      const trustTransaction = new TransactionBuilder(receiverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.changeTrust({
            asset: usdcToken,
            limit: totalSupply,
          }),
        )
        .addOperation(
          Operation.changeTrust({
            asset: aquaToken,
            limit: totalSupply,
          }),
        )
        .setTimeout(100)
        .build();

      // Sign with the receiver's secret key
      trustTransaction.sign(this.issuerKeypair);

      // Submit the trustline transaction
      const trustResult = await this.server.submitTransaction(trustTransaction);
      console.log(
        `Trustline created successfully. Transaction hash: ${trustResult.hash}`,
      );
    } catch (err) {
      console.log(err);
    }
  }

  async assetIssuer() {
    const blubToken = new Asset('u', this.issuerKeypair.publicKey());
    const receivingKeys = this.lpSignerKeypair.publicKey();
    const totalSupply = '1000000000';

    try {
      // Step 1: Receiver establishes the trustline
      const receiverAccount = await this.server.loadAccount(receivingKeys);

      const trustTransaction = new TransactionBuilder(receiverAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.changeTrust({
            asset: blubToken,
            limit: totalSupply,
          }),
        )
        .setTimeout(100)
        .build();

      // Sign with the receiver's secret key
      trustTransaction.sign(this.lpSignerKeypair);

      // Submit the trustline transaction
      const trustResult = await this.server.submitTransaction(trustTransaction);
      console.log(
        `Trustline created successfully. Transaction hash: ${trustResult.hash}`,
      );

      // Step 2: Issuer sends the tokens to the receiver
      const issuerAccount = await this.server.loadAccount(
        this.issuerKeypair.publicKey(),
      );

      const paymentTransaction = new TransactionBuilder(issuerAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.payment({
            destination: receivingKeys,
            asset: blubToken,
            amount: '1000000000',
          }),
        )
        .setTimeout(100)
        .build();

      // Sign with the issuer's keypair
      paymentTransaction.sign(this.issuerKeypair);

      // Submit the payment transaction
      const paymentResult =
        await this.server.submitTransaction(paymentTransaction);
      console.log(
        `Payment transaction successful. Transaction hash: ${paymentResult.hash}`,
      );

      const account = await this.sorobanService.server.getAccount(
        this.issuerKeypair.publicKey(),
      );
      console.log(this.issuerKeypair.publicKey());
      const assetTxn = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.createStellarAssetContract({
            asset: blubToken,
          }),
        )
        .setTimeout(30)
        .build();

      const uploadTx =
        await this.sorobanService.server.prepareTransaction(assetTxn);
      uploadTx.sign(this.issuerKeypair);
      const result = await this.sorobanService.server.sendTransaction(uploadTx);
      console.log(
        `Payment transaction successful. Transaction hash: ${result.hash}`,
      );
    } catch (error) {
      console.error('An error occurred:', error);
    }
  }

  async setStellarAddress() {
    try {
      const account = await this.server.loadAccount(
        this.issuerKeypair.publicKey(),
      );

      var transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.setOptions({
            homeDomain: 'whalehub.io',
          }),
        )
        .setTimeout(100)
        .build();

      transaction.sign(this.issuerKeypair);

      const issuingTx = await this.server.submitTransaction(transaction);
      console.log(issuingTx.hash);
    } catch (error) {
      console.error('An error occurred:', error);
    }
  }
}
