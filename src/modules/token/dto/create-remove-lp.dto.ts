export class UnlockAquaDto {
  senderPublicKey: string;
  amountToUnstake: number;
  signedTxXdr: string; // Require signed transaction for authentication
}
