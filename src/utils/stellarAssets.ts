import { Asset } from '@stellar/stellar-sdk';

export const AQUA_CODE = 'AQUA';
export const AQUA_ISSUER =
  'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA';

export const stellarAssets = {
  XLM: Asset.native(),
  AQUA: new Asset(AQUA_CODE, AQUA_ISSUER),
};
