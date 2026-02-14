interface PoolValues {
  poolHash: string;
  binary: string;
}

const aquaPools = {} as PoolValues;

function addPool(poolKey: string, defaultValues: PoolValues) {
  // Split the key into tokens and sort them alphabetically
  const tokens = poolKey.split(':');
  const sortedKey = tokens.sort().join(':');

  console.log(sortedKey);

  // If the pool doesn't already exist, add it with the default values
  if (!aquaPools[sortedKey]) {
    aquaPools[sortedKey] = defaultValues;
  }

  // Return the pool data (either newly created or existing)
  return aquaPools[sortedKey];
}

function parseBufferString(bufferString) {
  // Remove the '<Buffer ' prefix and '>' suffix
  const hexString = bufferString
    .replace('<Buffer ', '')
    .replace('>', '')
    .trim();

  // Split the hex string into an array of hex values
  const hexArray = hexString.split(' ');

  // Convert the hex values into a Buffer
  return Buffer.from(hexArray.map((byte) => parseInt(byte, 16)));
}

function getPoolKey(assetA, assetB) {
  const codes = [assetA.code, assetB.code].sort();
  return `${codes[0]}:${codes[1]}`;
}

function formatAmountToBigInt(amount) {
  const formattedAmount = Number(amount).toFixed(7);
  const value = BigInt(`${formattedAmount.replace('.', '')}`);
  return value;
}

addPool('BLUB:AQUA', {
  poolHash: 'NEW_AQUA_BLUB_POOL_HASH', // TODO: Replace with new AQUA/BLUB pool hash after pool creation (Step 9)
  binary: '', // TODO: Update with new pool binary after pool creation
});

addPool('XLM:AQUA', {
  poolHash: 'CCY2PXGMKNQHO7WNYXEWX76L2C5BH3JUW3RCATGUYKY7QQTRILBZIFWV',
  binary:
    ' <Buffer 9a c7 a9 cd e2 3a c2 ad a1 11 05 ee aa 42 e4 3c 2e a8 33 2c a0 aa 8f 41 f5 8d 71 60 27 4d 71 8e>',
});

export { aquaPools, getPoolKey, parseBufferString, formatAmountToBigInt };
