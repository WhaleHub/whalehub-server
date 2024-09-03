// return;
// // const poolIndex =
// // 'CCY2PXGMKNQHO7WNYXEWX76L2C5BH3JUW3RCATGUYKY7QQTRILBZIFWV';

// const tokens = [
//   new StellarSdk.Address(
//     'CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK',
//   ).toScVal(),
//   new StellarSdk.Address(
//     'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
//   ).toScVal(),
// ];

// // xdr.ScVal.scvBytes(Buffer.from(poolIndex, 'hex')),
// // xdr.ScVal.scvVec(tokens),

// const poolIndex = poolsForAsset[0][1];

// const desiredAmounts = [100n, 1n].map(this.bigintToInt128Parts);
// const minShares = this.bigintToInt128Parts(1n);

// const contract = new StellarSdk.Contract(AMM_SMART_CONTACT_ID);
// //  xdr.ScVal.scvVec(
// //             desiredAmounts.map(StellarSdk.xdr.ScVal.scvU128),
// //           ),
// // xdr.ScVal.scvU128(minShares),
// // this.orderTokens([...assets]).map((asset) =>
// //   this.assetToScVal(asset),
// // )
// const transaction = new StellarSdk.TransactionBuilder(account, {
//   fee: StellarSdk.BASE_FEE,
//   networkPassphrase: StellarSdk.Networks.PUBLIC,
// })
//   .addOperation(
//     contract.call(
//       'deposit',
//       StellarSdk.Address.fromString(this.keypair.publicKey()).toScVal(),
//       xdr.ScVal.scvVec(tokens),
//       xdr.ScVal.scvBytes(poolIndex),
//       this.scValToArray(
//         this.orderTokens(assets).map((asset) =>
//           this.amountToUint128(amounts.get(this.getAssetString(asset))),
//         ),
//       ),
//       xdr.ScVal.scvU128(minShares),
//     ),
//   )
//   .setTimeout(30)
//   .build();

// const txnPrepared = await this.prepareTransaction(transaction);
// txnPrepared.sign(this.keypair);

// const txn = await this.server.sendTransaction(txnPrepared);
// console.log(txn);

// const ab = await this.checkTransactionStatus(this.server, txn.hash);
