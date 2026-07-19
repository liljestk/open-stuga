/**
 * Small dependency-free QR encoder for local sensor labels. It intentionally
 * uses one conservative profile (Version 6, byte mode, ECC-L, mask 0), enough
 * for Stuga setup URIs while keeping onboarding offline and private.
 */
const VERSION = 6;
const SIZE = VERSION * 4 + 17;
const DATA_CODEWORDS = 136;
const BLOCK_DATA_CODEWORDS = 68;
const ECC_CODEWORDS = 18;

export function qrCodeMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  if (bytes.length > 134) throw new RangeError("Sensor setup URI is too long for the label QR profile");
  const data = encodeData(bytes);
  const blocks = [data.slice(0, BLOCK_DATA_CODEWORDS), data.slice(BLOCK_DATA_CODEWORDS)];
  const divisor = reedSolomonDivisor(ECC_CODEWORDS);
  const ecc = blocks.map((block) => reedSolomonRemainder(block, divisor));
  const codewords: number[] = [];
  for (let index = 0; index < BLOCK_DATA_CODEWORDS; index += 1) for (const block of blocks) codewords.push(block[index]!);
  for (let index = 0; index < ECC_CODEWORDS; index += 1) for (const block of ecc) codewords.push(block[index]!);
  return drawQr(codewords);
}

function encodeData(bytes: number[]): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  const capacity = DATA_CODEWORDS * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const result: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    result.push(bits.slice(index, index + 8).reduce((value, bit) => value * 2 + bit, 0));
  }
  for (let pad = 0; result.length < DATA_CODEWORDS; pad += 1) result.push(pad % 2 === 0 ? 0xec : 0x11);
  return result;
}

function appendBits(target: number[], value: number, count: number): void {
  for (let shift = count - 1; shift >= 0; shift -= 1) target.push((value >>> shift) & 1);
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let coefficient = 0; coefficient < degree; coefficient += 1) {
      result[coefficient] = gfMultiply(result[coefficient]!, root);
      if (coefficient + 1 < degree) result[coefficient] = result[coefficient]! ^ result[coefficient + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let index = 0; index < result.length; index += 1) result[index] = result[index]! ^ gfMultiply(divisor[index]!, factor);
  }
  return result;
}

function gfMultiply(left: number, right: number): number {
  let result = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((right >>> bit) & 1) * left;
  }
  return result;
}

function drawQr(codewords: number[]): boolean[][] {
  const modules = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const functions = Array.from({ length: SIZE }, () => new Array<boolean>(SIZE).fill(false));
  const setFunction = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    modules[y]![x] = dark;
    functions[y]![x] = true;
  };
  const finder = (centerX: number, centerY: number) => {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(centerX + dx, centerY + dy, distance !== 2 && distance !== 4);
    }
  };
  finder(3, 3); finder(SIZE - 4, 3); finder(3, SIZE - 4);
  for (let offset = 0; offset < SIZE; offset += 1) {
    if (!functions[6]![offset]) setFunction(offset, 6, offset % 2 === 0);
    if (!functions[offset]![6]) setFunction(6, offset, offset % 2 === 0);
  }
  for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
    setFunction(34 + dx, 34 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const format = (bits: number) => {
    for (let index = 0; index <= 5; index += 1) setFunction(8, index, bit(bits, index));
    setFunction(8, 7, bit(bits, 6)); setFunction(8, 8, bit(bits, 7)); setFunction(7, 8, bit(bits, 8));
    for (let index = 9; index < 15; index += 1) setFunction(14 - index, 8, bit(bits, index));
    for (let index = 0; index < 8; index += 1) setFunction(SIZE - 1 - index, 8, bit(bits, index));
    for (let index = 8; index < 15; index += 1) setFunction(8, SIZE - 15 + index, bit(bits, index));
    setFunction(8, SIZE - 8, true);
  };
  format(0);
  const dataBits = codewords.flatMap((codeword) => Array.from({ length: 8 }, (_, bitIndex) => (codeword >>> (7 - bitIndex)) & 1));
  let dataIndex = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < SIZE; vertical += 1) {
      const y = upward ? SIZE - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (functions[y]![x]) continue;
        const value = (dataBits[dataIndex] ?? 0) === 1;
        modules[y]![x] = value !== ((x + y) % 2 === 0); // mask 0
        dataIndex += 1;
      }
    }
    upward = !upward;
  }
  const formatData = 0b01 << 3; // ECC-L and mask 0
  let remainder = formatData;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  format(((formatData << 10) | remainder) ^ 0x5412);
  return modules;
}

function bit(value: number, index: number): boolean { return ((value >>> index) & 1) !== 0; }
