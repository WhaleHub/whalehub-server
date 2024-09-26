import { SorobanPrepareTxErrorHandler } from '@/helpers/error-handler';
import { Injectable, Logger } from '@nestjs/common';
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
import { CreateAddLiquidityDto } from './dto/create-add-lp.dto';
import { AQUA_CODE, AQUA_ISSUER } from './stellar.service';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { DepositType } from '@/utils/models/enums';
import { LpBalanceEntity } from '@/utils/typeorm/entities/lp-balances.entity';

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
  whaleAqua: Asset;
  assetsCache = new Map<string, Asset>();
  logger = new Logger(SorobanService.name);

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

    this.whaleAqua = new Asset(WHLAQUA_CODE, this.issuingKeypair.publicKey());
  }

  async depositAQUAWHLHUB(
    assets: Asset[],
    amounts: Map<string, string>,
    senderPublicKey: string,
    depositType: DepositType,
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
          const tx = await this.getDepositTx(
            account.accountId(),
            poolsForAsset[0][1],
            assets,
            amounts,
          );

          tx.sign(this.signerKeypair);
          const mainTx = await this.server.sendTransaction(tx);
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
            poolRecord.assetA = assets[1];
            poolRecord.assetB = assets[0];
            poolRecord.assetAAmount = amounts.get(assets[1].code);
            poolRecord.assetBAmount = amounts.get(assets[0].code);
            poolRecord.txnHash = mainTx.hash;
            poolRecord.poolHash = poolsForAsset[0][0];
            poolRecord.senderPublicKey = senderPublicKey;
            poolRecord.depositType = depositType;
            await poolRecord.save().then(() => console.log('pool txn saved'));
          }
        });
      });
    } else {
      this.logger.log('trying to deposit into pool');

      const tx = await this.getDepositTx(
        account.accountId(),
        poolsForAsset[0][1],
        assets,
        amounts,
      );
      tx.sign(this.signerKeypair);

      const mainTx = await this.server.sendTransaction(tx);

      this.logger.debug(`deposit into pool hash: ${mainTx.hash}`);

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
        poolRecord.assetA = assets[1];
        poolRecord.assetB = assets[0];
        poolRecord.assetAAmount = amounts.get(assets[1].code);
        poolRecord.assetBAmount = amounts.get(assets[0].code);
        poolRecord.poolHash = poolsForAsset[0][0];
        poolRecord.txnHash = mainTx.hash;
        poolRecord.senderPublicKey = senderPublicKey;
        poolRecord.depositType = depositType;
        const newPoolRecord = await poolRecord.save();
        this.logger.debug(
          `saved txn for ${assets[0].code} and ${assets[1].code}`,
        );

        //store the balance for account
        const newBalanceRecord = new LpBalanceEntity();
        newBalanceRecord.account = user;
        newBalanceRecord.pool = newPoolRecord;
        newBalanceRecord.assetA = assets[0];
        newBalanceRecord.assetB = assets[1];
        newBalanceRecord.assetAAmount = amounts.get(assets[0].code);
        newBalanceRecord.assetBAmount = amounts.get(assets[1].code);
        newBalanceRecord.depositType = depositType;
        newBalanceRecord.senderPublicKey = senderPublicKey;
        await newBalanceRecord
          .save()
          .then(() => this.logger.log(`Saved new balance record`));
      }
    }
  }

  async addLiquidityTxn(createAddLiquidityDto: CreateAddLiquidityDto) {
    try {
      const account = await this.server.getAccount(
        this.signerKeypair.publicKey(),
      );

      const assets = [
        createAddLiquidityDto.asset1.code === 'XLM'
          ? Asset.native()
          : new Asset(
              createAddLiquidityDto.asset1.code,
              createAddLiquidityDto.asset1.issuer,
            ),
        createAddLiquidityDto.asset2.code === 'XLM'
          ? Asset.native()
          : new Asset(
              createAddLiquidityDto.asset2.code,
              createAddLiquidityDto.asset2.issuer,
            ),
      ];

      let poolsForAsset = await this.getPools(assets);

      const amounts = new Map<string, string>();
      amounts.set(
        assets[0].code,
        createAddLiquidityDto.asset1.amount.toString(),
      );
      amounts.set(
        assets[1].code,
        createAddLiquidityDto.asset2.amount.toString(),
      );

      const depositTxn = await this.getDepositTx(
        account.accountId(),
        poolsForAsset[1][1],
        assets,
        amounts,
      );

      const tx = await this.prepareTransaction(depositTxn);
      tx.sign(this.signerKeypair);

      const transaction = await this.server.sendTransaction(tx);
      this.logger.log('deposit into pool hash: ', transaction.hash);

      const { successful } = await this.checkTransactionStatus(
        this.server,
        transaction.hash,
      );

      if (successful) {
        const user = await this.userRepository.findOneBy({
          account: createAddLiquidityDto.senderPublicKey,
        });
        const newPoolRecord = new PoolsEntity();
        newPoolRecord.account = user;
        newPoolRecord.assetA = assets[0];
        newPoolRecord.assetB = assets[1];
        newPoolRecord.assetAAmount = amounts.get(assets[0].code);
        newPoolRecord.assetBAmount = amounts.get(assets[1].code);
        newPoolRecord.txnHash = transaction.hash;
        newPoolRecord.poolHash = poolsForAsset[1][0];
        newPoolRecord.senderPublicKey = createAddLiquidityDto.senderPublicKey;
        newPoolRecord.depositType = DepositType.LIQUIDITY_PROVISION;
        await newPoolRecord.save().then(() => this.logger.log(`Saved deposit`));

        //store the balance for account
        const newBalanceRecord = new LpBalanceEntity();
        newBalanceRecord.account = user;
        newBalanceRecord.pool = newPoolRecord;
        newBalanceRecord.assetA = assets[0];
        newBalanceRecord.assetB = assets[1];
        newBalanceRecord.assetAAmount = amounts.get(assets[0].code);
        newBalanceRecord.assetBAmount = amounts.get(assets[1].code);
        newBalanceRecord.depositType = DepositType.LIQUIDITY_PROVISION;
        newBalanceRecord.senderPublicKey =
          createAddLiquidityDto.senderPublicKey;
        await newBalanceRecord
          .save()
          .then(() => this.logger.log(`Saved new balance record`));
      }
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
        this.orderTokens(assets).map((asset) =>
          this.amountToUint128(amounts.get(this.getAssetString(asset))),
        ),
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

  bigintToIntU28Parts(value: BigInt): xdr.UInt128Parts {
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

    // console.log(
    //   'contract address of asset : ',
    //   this.getContactIdFromHash(hash),
    // );

    return this.getContactIdFromHash(hash);
  }

  getPoolReserves(assets: Asset[], poolId: string) {
    return this.buildSmartContactTx(
      ACCOUNT_FOR_SIMULATE,
      poolId,
      AMM_CONTRACT_METHOD.GET_RESERVES,
    )
      .then((tx) => {
        return this.simulateTx(
          tx,
        ) as Promise<SimulateTransactionSuccessResponse>;
      })
      .then(({ result }) => {
        if (result) {
          return this.orderTokens(assets).reduce((acc, asset, index) => {
            acc.set(
              this.getAssetString(asset),
              this.i128ToInt(result.retval.value()[index].value()),
            );
            return acc;
          }, new Map());
        }

        throw new Error('getPoolPrice fail');
      });
  }

  async estimateSwap(base: Asset, counter: Asset, amount: string) {
    const idA = this.getAssetContractId(base);
    const idB = this.getAssetContractId(counter);

    const [a, b] = idA > idB ? [counter, base] : [base, counter];

    return this.buildSmartContactTx(
      ACCOUNT_FOR_SIMULATE,
      AMM_SMART_CONTACT_ID,
      AMM_CONTRACT_METHOD.ESTIMATE_SWAP_ROUTED,
      this.scValToArray([this.assetToScVal(a), this.assetToScVal(b)]),
      this.assetToScVal(base),
      this.assetToScVal(counter),
      this.amountToUint128(amount),
    )
      .then((tx) => {
        return this.server.simulateTransaction(
          tx,
        ) as Promise<SimulateTransactionSuccessResponse>;
      })
      .then(({ result }) => {
        if (result) {
          // @ts-ignore
          return result.retval.value();
        }
        return 0;
      });
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

  u128ToDecimal(hi, lo) {
    let hiBigInt = BigInt(hi); // Convert hi to BigInt
    let loBigInt = BigInt(lo); // Convert lo to BigInt

    let decimalValue = (hiBigInt << 64n) + loBigInt;
    return decimalValue.toString();
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

  getPoolRewards(accountId: string, poolId: string) {
    return this.buildSmartContactTx(
      accountId,
      poolId,
      AMM_CONTRACT_METHOD.GET_REWARDS_INFO,
      this.publicKeyToScVal(accountId),
    )
      .then(
        (tx) =>
          this.server.simulateTransaction(
            tx,
          ) as Promise<SimulateTransactionSuccessResponse>,
      )
      .then(({ result }) => {
        if (result) {
          // @ts-ignore
          return result.retval.value().reduce((acc, val) => {
            const key = val.key().value().toString();
            if (key === 'exp_at' || key === 'last_time') {
              acc[key] = new BigNumber(
                this.i128ToInt(val.val().value()).toString(),
              )
                .times(1e7)
                .toNumber();
              return acc;
            }
            acc[key] = this.i128ToInt(val.val().value());
            return acc;
          }, {});
        }

        throw new Error('getPoolRewards error');
      });
  }

  async claimLPReward(
    assets: Asset[],
    senderPublicKey: string,
  ): Promise<number> {
    const account = await this.server.getAccount(senderPublicKey);

    const poolAddresses = await this.getPools(assets);

    const totalPoolRewardAmount = await this.getPoolRewards(
      account.accountId(),
      poolAddresses[1][0],
    );

    const tx = await this.getClaimRewardsTx(
      account.accountId(),
      poolAddresses[1][0],
    );
    tx.sign(this.signerKeypair);

    const ab = (await this.simulateTx(tx)) as any;

    const hi = ab.result.retval.value().hi().toBigInt();
    const lo = ab.result.retval.value().lo().toBigInt();

    const combinedValue = (hi << BigInt(64)) + lo;
    const precisionFactor = BigInt(10 ** 7);

    const humanReadableDecimal = (combinedValue / precisionFactor).toString();
    const fractionalPart = (combinedValue % precisionFactor)
      .toString()
      .padStart(7, '0');

    const finalReadableValue = `${humanReadableDecimal}.${fractionalPart}`;

    //TODO: use the swapped amount later
    // const transaction = await this.server.sendTransaction(tx);
    // console.log('claim transaction hash: ', transaction.hash);

    //TODO: create the db records
    return Number(finalReadableValue);
  }

  async claimReward(assets: Asset[], senderPublicKey: string) {
    const account = await this.server.getAccount(senderPublicKey);

    const poolAddresses = await this.getPools(assets);

    const totalPoolRewardAmount = await this.getPoolRewards(
      account.accountId(),
      poolAddresses[1][0],
    );

    const to_claim = totalPoolRewardAmount.to_claim;

    return 4;
    const tx = await this.getClaimRewardsTx(
      account.accountId(),
      poolAddresses[1][0],
    );
    tx.sign(this.signerKeypair);
    const transaction = await this.server.sendTransaction(tx);
    console.log('claim transaction hash: ', transaction.hash);
    //TODO: create the db records
  }

  getSwapChainedTx(
    accountId: string,
    base: Asset,
    chainedXDR: string,
    amount: string,
    minCounterAmount: string,
  ) {
    return this.buildSmartContactTx(
      accountId,
      AMM_SMART_CONTACT_ID,
      AMM_CONTRACT_METHOD.SWAP_CHAINED,
      this.publicKeyToScVal(accountId),
      xdr.ScVal.fromXDR(chainedXDR, 'base64'),
      this.assetToScVal(base),
      this.amountToUint128(amount),
      this.amountToUint128(minCounterAmount),
    ).then((tx) => this.prepareTransaction(tx));
  }

  async getSwapTx(
    amount: number,
    poolId: string,
    assets: Asset[],
  ): Promise<number> {
    this.logger.debug(`Pool id for swap: ${poolId}`);
    // const assets = [new Asset(AQUA_CODE, AQUA_ISSUER), this.whaleAqua];

    const assetAAddress = this.getAssetContractId(assets[0]);
    const assetBAddress = this.getAssetContractId(assets[1]);

    const contract = new StellarSdk.Contract(poolId);

    const value = BigInt(`${amount}0000000`);

    return;
    const call = contract.call(
      AMM_CONTRACT_METHOD.SWAP,
      StellarSdk.Address.fromString(this.signerKeypair.publicKey()).toScVal(),
      xdr.ScVal.scvU32(
        this.orderTokens(assets).findIndex(
          (asset) => this.getAssetContractId(asset) === assetAAddress,
        ),
      ), // asset_in index u32
      xdr.ScVal.scvU32(
        this.orderTokens(assets).findIndex(
          (asset) => this.getAssetContractId(asset) === assetBAddress,
        ),
      ), // asset_out index u32
      xdr.ScVal.scvU128(this.bigintToIntU28Parts(value)),
      xdr.ScVal.scvU128(this.bigintToIntU28Parts(BigInt(0))),
    );

    const account = await this.server.getAccount(
      this.signerKeypair.publicKey(),
    );

    const transactionBuilder = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.PUBLIC,
    })
      .addOperation(call)
      .setTimeout(30)
      .build();

    const tx = await this.prepareTransaction(transactionBuilder);
    tx.sign(this.signerKeypair);

    const sim = (await this.simulateTx(tx)) as any;

    // const response = await this.server.sendTransaction(tx);
    // console.log(response.hash);

    // // [x] uncomment later
    // const { returnValue } = await this.checkTransactionStatus(
    //   this.server,
    //   response.hash,
    // );

    // const returnValues = returnValue.value();

    const lo = sim.result.retval.value().hi().toBigInt();
    const hi = sim.result.retval.value().lo().toBigInt();

    //[x] USE LATER
    // const hi = returnValues.hi().toBigInt();
    // const lo = returnValues.lo().toBigInt();

    const combinedValue = (hi << BigInt(64)) + lo;
    const precisionFactor = BigInt(10 ** 7);

    const humanReadableDecimal = (combinedValue / precisionFactor).toString();
    const fractionalPart = (combinedValue % precisionFactor)
      .toString()
      .padStart(7, '0');

    const finalReadableValue = `${humanReadableDecimal}.${fractionalPart}`;

    console.log({ finalReadableValue });

    return Number(finalReadableValue);
  }

  getClaimRewardsTx(accountId: string, poolId: string) {
    return this.buildSmartContactTx(
      accountId,
      poolId,
      AMM_CONTRACT_METHOD.CLAIM,
      this.publicKeyToScVal(accountId),
    ).then((tx) => this.prepareTransaction(tx));
  }

  async checkTransactionStatus(
    server: StellarSdk.SorobanRpc.Server,
    hash: string,
  ): Promise<{
    successful: boolean;
    results?: xdr.TransactionResult;
    returnValue: any;
  }> {
    while (true) {
      try {
        const transactionResult = await server.getTransaction(hash);

        if (transactionResult.status === 'SUCCESS') {
          console.log('Transaction success:', transactionResult.status);
          let resultXdr = transactionResult.resultXdr;
          return {
            successful: true,
            results: resultXdr,
            returnValue: transactionResult.returnValue,
          };
        } else {
          console.error(
            'Transaction failed. Retrying... Status:',
            transactionResult.status,
          );
        }
      } catch (error) {
        console.error('Error fetching transaction status:', error);
      }
      // Wait for 5 seconds before retrying
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  getPoolInfo(accountId: string, poolId: string) {
    return this.buildSmartContactTx(
      accountId,
      poolId,
      AMM_CONTRACT_METHOD.GET_INFO,
    )
      .then(
        (tx) =>
          this.server.simulateTransaction(
            tx,
          ) as Promise<SimulateTransactionSuccessResponse>,
      )
      .then(({ result }) => {
        if (result) {
          // @ts-ignore
          return result.retval.value().reduce((acc, val) => {
            acc[val.key().value().toString()] =
              typeof val.val().value() === 'number'
                ? val.val().value()
                : val.val().value().hi
                  ? this.i128ToInt(val.val().value())
                  : val.val().value().toString();

            return acc;
          }, {});
        }

        throw new Error('getPoolRewards error');
      });
  }
}
