import { Injectable } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { UpdateTokenDto } from './dto/update-token.dto';
import * as fs from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import { Server } from 'stellar-sdk/lib/rpc';
import {
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  SorobanRpc,
  TransactionBuilder,
} from 'stellar-sdk';
import { CreateStakeDto } from './dto/create-stake.dto';

const contractWasmPath =
  __dirname + '/../../soroban-contracts/soroban_token_contract.wasm';

const soroban_token_contract = path.join(
  process.cwd(),
  'src/soroban-contracts/soroban_token_contract.wasm',
);

@Injectable()
export class TokenService {
  sorobanClient: Server;
  walletSecretKey: string;
  walletKeypair: Keypair;
  walletPublicKey: string;
  rpcUrl: string;

  constructor(private configService: ConfigService) {
    this.walletSecretKey = configService.get<string>(
      'SOROBAN_WALLET_SECRET_KEY',
    );
    this.rpcUrl = configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.sorobanClient = new SorobanRpc.Server(this.rpcUrl, {
      allowHttp: true,
    });
    this.walletKeypair = Keypair.fromSecret(this.walletSecretKey);
    this.walletPublicKey = this.walletKeypair.publicKey();
  }

  async create(createTokenDto: CreateTokenDto) {
    try {
      const token = fs.readFileSync(soroban_token_contract);
      const account = await this.sorobanClient.getAccount(this.walletPublicKey);

      //create and deploy a token
      //   const transaction = new TransactionBuilder(account, {
      //     fee: BASE_FEE,
      //     networkPassphrase: Networks.PUBLIC,
      // })
      //     .addOperation(Operation.createCustomContract({
      //         source: this.walletPublicKey,
      //         wasmHash: soroban_token_contract
      //     }))
      //     .setTimeout(180)
      //     .build();
    } catch (err) {
      console.log(err);
    }
  }

  async stake(createStakeDto: CreateStakeDto) {
    //
  }
}
