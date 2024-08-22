import { Injectable } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { CreateStakeDto } from './dto/create-stake.dto';
import { ConfigService } from '@nestjs/config';
import {
  Asset,
  BASE_FEE,
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

@Injectable()
export class TokenService {
  private sorobanClient: SorobanRpc.Server;
  private walletSecretKey: string;
  private walletKeypair: Keypair;
  private rpcUrl: string;

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
  }

  async create(createTokenDto: CreateTokenDto): Promise<void> {
    try {
      // const uploadResponse = await this.uploadWasm(sorobanTokenContractPath);
      // const byteArray = uploadResponse.response.returnValue.bytes();
      // const wasmHash = byteArray.toString('hex');
      // console.log(`Wasm hash: ${wasmHash}`);

      const assetCode = 'WHLAQUA';
      const asset = new Asset(assetCode, this.walletKeypair.publicKey());

      const sourceAccount = await this.sorobanClient.getAccount(
        this.walletKeypair.publicKey(),
      );

      const transaction = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(
          Operation.changeTrust({
            asset: asset,
            limit: '1',
            source: this.walletKeypair.publicKey(),
          }),
        )
        .addOperation(
          Operation.payment({
            destination: this.walletKeypair.publicKey(),
            asset: asset,
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

      const response = await this.sorobanClient.sendTransaction(transaction);
      const hash = response.hash;
      console.log('hash :', hash);

      const transactionResult = await this.checkTransactionStatus(
        this.sorobanClient,
        hash,
      );

      if (transactionResult.status === 'SUCCESS') {
        let user: UserEntity;

        user = await this.userRepository.findOneBy({
          account: createStakeDto.senderPublicKey,
        });

        //create a new user record for public key
        if (!user) {
          const newUserAccountRecord = new UserEntity();
          newUserAccountRecord.account = createStakeDto.senderPublicKey;
          user = await newUserAccountRecord.save();
        }

        const stake = new StakeEntity();
        stake.account = user;
        stake.amount = 1;
        await stake.save();

        //[x] creates trustline for user wallet to receive WHLAQUA
        //[x] create trustlines for governance tokens for server wallet
        //[x] create a cliamable aqua balance
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
