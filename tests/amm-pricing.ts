import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkedBook } from '../compiler/backend.ts';
import { testPure, type PureCase } from './pure.ts';

// Independent unbounded-integer oracle. No Bend helpers or emitted code are
// used to calculate expected values. testPure compares the checked interpreter
// and sanitized native backend; the same vectors are executed by LiteSVM.
export async function testAmmPricing() {
  await checkedBook('examples/amm/PROOF.bend');
  const source = fs.readFileSync('examples/amm/pricing.bend', 'utf8');
  const mutations = [
    ['swap rejection', 'def swap_valid', 'Math.Err{4}', 'Math.Ok{gross}'],
    ['deposit rejection', 'def deposit_valid', 'Math.Err{4}', 'Math.Ok{shares}'],
    ['withdrawal rejection', 'def withdraw_valid', 'Math.Err{4}', 'Math.Ok{shares}'],
    ['capacity error propagation', 'def output_with_capacity', 'Math.Err{code}\n    case', 'Math.Err{2}\n    case'],
  ];
  for (const [label, marker, before, after] of mutations) {
    const dir = fs.mkdtempSync('examples/.amm-negative-');
    try {
      const index = source.indexOf(marker);
      assert(index >= 0 && source.slice(index).includes(before));
      fs.writeFileSync(`${dir}/pricing.bend`, source.slice(0, index) + source.slice(index).replace(before, after));
      for (const file of ['LAWS.bend', 'PROOF.bend', 'amm.bend']) fs.copyFileSync(`examples/amm/${file}`, `${dir}/${file}`);
      await assert.rejects(() => checkedBook(`${dir}/PROOF.bend`), /expected|mismatch/i, label);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
  console.log('AMM pricing: four Bend laws and four negative mutations passed');
  await testPure('examples/amm/pricing.bend', ['fee', 'swap', 'deposit', 'withdraw'],
    'build/amm-pricing', schema => {
      const scalar = schema.types.find(t => t.name === schema.exports[0].args[0])!;
      const result = schema.types.find(t => t.name === schema.exports[0].result)!;
      assert(scalar.kind === 'adt' && result.kind === 'adt');
      const u64 = (n: bigint) => ({ constructor: scalar.variants[0].name,
        fields: { lo: Number(n & 0xffffffffn), hi: Number(n >> 32n) } });
      const ok = result.variants.find(v => v.name.endsWith('.Ok'))!.name;
      const err = result.variants.find(v => v.name.endsWith('.Err'))!.name;
      const cases: PureCase[] = [];
      const max = (1n << 64n) - 1n;
      const ceil = (a: bigint, b: bigint) => (a + b - 1n) / b;
      function add(name: string, args: bigint[], value: bigint, error = 0) {
        cases.push({ name, args: args.map(u64), expected: error
          ? { constructor: err, fields: { code: error } }
          : { constructor: ok, fields: { value: u64(value) } } });
      }
      const boundary = [0n, 1n, 2n, 333n, 334n, 9999n, 10000n,
        (1n << 32n) - 1n, 1n << 32n, 1n << 63n, max - 1n, max];
      for (const amount of boundary) add('fee', [amount], ceil(amount * 30n, 10000n));
      const triples: bigint[][] = [];
      for (const a of boundary) for (const b of boundary) triples.push([a, b, b]);
      // Tiny-trade fee cutoffs, overflow despite a fitting effective-input sum,
      // highly imbalanced reserves, and full-width products with fitting results.
      triples.push([10000n, 10000n, 1n], [10000n, 10000n, 2n],
        [10000n, 10000n, 333n], [10000n, 10000n, 334n],
        [max - 9999n, max, 10000n], [1n, max, 2n],
        [max - 10000n, max, 10000n], [max, max, max - 1n]);
      let seed = 0x5139bf27;
      const word = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return BigInt(seed >>> 0); };
      const random = () => (word() << 32n) | word();
      for (let i = 0; i < 40; i++) triples.push([random(), random(), random()]);
      for (const [a, b, c] of triples) {
        const charge = ceil(c * 30n, 10000n), effective = c - charge;
        const out = a + effective === 0n ? 0n : b * effective / (a + effective);
        const swapError = a === 0n || b === 0n || c === 0n ? 4
          : a + c > max ? 1 : effective === 0n || out === 0n ? 4 : 0;
        add('swap', [a, b, c], out, swapError);
        if (!swapError) {
          assert(out < b);
          assert((a + c) * (b - out) >= a * b, 'swap invariant');
          assert(out * (a + effective) <= b * effective, 'floor lower bound');
          assert((out + 1n) * (a + effective) > b * effective, 'floor upper bound');
        }
        const deposit = c === 0n ? 0n : ceil(a * b, c);
        const depositError = a === 0n || b === 0n || c === 0n ? 4 : deposit > max ? 1 : 0;
        add('deposit', [a, b, c], deposit, depositError);
        if (!depositError) {
          assert(deposit * c >= a * b);
          assert((deposit - 1n) * c < a * b);
        }
        const withdrawn = c === 0n ? 0n : a * b / c;
        const withdrawError = a === 0n || b === 0n || b >= c || withdrawn === 0n ? 4 : 0;
        add('withdraw', [a, b, c], withdrawn, withdrawError);
        if (!withdrawError) {
          assert(withdrawn < a);
          assert(withdrawn * c <= a * b);
          assert((withdrawn + 1n) * c > a * b);
        }
      }
      return cases;
    });
}

if (import.meta.main) await testAmmPricing();
