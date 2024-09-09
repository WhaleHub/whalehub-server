import { SorobanPrepareTxErrorHandler } from '@/helpers/error-handler';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, Keypair, xdr } from '@stellar/stellar-sdk';
import * as StellarSdk from '@stellar/stellar-sdk';
import { sha256 } from 'js-sha256';
import * as binascii from 'binascii';
import SimulateTransactionSuccessResponse = StellarSdk.SorobanRpc.Api.SimulateTransactionSuccessResponse;
import BigNumber from 'bignumber.js';
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateAddLiquidityDto } from './dto/crate-add-lp.dto';
import { AQUA_CODE, AQUA_ISSUER } from './stellar.service';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';

export const AMM_SMART_CONTACT_ID =
  'CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK';

export const JEWEL_CONTRACT_ID =
  'CD4IRHDYW3GHPBJIVTFJFS62RR3EH4CGIE6DTQLNO3UMIMPXGSAPRMWG';

const ACCOUNT_FOR_SIMULATE =
  'GCX6LOZ6ZEXBHLTPOPP2THN74K33LMT4HKSPDTWSLVCF4EWRGXOS7D3V';

const WHLAQUA_CODE = 'WHLAQUA';

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

enum JEWEL_CONTRACT_METHOD {
  GET_POOL = 'get_pool',
  GET_POOLS = 'get_pools',
  DEPOSIT = 'deposit',
  HELLO = 'hello',
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
  private issuingSecret: string;
  private signerSecret: string;
  private issuingKeypair: Keypair;
  private signerKeypair: Keypair;
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

  async startServer() {
    this.issuingSecret = this.configService.get<string>(
      'SOROBAN_ISSUER_SECRET_KEY',
    );
    this.signerSecret = this.configService.get<string>(
      'SOROBAN_SIGNER_SECRET_KEY',
    );

    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_ENDPOINT');
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl, { allowHttp: true });

    this.issuingKeypair = Keypair.fromSecret(this.issuingSecret);
    this.signerKeypair = Keypair.fromSecret(this.signerSecret);

