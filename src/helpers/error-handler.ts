export enum KnownPrepareErrors {
  // TODO: Add more codes
  'Error(Contract, #205)' = 'Depositing is currently disabled for this pool. Please reach out to support.',
  'Error(Contract, #206)' = 'Swapping is currently disabled for this pool. Please reach out to support.',
  'Error(Contract, #207)' = 'Claiming is currently disabled for this pool. Please reach out to support.',
  'Error(Contract, #2006)' = 'The amount is too small to deposit to this pool',
}

function findErrorCode(error: string) {
  for (let str in KnownPrepareErrors) {
    let index = error.indexOf(str);
    if (index !== -1) {
      return str;
    }
  }
  return null;
}

export function SorobanPrepareTxErrorHandler(error: string) {
  const code = findErrorCode(error);
  return KnownPrepareErrors[code] ?? 'Oops. Something went wrong.';
}
