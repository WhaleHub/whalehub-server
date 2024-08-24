import { Injectable } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { CreateStakeDto } from './dto/create-stake.dto';
import { ConfigService } from '@nestjs/config';
import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Keypair,
  Networks,
  Operation,
  SorobanRpc,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';

// const sorobanTokenContractPath = path.join(
//   process.cwd(),
//   'src/soroban-contracts/soroban_token_contract.wasm',
// );
// const tokenAddress = 'CANRKM7ICT63COUOOUOIV5UMSFS5KZY2KQQLD24JIAHJJSXT4YSUJP3P';
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
export class TokenService {
  private sorobanClient: SorobanRpc.Server;
  private walletSecretKey: string;
  private walletKeypair: Keypair;
  private rpcUrl: string;
  whaleAcqua;

  constructor(
    private configService: ConfigService,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {
    this.walletSecretKey = this.configService.get<string>(
      'SOROBAN_WALLET_SECRET_KEY',
    );
    this.rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.sorobanClient = new SorobanRpc.Server(this.rpcUrl, {
      allowHttp: true,
    });
    this.walletKeypair = Keypair.fromSecret(this.walletSecretKey);

    this.whaleAcqua = new Asset(assetCode, this.walletKeypair.publicKey());
  }

  async create(createTokenDto: CreateTokenDto): Promise<void> {
    try {
      // const uploadResponse = await this.uploadWasm(sorobanTokenContractPath);
      // const byteArray = uploadResponse.response.returnValue.bytes();
      // const wasmHash = byteArray.toString('hex');
      // console.log(`Wasm hash: ${wasmHash}`);

      const sourceAccount = await this.sorobanClient.getAccount(
        this.walletKeypair.publicKey(),
      );

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.changeTrust({
            asset: this.whaleAcqua,
            limit: '1',
            source: this.walletKeypair.publicKey(),
          }),
        )
        .addOperation(
          Operation.payment({
            destination: this.walletKeypair.publicKey(),
            asset: this.whaleAcqua,
            amount: '1000000',
          }),
        )
        .setTimeout(180)
        .build();

      transaction.sign(this.walletKeypair);
      const response = await this.sorobanClient.sendTransaction(transaction);
      console.log('Transaction hash:', response.hash);
      console.log('Transaction successful.');
    } catch (err) {
      console.error('Error during WASM upload:', err);
    }
  }

