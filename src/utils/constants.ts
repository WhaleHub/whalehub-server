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

addPool('WHLAQUA:AQUA', {
  poolHash: 'CD4ASKG2XVZRAUXSXPCGUSBIX4JOC2TNA2FDBAPUNJB7RSUG5YGRQRSF',
  binary:
    '<Buffer b2 e0 2f cf ca 6c 96 f8 ad 5c bd 84 e7 78 4a 77 7b 36 d9 c9 6a 24 59 40 2c 4f 45 84 62 aa b7 f0>',
});

addPool('XLM:AQUA', {
  poolHash: 'CCY2PXGMKNQHO7WNYXEWX76L2C5BH3JUW3RCATGUYKY7QQTRILBZIFWV',
  binary:
    ' <Buffer 9a c7 a9 cd e2 3a c2 ad a1 11 05 ee aa 42 e4 3c 2e a8 33 2c a0 aa 8f 41 f5 8d 71 60 27 4d 71 8e>',
});

export { aquaPools, getPoolKey, parseBufferString };
