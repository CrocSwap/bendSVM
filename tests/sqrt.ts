import assert from 'node:assert/strict';
import { testPure, type PureCase } from './pure.ts';

// Newton's method in unbounded host integers is deliberately different from
// the 64 trial-bit steps in the Bend implementation.
function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, next = (x + 1n) / 2n;
  while (next < x) { x = next; next = (x + n / x) / 2n; }
  assert(x * x <= n && (x + 1n) * (x + 1n) > n);
  return x;
}

export async function testSqrt() {
  await testPure('sdk/sqrt.bend', ['floor', 'geometric_mean'], 'build/sqrt', schema => {
    const floor = schema.exports.find(e => e.name === 'floor')!;
    const word = schema.types.find(t => t.name === floor.result)!;
    const wide = schema.types.find(t => t.name === floor.args[0])!;
    assert(word.kind === 'adt' && wide.kind === 'adt');
    const max = (1n << 64n) - 1n;
    const u64 = (n: bigint) => ({ constructor: word.variants[0].name,
      fields: { lo: Number(n & 0xffffffffn), hi: Number(n >> 32n) } });
    const u128 = (n: bigint) => ({ constructor: wide.variants[0].name,
      fields: { low: u64(n & max), high: u64(n >> 64n) } });
    const values = new Set<bigint>([0n, 1n, 2n, (1n << 128n) - 1n]);
    for (const root of [2n, 3n, 1000n, 1001n, (1n << 32n) - 1n,
      1n << 32n, (1n << 63n) - 1n, 1n << 63n, max]) {
      for (const delta of [-1n, 0n, 1n]) values.add(root * root + delta);
    }
    let seed = 0x799ec353;
    const word32 = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return BigInt(seed >>> 0); };
    const random = () => (word32() << 32n) | word32();
    const cases: PureCase[] = [];
    for (let i = 0; i < 40; i++) {
      const a = random(), b = random();
      values.add((a << 64n) | b);
      cases.push({ name: 'geometric_mean', args: [u64(a), u64(b)], expected: u64(sqrt(a * b)) });
    }
    for (const value of values) cases.push({ name: 'floor', args: [u128(value)], expected: u64(sqrt(value)) });
    return cases;
  });
}

if (import.meta.main) await testSqrt();
