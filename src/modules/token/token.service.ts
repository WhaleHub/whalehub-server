import { Injectable } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { CreateStakeDto } from './dto/create-stake.dto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  SorobanRpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

const sorobanTokenContractPath = path.join(
  process.cwd(),
  'src/soroban-contracts/soroban_token_contract.wasm',
);

const tokenAddress = 'CANRKM7ICT63COUOOUOIV5UMSFS5KZY2KQQLD24JIAHJJSXT4YSUJP3P';

@Injectable()
export class TokenService {
  private sorobanClient: SorobanRpc.Server;
  private walletSecretKey: string;
  private walletKeypair: Keypair;
  private rpcUrl: string;

  constructor(private configService: ConfigService) {
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
      const asset = new Asset(
        assetCode,
        'GDMFFHVJQZSDXM4SRU2W6KFLWV62BKXNNJVC4GT25NMQK2LENFUVO44I',
      );

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
    console.log(createStakeDto);
    // Implement staking logic here
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

  private async uploadWasm(filePath: string) {
    try {
      const bytecode = fs.readFileSync(filePath);
      const account = await this.sorobanClient.getAccount(
        this.walletKeypair.publicKey(),
      );

      const operation = Operation.uploadContractWasm({ wasm: bytecode });
      return await this.buildAndSendTransaction(account, operation);
    } catch (error) {
      console.error('Error uploading WASM file:', error);
      throw error;
    }
  }
}