    this.whaleAcqua = new Asset(WHLAQUA_CODE, this.issuingKeypair.publicKey());
  }

  async depositAQUAWHLHUB(
    assets: Asset[],
    amounts: Map<string, string>,
    senderPublicKey: string,
  ) {
    const account = await this.server.getAccount(
      this.signerKeypair.publicKey(),
    );

    let poolsForAsset = await this.getPools(assets);
    if (poolsForAsset.length === 0) {
      const account = await this.server.getAccount(
        this.signerKeypair.publicKey(),
      );
      this.getInitConstantPoolTx(
        account.accountId(),
        assets[0],
        assets[1],
        10,
      ).then((tx) => {
        const xdr = tx.toEnvelope().toXDR('base64');
        const initPoolTxn = new StellarSdk.Transaction(
          xdr,
          StellarSdk.Networks.PUBLIC,
        );
        initPoolTxn.sign(this.signerKeypair);
        this.server.sendTransaction(initPoolTxn).then(async (res) => {
          if (!res) {
            return;
          }
          const hash = res.hash;

          await this.checkTransactionStatus(this.server, hash);

          //deposit tokens to pool
          this.getDepositTx(
            account.accountId(),
            poolsForAsset[0][1],
            assets,
            amounts,
          ).then(async (tx) => {
            tx.sign(this.signerKeypair);
            const mainTx = await this.server.sendTransaction(tx);

            const result = await this.checkTransactionStatus(
              this.server,
              mainTx.hash,
            );

            if (result.successful) {
              const user = new UserEntity();
              user.account = this.signerKeypair.publicKey();

              const poolRecord = new PoolsEntity();
              // poolRecord.account = user;
              // poolRecord.assetA = assets[0];
              // poolRecord.assetB = assets[1];
              // poolRecord.assetAAmount = amounts[assets[0].code];
              // poolRecord.assetBAmount = amounts[assets[1].code];
              // poolRecord.txnHash = mainTx.hash;
              // poolRecord.poolHash = poolsForAsset[0][0];
              // poolRecord.poolBinary = poolsForAsset[0][1];
              // poolRecord.senderPublicKey = senderPublicKey;
              await poolRecord.save();
            }
          });
        });
      });
    } else {
      console.log('trying to deposit into pool');

      this.getDepositTx(
        account.accountId(),
        poolsForAsset[0][1],
        assets,
        amounts,
      ).then(async (tx) => {
        tx.sign(this.signerKeypair);
        const mainTx = await this.server.sendTransaction(tx);

        console.log('deposit into pool hash: ', mainTx.hash);

        const result = await this.checkTransactionStatus(
          this.server,
          mainTx.hash,
        );

        if (result.successful) {
          const user = await this.userRepository.findOneBy({
            account: senderPublicKey,
          });

          const poolRecord = new PoolsEntity();
          poolRecord.account = user;
          poolRecord.assetA = assets[0];
          poolRecord.assetB = assets[1];
          poolRecord.assetAAmount = '10';
          poolRecord.assetBAmount = '10';
          poolRecord.txnHash = mainTx.hash;
          poolRecord.poolHash = poolsForAsset[0][0];
          poolRecord.senderPublicKey = senderPublicKey;
          await poolRecord.save();
        }
      });
    }
  }

  async addLiqudityTxn(createAddLiquidityDto: CreateAddLiquidityDto) {
    try {
      const account = await this.server.getAccount(
        this.signerKeypair.publicKey(),
      );
      const transferTxn = new StellarSdk.Transaction(
        createAddLiquidityDto.signedTxXdr,
        StellarSdk.Networks.PUBLIC,
      );
      transferTxn.sign(this.signerKeypair);

      const assets = [new Asset(AQUA_CODE, AQUA_ISSUER), this.whaleAcqua];
      const poolInfo = await this.getPools(assets);
      const poolHash = poolInfo[0][1];
      const contractIds = assets.map((asset) => this.getAssetContractId(asset));

      const txx = await this.buildSmartContactTx(
        account.accountId(),
        'CCY2OUH2GSQ3VUCK26WUPFKVWYOR7XR7EQ3LJBJGBCQPMPEJC2MIINLY',
        JEWEL_CONTRACT_METHOD.DEPOSIT,
        StellarSdk.Address.fromString(this.signerKeypair.publicKey()).toScVal(),
        this.amountToUint128('1'),
        this.amountToUint128('1'),
        StellarSdk.Address.fromString(contractIds[0]).toScVal(),
        StellarSdk.Address.fromString(contractIds[1]).toScVal(),
        StellarSdk.Address.fromString(AMM_SMART_CONTACT_ID).toScVal(),
        this.hashToScVal(poolHash),
        this.amountToUint128('0.0000001'),
      );
      const tx = await this.prepareTransaction(txx);
      console.log(tx, 'passed');

      tx.sign(this.signerKeypair);
      const transaction = await this.server.sendTransaction(tx);

      const { results } = await this.checkTransactionStatus(
        this.server,
        transaction.hash,
      );

      //TODO: Keep deposit record on pool table
    } catch (err) {
      console.log(err);
    }
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
          // amounts.get(this.getAssetString(asset))
          return this.amountToUint128('10');
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

  bigintToInt128Parts(value: BigInt): xdr.UInt128Parts {
    // Ensure value is a bigint
    if (typeof value !== 'bigint') {
      throw new Error('Value must be a bigint');
    }

    // 64 bits = 2^64
    const HIGH_MASK = 0xffffffffffffffffn;

    const high = Number(value >> 64n);
    const low = Number(value & HIGH_MASK);

    return new StellarSdk.xdr.UInt128Parts({
      hi: new StellarSdk.xdr.Uint64(high),
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

    console.log(
      'contract address of asset : ',
      this.getContactIdFromHash(hash),
    );

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
    // const account = await this.server.getAccount(this.keypair.publicKey());
    // const transaction = new StellarSdk.TransactionBuilder(account, {
    //   fee: StellarSdk.BASE_FEE,
    //   networkPassphrase: StellarSdk.Networks.PUBLIC,
    // })
    //   .addOperation(
    //     StellarSdk.Operation.changeTrust({
    //       asset,
    //       limit: '100000000',
    //     }),
    //   )
    //   .setTimeout(30)
    //   .build();
    // transaction.sign(this.keypair);
    // const txx = await this.server.sendTransaction(transaction);
    // this.checkTransactionStatus(this.server, txx.hash);
  }

  async checkTransactionStatus(
    server: StellarSdk.SorobanRpc.Server,
    hash: string,
  ): Promise<{
    successful: boolean;
    results?: xdr.TransactionResult;
  }> {
    while (true) {
      try {
        const transactionResult = await server.getTransaction(hash);

        if (transactionResult.status === 'SUCCESS') {
          let resultXdr = transactionResult.resultXdr;
          return { successful: true, results: resultXdr };
        } else if (transactionResult.status === 'NOT_FOUND') {
          console.log('Transaction is pending. Retrying...');
          await new Promise((resolve) => setTimeout(resolve, 5000));
        } else {
          console.error(
            'Transaction failed. Result:',
            transactionResult.status,
          );
          return { successful: false };
        }
      } catch (error) {
        console.error('Error fetching transaction status:', error);
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
