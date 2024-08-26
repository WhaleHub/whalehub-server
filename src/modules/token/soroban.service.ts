import { SorobanPrepareTxErrorHandler } from '@/helpers/error-handler';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Horizon, Keypair, xdr } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { sha256 } from 'js-sha256';
import * as binascii from 'binascii';
import SimulateTransactionSuccessResponse = StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse;

const SOROBAN_SERVER = 'https://soroban-rpc.aqua.network/';
export const AMM_SMART_CONTACT_ID =
  'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK';

// First stellar account:)
const ACCOUNT_FOR_SIMULATE =
  'GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V';

enum AMM_CONTRACT_METHOD {
  GET_POOLS = 'get_pools',
  INIT_CONSTANT_POOL = 'init_standard_pool',
  INIT_STABLESWAP_POOL = 'init_stableswap_pool',
  DEPOSIT = 'deposit',
  SHARE_ID = 'share_id',
  ESTIMATE_SWAP_ROUTED = 'estimate_swap_routed',
  WITHDRAW = 'withdraw',
  SWAP = 'swap',
  SWAP_CHAINED = 'swap_chained',
  GET_RESERVES = 'get_reserves',
  POOL_TYPE = 'pool_type',
  FEE_FRACTION = 'get_fee_fraction',
  GET_REWARDS_INFO = 'get_rewards_info',
  GET_INFO = 'get_info',
  GET_USER_REWARD = 'get_user_reward',
  GET_TOTAL_SHARES = 'get_total_shares',
  CLAIM = 'claim',
  GET_STABLE_CREATION_FEE = 'get_stable_pool_payment_amount',
  GET_CONSTANT_CREATION_FEE = 'get_standard_pool_payment_amount',
  GET_CREATION_FEE_TOKEN = 'get_init_pool_payment_token',
}

enum ASSET_CONTRACT_METHOD {
  GET_ALLOWANCE = 'allowance',
  APPROVE_ALLOWANCE = 'approve',
  GET_BALANCE = 'balance',
  NAME = 'name',
}

@Injectable()
export class SorobanService {
  server: StellarSdk.SorobanRpc.Server | null = null;
  private secret: string;
  private keypair: Keypair;
  private rpcUrl: string;
  whaleAcqua: Asset;

  constructor(private configService: ConfigService) {
    this.startServer();
  }

  startServer(): void {
    this.secret = this.configService.get<string>('SOROBAN_WALLET_SECRET_KEY');
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl, { allowHttp: true });
    this.keypair = Keypair.fromSecret(this.secret);
  }

  async depositAQUAWHLHUB(assets: Asset[], amounts) {
    console.log(assets);

    try {
      const ab = await this.getPools(assets);
      console.log('poos', ab);
    } catch (err) {
      console.log(err);
    }
    //[x] checks if pool already exists
    //[x] if not create pool
    //[x] if exits, fund pool
    //   const depositTx = await this.getDepositTx(
    //     userAccountId,
    //     poolHash,
    //     assets,
    //     amounts
    // );
  }

  async buildSmartContactTx(publicKey, contactId, method, ...args) {
    return this.server.getAccount(publicKey).then((acc) => {
      const contract = new StellarSdk.Contract(contactId);

      const builtTx = new StellarSdk.TransactionBuilder(acc, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.PUBLIC,
      });

      if (args) {
        builtTx.addOperation(contract.call(method, ...args));
      } else {
        builtTx.addOperation(contract.call(method));
      }

      return builtTx.setTimeout(StellarSdk.TimeoutInfinite).build();
    });
  }

  async getInitConstantPoolTx(
    accountId: string,
    base: Asset,
    counter: Asset,
    fee: number,
  ) {
    return this.buildSmartContactTx(
      accountId,
      AMM_SMART_CONTACT_ID,
      AMM_CONTRACT_METHOD.INIT_CONSTANT_POOL,
      this.publicKeyToScVal(accountId),
      this.scValToArray(
        this.orderTokens([base, counter]).map((asset) =>
          this.assetToScVal(asset),
        ),
      ),
      this.amountToUint32(fee),
    ).then((tx) => this.prepareTransaction(tx));
  }

  private publicKeyToScVal(pubkey: string): StellarSdk.xdr.ScVal {
    return xdr.ScVal.scvAddress(
      StellarSdk.Address.fromString(pubkey).toScAddress(),
    );
  }

  private orderTokens(assets: Asset[]) {
    for (let i = 0; i < assets.length; i++) {
      for (let j = 0; j < assets.length - 1; j++) {
        let hash1 = parseInt(this.getAssetContractHash(assets[j]), 16);
        let hash2 = parseInt(this.getAssetContractHash(assets[j + 1]), 16);
        if (hash1 > hash2) {
          let temp = assets[j];
          assets[j] = assets[j + 1];
          assets[j + 1] = temp;
        }
      }
    }

    return assets;
  }

  getAssetContractHash(asset: Asset): string {
    const networkId: Buffer = Buffer.from(
      sha256.arrayBuffer(StellarSdk.Networks.PUBLIC),
    );

    const contractIdPreimage: xdr.ContractIdPreimage =
      xdr.ContractIdPreimage.contractIdPreimageFromAsset(asset.toXDRObject());

    const hashIdPreimageContractId = new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage,
    });

    const data: xdr.HashIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
      hashIdPreimageContractId,
    );

    return sha256(data.toXDR());
  }

  private assetToScVal(asset: Asset): xdr.ScVal {
    return xdr.ScVal.scvAddress(
      StellarSdk.Address.contract(
        StellarSdk.StrKey.decodeContract(this.getAssetContractId(asset)),
      ).toScAddress(),
    );
  }

  scValToArray(array: xdr.ScVal[]): xdr.ScVal {
    return xdr.ScVal.scvVec(array);
  }

  amountToUint32(amount: number): xdr.ScVal {
    return xdr.ScVal.scvU32(Math.floor(amount));
  }

  getAssetContractId(asset: Asset): string {
    const hash = this.getAssetContractHash(asset);

    return this.getContactIdFromHash(hash);
  }

  getContactIdFromHash(hash) {
    return StellarSdk.StrKey.encodeContract(
      Buffer.from(binascii.unhexlify(hash), 'ascii'),
    );
  }

  prepareTransaction(tx: StellarSdk.Transaction) {
    return this.server.prepareTransaction(tx).catch((err) => {
      throw SorobanPrepareTxErrorHandler(err);
    });
  }

  getPools(assets: Asset[]): Promise<null | Array<any>> {
    return this.buildSmartContactTx(
      ACCOUNT_FOR_SIMULATE,
      AMM_SMART_CONTACT_ID,
      AMM_CONTRACT_METHOD.GET_POOLS,
      this.scValToArray(
        this.orderTokens(assets).map((asset) => this.assetToScVal(asset)),
      ),
    )
      .then((tx) => {
        return this.server.simulateTransaction(
          tx,
        ) as Promise<SimulateTransactionSuccessResponse>;
      })
      .then((res) => {
        if (!res.result) {
          return [];
        }
        const hashArray = res.result.retval.value() as Array<any>;
        if (!hashArray.length) {
          return [];
        }
        return hashArray.map((item) => [
          this.getContactIdFromHash(item.val().value().value().toString('hex')),
          item.key().value(),
        ]);
      });
  }
}
