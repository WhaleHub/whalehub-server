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

// const sorobanTokenContractPath = path.join(
//   process.cwd(),
//   'src/soroban-contracts/soroban_token_contract.wasm',
// );

const assetCode = 'WHLAQUA';
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

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {
    this.secret = this.configService.get<string>('SOROBAN_WALLET_SECRET_KEY');
    this.rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.server = new Horizon.Server(this.rpcUrl, { allowHttp: true });
    this.keypair = Keypair.fromSecret(this.secret);

    this.whaleAcqua = new Asset(assetCode, this.keypair.publicKey());
  }

  async create(createTokenDto: CreateTokenDto): Promise<void> {
    try {
      // const uploadResponse = await this.uploadWasm(sorobanTokenContractPath);
      // const byteArray = uploadResponse.response.returnValue.bytes();
      // const wasmHash = byteArray.toString('hex');
      // console.log(`Wasm hash: ${wasmHash}`);

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
    try {
      // Load the account details
      const account = await this.server.loadAccount(this.keypair.publicKey());

      // Calculate the amounts to stake and for liquidity
      const amountToStake = createStakeDto.amount * 0.9;

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

      // Add trustline operations only if they don't already exist
      for (const asset of assetsToCheck) {
        if (!existingTrustlines.includes(asset.code as any)) {
          trustlineTransaction.addOperation(
            Operation.changeTrust({
              asset: new Asset(asset.code, asset.issuer),
              limit: '1000000000.0000000',
            }),
          );
          console.log(`Adding trustline for asset: ${asset.code}`);
        } else {
          console.log(`Trustline for asset ${asset.code} already exists.`);
        }
      }

      // Create the whaleAcqua trustline if it doesn't exist
      // if (!existingTrustlines.includes(this.whaleAcqua.code as any)) {
      //   trustlineTransaction.addOperation(
      //     Operation.changeTrust({
      //       asset: new Asset(
      //         'WHLAQUA',
      //         'GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V',
      //       ),
      //       limit: '1000000000.0000000',
      //       source: createStakeDto.senderPublicKey,
      //     }),
      //   );
      // }

      if (trustlineTransaction.operations.length > 0) {
        const builtTrustlineTxn = trustlineTransaction.setTimeout(180).build();
        builtTrustlineTxn.sign(this.keypair);

        const trustlineResponse =
          await this.server.submitTransaction(builtTrustlineTxn);
        const trustlineHash = trustlineResponse.hash;
        console.log('Trustline transaction hash:', trustlineHash);

        const trustlineResult = (await this.checkTransactionStatus(
          this.server,
          trustlineHash,
        )) as any;

        if (trustlineResult) {
          console.log('Trustline transaction was successful.');

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
          } else {
            console.error('Claimable balance transaction failed.');
          }
        } else {
          console.log(
            'No new trustlines needed; proceeding to create claimable balance.',
          );
        }
      }
    } catch (err) {
      //[x] get status and check if it was a timeout
      console.error('Error during staking process:', err);
    }
  }

  // private async buildAndSendTransaction(account: any, operations) {
  //   try {
  //     const transaction = new TransactionBuilder(account, {
  //       fee: BASE_FEE,
  //       networkPassphrase: Networks.PUBLIC,
  //     })
  //       .addOperation(operations)
  //       .setTimeout(180)
  //       .build();

  //     const tx = await this.server.prepareTransaction(transaction);
  //     tx.sign(this.keypair);

  //     console.log('Submitting transaction...');
  //     const response = await this.server.sendTransaction(tx);
  //     const hash = response.hash;
  //     console.log(`Transaction hash: ${hash}`);
  //     console.log('Awaiting confirmation...');

  //     let confirmationResponse = await this.server.getTransaction(hash);

  //     while (confirmationResponse.status === 'NOT_FOUND') {
  //       await new Promise((resolve) => setTimeout(resolve, 1000));
  //       confirmationResponse = await this.server.getTransaction(hash);
  //     }

  //     if (confirmationResponse.status === 'SUCCESS') {
  //       console.log('Transaction successful.');
  //       console.log(confirmationResponse);
  //       return {
  //         response: confirmationResponse,
  //       };
  //     } else {
  //       console.error('Transaction failed:', confirmationResponse);
  //       throw new Error('Transaction failed');
  //     }
  //   } catch (error) {
  //     console.error('Error building or sending transaction:', error);
  //     throw error;
  //   }
  // }

  // private async uploadWasm(filePath: string) {
  //   try {
  //     const bytecode = fs.readFileSync(filePath);
  //     const account = await this.server.loadAccount(this.keypair.publicKey());

  //     const operation = Operation.uploadContractWasm({ wasm: bytecode });
  //     // return await this.buildAndSendTransaction(account, operation);
  //   } catch (error) {
  //     console.error('Error uploading WASM file:', error);
  //     throw error;
  //   }
  // }

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
}
