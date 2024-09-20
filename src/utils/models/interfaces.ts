export interface Balance {
  asset_type:
    | 'native'
    | 'credit_alphanum4'
    | 'credit_alphanum12'
    | 'liquidity_pool_shares';
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}
export interface SummarizedAssets {
  [key: string]: {
    assetCode: string;
    totalAmount: string;
  };
}
