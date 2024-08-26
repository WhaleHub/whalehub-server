import { Injectable } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
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

// const sorobanTokenContractPath = path.join(
//   process.cwd(),
//   'src/soroban-contracts/soroban_token_contract.wasm',
// );

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
  private secret: string;
  private keypair: Keypair;
  private rpcUrl: string;
  whaleAcqua: Asset;

  constructor(
    private configService: ConfigService,

    private sorobanService: SorobanService,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {
    this.secret = this.configService.get<string>('SOROBAN_WALLET_SECRET_KEY');
    this.rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.server = new Horizon.Server(this.rpcUrl, { allowHttp: true });
    this.keypair = Keypair.fromSecret(this.secret);

    this.whaleAcqua = new Asset(WHLAQUA_CODE, this.keypair.publicKey());
  }

  async create(createTokenDto: CreateTokenDto): Promise<void> {
    try {
      const sourceAccount = await this.server.loadAccount(
        this.keypair.publicKey(),
      );

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.changeTrust({
            asset: this.whaleAcqua,
            limit: '1',
            source: this.keypair.publicKey(),
          }),
        )
        .addOperation(
          Operation.payment({
            destination: this.keypair.publicKey(),
            asset: this.whaleAcqua,
            amount: '1000000',
          }),
        )
        .setTimeout(180)
        .build();

      transaction.sign(this.keypair);
      const response = await this.server.submitTransaction(transaction);
      console.log('Transaction hash:', response.hash);
      console.log('Transaction successful.');
    } catch (err) {
      console.error('Error during WASM upload:', err);
    }
  }

  async stake(createStakeDto: CreateStakeDto): Promise<void> {
    const remaniningAmount = createStakeDto.amount * 0.1;
    const assets = [
      new Asset(
        'AQUA',
        'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA',
      ),
      new Asset(
        'XLM',
        'GBSTRH4QOTWNSVA6E4HFERETX4ZLSR3CIUBLK7AXYII277PFJC4BBYOG',
      ),
    ];
    const amounts = new Map<string, string>();
    amounts.set('XLM', `${remaniningAmount}`);
    amounts.set(AQUA_CODE, '50');

    const depositTx = await this.sorobanService.depositAQUAWHLHUB(
      assets,
      amounts,
    );

    return depositTx;
    try {
      // Load the account details
      const account = await this.server.loadAccount(this.keypair.publicKey());

      // Calculate the amounts to stake and for liquidity
      const amountToStake = createStakeDto.amount * 0.9;
      const remaniningAmount = createStakeDto.amount * 0.1;

      // Create and submit the first transaction for transferring AQUA
      const transferAquaTxn = new Transaction(
        createStakeDto.signedTxXdr,
        Networks.PUBLIC,
      );
      transferAquaTxn.sign(this.keypair);

      const transferAquaResponse =
        await this.server.submitTransaction(transferAquaTxn);
      const transferAquaHash = transferAquaResponse.hash;
      console.log('Transfer AQUA transaction hash:', transferAquaHash);

      // Check if the first transaction was successful
      const depositAquaTransactionResult = (await this.checkTransactionStatus(
        this.server,
        transferAquaHash,
      )) as any;

      if (
        depositAquaTransactionResult &&
        depositAquaTransactionResult.successful
      ) {
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
      stake.amount = createStakeDto.amount;
      await stake.save();

      // Check existing trustlines
      const existingTrustlines = account.balances.map(
        (balance: Balance) => balance.asset_code,
      );

      const trustlineTransaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      }) as any;

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
              limit: '1000000000.0000000',
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
        builtTrustlineTxn.sign(this.keypair);

        if (trustlineTransaction.operations.length > 0) {
          console.log('starting trustline transaction');
          const trustlineResponse =
            await this.server.submitTransaction(builtTrustlineTxn);
          const trustlineHash = trustlineResponse.hash;
          console.log('Trustline transaction hash:', trustlineHash);

          const trustlineResult = await this.checkTransactionStatus(
            this.server,
            trustlineHash,
          );
        }
      } else {
        console.log('No trustline added for publc keys');
      }

      // Create and submit the claimable balance transaction
      const claimableTransaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.createClaimableBalance({
            claimants: [
              new Claimant(
                account.accountId(),
                Claimant.predicateNot(Claimant.predicateUnconditional()),
              ),
            ],
            asset: new Asset(AQUA_CODE, AQUA_ISSUER),
            amount: `${amountToStake}`,
          }),
        )
        .setTimeout(180)
        .build();

      claimableTransaction.sign(this.keypair);
      const claimableResponse =
        await this.server.submitTransaction(claimableTransaction);
      const claimableHash = claimableResponse.hash;
      console.log('Claimable balance transaction hash:', claimableHash);

      // Check the status of the claimable balance transaction
      const claimableResult = (await this.checkTransactionStatus(
        this.server,
        claimableHash,
      )) as any;

      if (claimableResult) {
        console.log('Claimable balance transaction was successful.');

        const trackerAmountForUser = Number(createStakeDto.amount);
        const additionalAmountForLiquidity =
          Number(createStakeDto.amount) * 0.1;

        await this.transferAsset(
          this.keypair,
          createStakeDto.senderPublicKey,
          `${createStakeDto.amount}`,
          this.whaleAcqua,
        );

        await this.checkBalance(this.keypair.publicKey(), this.whaleAcqua);

        const assets = [
          new Asset('WHLAQUA', this.keypair.publicKey()),
          Asset.native(), // Assuming XLM as the other asset
        ];
        const amounts = new Map<string, string>();
        amounts.set('WHLAQUA', '1000'); // Deposit 1000 WHLAQUA
        amounts.set('XLM', '50'); // Deposit 50 XLM

        const depositTx = await this.sorobanService.depositAQUAWHLHUB(
          assets,
          amounts,
        );

        //[x] transfer the trackerAmountTo user
        //[x] transfer additional liquidity to jewelboost protocol
        //[x]
      } else {
        console.error('Claimable balance transaction failed.');
      }
    } catch (err) {
      //[x] get status and check if it was a timeout
      console.error('Error during staking process:', err);
    }
  }

  async checkTransactionStatus(server: Horizon.Server, hash: string) {
    while (true) {
      try {
        // Fetch the transaction result using the server's `transactions().transaction()` method
        const transactionResult = await server
          .transactions()
          .transaction(hash)
          .call();

        if (transactionResult.successful) {
          console.log(
            'Transaction confirmed in ledger:',
            await transactionResult.successful,
          );
          return transactionResult.successful;
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
      const response = await this.server.submitTransaction(transaction);
      console.log('Transaction successful:', response);
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
}
