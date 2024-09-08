import { Injectable } from '@nestjs/common';
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
import fs from 'fs';
import { error } from 'console';
import { Balance } from '@/utils/models/interfaces';
import { SorobanService } from './soroban.service';
import { TokenEntity } from '@/utils/typeorm/entities/token.entity';
import { CreateAddLiquidityDto } from './dto/crate-add-lp.dto';
import { TreasuryDepositsEntity } from '@/utils/typeorm/entities/treasuryDeposits.entity';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';

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
  whaleAcqua: Asset;

  constructor(
    private configService: ConfigService,

    private sorobanService: SorobanService,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,

    @InjectRepository(TokenEntity)
    private tokeRepository: Repository<TokenEntity>,
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

    this.whaleAcqua = new Asset(WHLAQUA_CODE, this.issuingKeypair.publicKey());

    // this.server
    //   .loadAccount(this.signerKeypair.publicKey())
    //   .then((account) => {
    //     const transaction = new StellarSdk.TransactionBuilder(account, {
    //       fee: StellarSdk.BASE_FEE,
    //       networkPassphrase: StellarSdk.Networks.PUBLIC,
    //     })
    //       .addOperation(
    //         Operation.changeTrust({
    //           asset: new Asset(WHLAQUA_CODE, this.issuingKeypair.publicKey()),
    //           limit: '1000000000',
    //         }),
    //       )
    //       .setTimeout(30)
    //       .build();

    //     transaction.sign(this.signerKeypair);
    //     return this.server.submitTransaction(transaction);
    //   })
    //   .then((result) => {
    //     console.log('Transaction submitted successfully!');
    //   })
    //   .catch((error) => {
    //     console.error('Error:', error.response);
    //   });
  }

  async create(createTokenDto: CreateTokenDto): Promise<string> {
    try {
      const asset = new Asset(createTokenDto.code, createTokenDto.issuer);

      const tokenData = await this.tokeRepository.findOneBy({
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

  async stake(createStakeDto: CreateStakeDto): Promise<void> {
    try {
      //TODO: ensure signer has 1M AQUA Tokens
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
      // GDJ2BJCYLWFCLDVF4THQLQDTTQGBJ4UJ3OQTJ3IHJ5L3E2ZTLSCIGOSH

      // Load the account details
      const account = await this.server.loadAccount(
        this.issuingKeypair.publicKey(),
      );

      //[x] treasury transfer txn

      // Calculate the amounts to stake and for liquidity
      const amountToStake = createStakeDto.amount * 0.9;
      const remaniningAmount = createStakeDto.amount * 0.1;
      const trackerTransferAmount =
        (createStakeDto.amount + createStakeDto.treasuryAmount) * 1.1;

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
      await stake.save();

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

      // If all the previous steps succeeded, create and submit the claimable balance transaction
      const claimableTransaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.createClaimableBalance({
            claimants: [
              new Claimant(
                account.accountId(),
                //TODO: Ensure to use the correct predicate
                Claimant.predicateNot(Claimant.predicateUnconditional()),
              ),
            ],
            asset: new Asset(AQUA_CODE, AQUA_ISSUER),
            amount: `${amountToStake}`,
          }),
        )
        .setTimeout(180)
        .build();

      claimableTransaction.sign(this.issuingKeypair);
      const claimableResponse =
        await this.server.submitTransaction(claimableTransaction);
      const claimableHash = claimableResponse.hash;
      console.log('Claimable balance transaction hash:', claimableHash);

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

      console.log('Balance ID:', balanceId);
      console.log('Claimable balance transaction was successful.');

      const claimableRecord = new ClaimableRecordsEntity();
      claimableRecord.account = user;
      claimableRecord.balanceId = balanceId;
      claimableRecord.amount = createStakeDto.amount.toString();
      await claimableRecord.save();

      const additionalAmountForLiquidity = Number(createStakeDto.amount) * 1.1;

      await this.transferAsset(
        this.issuingKeypair,
        this.signerKeypair.publicKey(),
        additionalAmountForLiquidity.toString(),
        this.whaleAcqua,
      );

      await this.checkBalance(this.signerKeypair.publicKey(), this.whaleAcqua);

      const assets = [this.whaleAcqua, new Asset(AQUA_CODE, AQUA_ISSUER)];

      const amounts = new Map<string, string>();
      amounts.set(assets[0].code, additionalAmountForLiquidity.toString());
      amounts.set(assets[1].code, remaniningAmount.toString());

      //send token to new signer for staking
      await this.sorobanService.depositAQUAWHLHUB(assets, amounts);

      // transfer token tracker
      await this.transferAsset(
        this.issuingKeypair,
        createStakeDto.senderPublicKey,
        `${trackerTransferAmount}`,
        this.whaleAcqua,
      );
    } catch (err) {
      console.error('Error during staking process:', err);
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
        // Fetch the transaction result using the server's `transactions().transaction()` method
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

    const transaction = new TransactionBuilder(senderAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(
        Operation.payment({
          destination: destinationPublicKey,
          asset: asset,
          amount: amount,
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

  async addLiq(createAddLiquidityDto: CreateAddLiquidityDto) {
    await this.sorobanService.addLiqudityTxn(createAddLiquidityDto);
  }
}
