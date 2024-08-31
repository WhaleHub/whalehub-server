import { SorobanPrepareTxErrorHandler } from '@/helpers/error-handler';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Keypair, xdr } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { sha256 } from 'js-sha256';
import * as binascii from 'binascii';
import SimulateTransactionSuccessResponse = StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse;
import BigNumber from 'bignumber.js';
import bs58 from 'bs58'; // Base32 encoding library
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as base64 from 'base64-js';

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

export enum POOL_TYPE {
  stable = 'stable',
  constant = 'constant_product',
}

@Injectable()
export class SorobanService {
  server: StellarSdk.SorobanRpc.Server | null = null;
  private secret: string;
  private keypair: Keypair;
  private rpcUrl: string;
  whaleAcqua: Asset;
  assetsCache = new Map<string, Asset>();

  constructor(
    private configService: ConfigService,

    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {
    this.startServer();
  }

  startServer() {
    this.secret = this.configService.get<string>('SOROBAN_WALLET_SECRET_KEY');
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl, { allowHttp: true });
    this.keypair = Keypair.fromSecret(this.secret);
  }

  async depositAQUAWHLHUB(assets: Asset[], amounts) {
    const account = await this.server.getAccount(this.keypair.publicKey());

    try {
      let poolsForAsset = await this.getPools(assets);

      if (poolsForAsset.length === 0) {
        console.log('initializing pool');
        const account = await this.server.getAccount(this.keypair.publicKey());

        //[x]
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

        // console.olog(createPoolTxnValue[0], createPoolTxnValue[1]);

        // Convert Buffer to hexadecimal string

        // return;
        this.getInitConstantPoolTx(
          account.accountId(),
          assets[0],
          assets[1],
          10,
        )
          .then((tx) => {
            const xdr = tx.toEnvelope().toXDR('base64');

            const initPoolTxn = new StellarSdk.Transaction(
              xdr,
              StellarSdk.Networks.PUBLIC,
            );

            initPoolTxn.sign(this.keypair);

            this.server.sendTransaction(initPoolTxn).then(async (res) => {
              if (!res) {
                return;
              }
              const hash = res.hash;
              //  const hash =
              // 'cd9b95a5977174c29c18d752609536229c4851cf7fcaede97ce64dc07bd1425d';

              const createPoolTxnValue = this.checkTransactionStatus(
                this.server,
                hash,
              );

              const user = new UserEntity();
              user.account = this.keypair.publicKey();

              poolsForAsset = await this.getPools(assets);

              // [
              //   [
              //     'CD4ASKG2XVZRAUXSXPCGUSBIX4JOC2TNA2FDBAPUNJB7RSUG5YGRQRSF',
              //     <Buffer b2 e0 2f cf ca 6c 96 f8 ad 5c bd 84 e7 78 4a 77 7b 36 d9 c9 6a 24 59 40 2c 4f 45 84 62 aa b7 f0>
              //   ]
              // ]

              // keep records in db
              const pool = new PoolsEntity();
              pool.assetA = assets[0];
              pool.assetB = assets[1];
              pool.account = user;
              pool.fee = 10;
              pool.txnHash = hash;
              pool.poolHash = poolsForAsset[0][0];
              await pool.save();

              //[x]deposit tokens to pool
            });
          })
          .catch((err) => {
            console.log(err, 'caught');
          });
      } else {
        console.log('trying to deposit into pool');

        this.getDepositTx(
          account.accountId(),
          poolsForAsset[0][1],
          assets,
          amounts,
        )
          .then(async (tx) => {
            console.log(tx);
            //[x] submit transaction on chain
            // const mainTx = await this.server.sendTransaction(tx);

            // if (mainTx.status === 'ERROR') {
            //   console.log(mainTx);
            // } else {
            //   console.log('transaction submitted');
            // }
          })
          .catch((err) => console.log(err));

        return;

        const tokens = [
          new StellarSdk.Address(
            'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK',
          ).toScVal(),
          new StellarSdk.Address(
            'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
          ).toScVal(),
        ];

        const poolIndex =
          'CCY2PXGMKNQHO7WNYXEWX76L2C5BH3JUW3RCATGUYKY7QQTRILBZIFWV';

        const desiredAmounts = [1n, 2n].map(this.bigintToInt128Parts);
        const minShares = this.bigintToInt128Parts(100000n);

        const contract = new StellarSdk.Contract(AMM_SMART_CONTACT_ID);

        console.log(Buffer.from(poolIndex, 'hex'));

        const transaction = new StellarSdk.TransactionBuilder(account, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: StellarSdk.Networks.PUBLIC,
        })
          .addOperation(
            contract.call(
              'deposit',
              StellarSdk.Address.fromString(this.keypair.publicKey()).toScVal(),
              xdr.ScVal.scvVec(tokens),
              xdr.ScVal.scvBytes(Buffer.from(poolIndex, 'hex')),
              xdr.ScVal.scvVec(
                desiredAmounts.map(StellarSdk.xdr.ScVal.scvI128),
              ),
              xdr.ScVal.scvI128(minShares),
            ),
          )
          .setTimeout(30)
          .build();

        const txnPrepared = await this.prepareTransaction(transaction);

        console.log(txnPrepared);
      }
    } catch (err) {
      console.log(err);
    }
    //[x] checks if pool already exists
    //[x] if not create pool
    //[x] if exits, fund pool
  }

  getDepositTx(
    accountId: string,
    poolHash: string,
    assets: Asset[],
    amounts: Map<string, string>,
  ) {
    return this.buildSmartContactTx(
      accountId,
      AMM_SMART_CONTACT_ID,
      AMM_CONTRACT_METHOD.DEPOSIT,
      this.publicKeyToScVal(accountId),
      this.scValToArray(
        this.orderTokens(assets).map((asset) => this.assetToScVal(asset)),
      ),
      this.hashToScVal(poolHash),
      this.scValToArray(
        this.orderTokens(assets).map((asset) => {
          // amounts.get(this.getAssetString(asset)
          return this.amountToUint128('1');
        }),
      ),
      this.amountToUint128('0.0000001'),
    ).then((tx) => this.prepareTransaction(tx));
  }

  amountToUint128(amount: string): xdr.ScVal {
    return new StellarSdk.XdrLargeInt(
      'u128',
      new BigNumber(amount).times(1e7).toFixed(),
    ).toU128();
  }

  getAssetString = (asset) => `${asset.code}`;

  hashToScVal(hash): xdr.ScVal {
    const buffer = Buffer.from(hash, 'hex');

    return xdr.ScVal.scvBytes(buffer);
  }

  bigintToInt128Parts(value) {
    // Ensure value is a bigint
    if (typeof value !== 'bigint') {
      throw new Error('Value must be a bigint');
    }

    // 64 bits = 2^64
    const HIGH_MASK = 0xffffffffffffffffn;

    const high = Number(value >> 64n);
    const low = Number(value & HIGH_MASK);

    return new StellarSdk.xdr.Int128Parts({
      hi: new StellarSdk.xdr.Int64(high),
      lo: new StellarSdk.xdr.Uint64(low),
    });
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

    //[x] asset contract address
    // console.log(this.getContactIdFromHash(hash));

    return this.getContactIdFromHash(hash);
  }

  getContactIdFromHash(hash) {
    return StellarSdk.StrKey.encodeContract(
      Buffer.from(binascii.unhexlify(hash), 'ascii'),
    );
  }

  simulateTx(tx: StellarSdk.Transaction) {
    return this.server.simulateTransaction(tx);
  }

  getCreationFee(type: POOL_TYPE) {
    return this.buildSmartContactTx(
      ACCOUNT_FOR_SIMULATE,
      AMM_SMART_CONTACT_ID,
      type === POOL_TYPE.constant
        ? AMM_CONTRACT_METHOD.GET_CONSTANT_CREATION_FEE
        : AMM_CONTRACT_METHOD.GET_STABLE_CREATION_FEE,
    )
      .then(
        (tx) =>
          this.simulateTx(tx) as Promise<SimulateTransactionSuccessResponse>,
      )
      .then(({ result }) => {
        return this.i128ToInt(result.retval.value() as xdr.Int128Parts);
      });
  }

  getCreationFeeInfo() {
    return Promise.all([
      this.getCreationFeeToken(),
      this.getCreationFee(POOL_TYPE.constant),
      this.getCreationFee(POOL_TYPE.stable),
    ]).then(([token, constantFee, stableFee]) => ({
      token,
      constantFee,
      stableFee,
    }));
  }

  getAssetFromContractId(id: string): Promise<Asset> {
    if (this.assetsCache.has(id)) {
      return Promise.resolve(this.assetsCache.get(id));
    }
    return (
      this.buildSmartContactTx(
        ACCOUNT_FOR_SIMULATE,
        id,
        ASSET_CONTRACT_METHOD.NAME,
      )
        .then((tx) => this.simulateTx(tx))
        // @ts-ignore
        .then(({ result }) => {
          const [code, issuer] = result.retval.value().toString().split(':');
          const asset = issuer
            ? new StellarSdk.Asset(code, issuer)
            : StellarSdk.Asset.native();

          this.assetsCache.set(id, asset);

          return asset;
        })
    );
  }

  getCreationFeeToken() {
    return this.buildSmartContactTx(
      ACCOUNT_FOR_SIMULATE,
      AMM_SMART_CONTACT_ID,
      AMM_CONTRACT_METHOD.GET_CREATION_FEE_TOKEN,
    )
      .then(
        (tx) =>
          this.simulateTx(tx) as Promise<SimulateTransactionSuccessResponse>,
      )
      .then(({ result }) => {
        return this.getAssetFromContractId(
          this.getContactIdFromHash(
            // @ts-ignore
            result.retval.value().value().toString('hex'),
          ),
        );
      });
  }

  i128ToInt(val: xdr.Int128Parts): string {
    return (
      // @ts-ignore
      new BigNumber(val.hi()._value)
        // @ts-ignore
        .plus(val.lo()._value)
        .div(1e7)
        .toString()
    );
  }

  prepareTransaction(tx: StellarSdk.Transaction) {
    return this.server.prepareTransaction(tx).catch((err) => {
      console.log(err);
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

  async increaseTrust(asset: Asset) {
    const account = await this.server.getAccount(this.keypair.publicKey());

    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.PUBLIC,
    })

      .addOperation(
        StellarSdk.Operation.changeTrust({
          asset,
          limit: '100000000',
        }),
      )
      .setTimeout(30)
      .build();

    transaction.sign(this.keypair);

    const txx = await this.server.sendTransaction(transaction);

    this.checkTransactionStatus(this.server, txx.hash);
  }

  async checkTransactionStatus(server, hash: string) {
    while (true) {
      try {
        const transactionResult = await this.server.getTransaction(hash);

        if (transactionResult.status === 'SUCCESS') {
          let resultXdr = transactionResult.resultXdr;
          let resultMetaXdr = transactionResult.resultMetaXdr;

          console.log({ resultMetaXdr, resultXdr });

          // let returnValue = transactionMeta.v3().sorobanMeta().returnValue();
          // const transactionResult1 = returnValue.value();
          // return transactionResult1;
          return null;
        } else {
          console.error(
            'Transaction failed. Result:',
            transactionResult.status,
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