  async stake(createStakeDto: CreateStakeDto): Promise<void> {
    const account = await this.sorobanClient.getAccount(
      this.walletKeypair.publicKey(),
    );

    try {
      const transaction = new Transaction(
        createStakeDto.signedTxXdr,
        Networks.PUBLIC,
      );

      transaction.sign(this.walletKeypair);

      const transferAquaTxn =
        await this.sorobanClient.sendTransaction(transaction);
      const hash = transferAquaTxn.hash;
      console.log('deposit aqua hash :', hash);

      const depositAquaTransactionResult = await this.checkTransactionStatus(
        this.sorobanClient,
        hash,
      );

      if (depositAquaTransactionResult.status === 'SUCCESS') {
        let user: UserEntity = await this.userRepository.findOneBy({
          account: createStakeDto.senderPublicKey,
        });

        // create a new user record for public key
        if (!user) {
          const newUserAccountRecord = new UserEntity();
          newUserAccountRecord.account = createStakeDto.senderPublicKey;
          user = await newUserAccountRecord.save();
        }

        const stake = new StakeEntity();
        stake.account = user;
        stake.amount = createStakeDto.amount;
        await stake.save();

        const trustlineClaimTxn = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: Networks.PUBLIC,
        }).addOperation(
          Operation.changeTrust({
            asset: this.whaleAcqua,
            limit: '1000000000.0000000',
            source: createStakeDto.senderPublicKey,
          }),
        );

        // add ice trustline for account
        trustlineClaimTxn.addOperation(
          Operation.changeTrust({
            asset: new Asset(ICE_CODE, ICE_ISSUER),
            limit: '1000000000.0000000',
            source: account.accountId(),
          }),
        );

        //add GOV_ICE ice trustline for account
        trustlineClaimTxn.addOperation(
          Operation.changeTrust({
            asset: new Asset(GOV_ICE_CODE, ICE_ISSUER),
            limit: '1000000000.0000000',
            source: account.accountId(),
          }),
        );

        //add UP_ICE trutline for account
        trustlineClaimTxn.addOperation(
          Operation.changeTrust({
            asset: new Asset(UP_ICE_CODE, ICE_ISSUER),
            limit: '1000000000.0000000',
            source: account.accountId(),
          }),
        );

        // add DOWN_ICE_CODE trusline
        trustlineClaimTxn.addOperation(
          Operation.changeTrust({
            asset: new Asset(DOWN_ICE_CODE, ICE_ISSUER),
            limit: '1000000000.0000000',
            source: account.accountId(),
          }),
        );

        //[x] should be updated using the timeline
        let whaleHubCanClaim = Claimant.predicateNot(
          Claimant.predicateUnconditional(),
        );

        // Create the operation and submit it in a transaction.
        let claimableBalanceEntry = Operation.createClaimableBalance({
          claimants: [new Claimant(account.accountId(), whaleHubCanClaim)],
          asset: new Asset(AQUA_CODE, AQUA_ISSUER),
          amount: `${createStakeDto.amount}`,
        });

        trustlineClaimTxn
          .addOperation(claimableBalanceEntry)
          .setTimeout(180)
          .build();

        const txn = trustlineClaimTxn.build();
        txn.sign(this.walletKeypair);

        const truslineClaimTxnResponse =
          await this.sorobanClient.sendTransaction(transaction);

        const transactionResult = await this.checkTransactionStatus(
          this.sorobanClient,
          truslineClaimTxnResponse.hash,
        );

        console.log(transactionResult, 'claimable transaction success');
      }
    } catch (err) {
      console.log(err);
    }
  }

  private async buildAndSendTransaction(account: any, operations) {
    try {
      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(operations)
        .setTimeout(180)
        .build();

      const tx = await this.sorobanClient.prepareTransaction(transaction);
      tx.sign(this.walletKeypair);

      console.log('Submitting transaction...');
      const response = await this.sorobanClient.sendTransaction(tx);
      const hash = response.hash;
      console.log(`Transaction hash: ${hash}`);
      console.log('Awaiting confirmation...');

      let confirmationResponse = await this.sorobanClient.getTransaction(hash);

      while (confirmationResponse.status === 'NOT_FOUND') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        confirmationResponse = await this.sorobanClient.getTransaction(hash);
      }

      if (confirmationResponse.status === 'SUCCESS') {
        console.log('Transaction successful.');
        console.log(confirmationResponse);
        return {
          response: confirmationResponse,
        };
      } else {
        console.error('Transaction failed:', confirmationResponse);
        throw new Error('Transaction failed');
      }
    } catch (error) {
      console.error('Error building or sending transaction:', error);
      throw error;
    }
  }

  // private async uploadWasm(filePath: string) {
  //   try {
  //     const bytecode = fs.readFileSync(filePath);
  //     const account = await this.sorobanClient.getAccount(
  //       this.walletKeypair.publicKey(),
  //     );

  //     const operation = Operation.uploadContractWasm({ wasm: bytecode });
  //     return await this.buildAndSendTransaction(account, operation);
  //   } catch (error) {
  //     console.error('Error uploading WASM file:', error);
  //     throw error;
  //   }
  // }

  async checkTransactionStatus(sorobanClient: SorobanRpc.Server, hash: string) {
    while (true) {
      try {
        const transactionResult = await sorobanClient.getTransaction(hash);

        if (transactionResult.status === 'SUCCESS') {
          console.log(
            'Transaction confirmed in block:',
            transactionResult.ledger,
          );
          return transactionResult;
        } else if (transactionResult.status === 'FAILED') {
          console.error('Transaction failed. Reason:', transactionResult);
          return null;
        } else {
          console.log('Transaction status:', transactionResult.status);
        }
      } catch (error) {
        console.error('Error fetching transaction status:', error);
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
