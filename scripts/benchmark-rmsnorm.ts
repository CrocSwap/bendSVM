// Bounded specialization of basanos's integer RMSNorm: a 64-cell signed row
// and one gain shared across the row. Both programs use the same canonical
// input bytes, expected checksum, SBF target, and LiteSVM measurement path.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { compileSbf, prepareBend, run, sbfTools } from './build.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';

const indexed=process.argv.slice(2).includes('--indexed');
const prefixes=process.argv.slice(2).includes('--prefixes');
assert.ok(process.argv.slice(2).every(arg=>arg==='--indexed'||arg==='--prefixes'),'unknown benchmark argument');
const source=indexed?'benchmarks/rmsnorm-indexed.bend':'benchmarks/rmsnorm.bend';
const name=(indexed?'rmsnorm-indexed':'rmsnorm')+(prefixes?'-prefix':'');
const vectors=prefixes?'build/rmsnorm-prefix-vectors.json':'build/rmsnorm-vectors.json';
const stem = `build/${name}-bend`;
fs.mkdirSync('build', { recursive: true });
prepareBend();
const book = await checkedBook(source);
const emitted = new Backend(book).emit(['normalize']);
writeArtifacts(stem, emitted);
const codec = wireCodec(emitted.schema);
assert.equal(codec.call('normalize', [0, makeRow(Array(64).fill(0)), 0]).length, 649);

fs.writeFileSync(`${stem}-entry.c`, `#include "solana_min.h"
#include "${name}-bend.dispatch.h"
u64 entrypoint(const u8 *input) {
  if (read_le(input,8) != 0 || read_le(input+8,8) != 649) return 1;
  u8 output[14]; u64 written=0;
  if (!bend_wire_dispatch(input+16,649,output,sizeof(output),&written) || written!=14) return 2;
  sol_set_return_data(output,written); return 0;
}
`);
compileSbf(`${stem}-entry.c`, stem);
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const bendHash = hash(`${stem}.so`);
compileSbf(`${stem}-entry.c`, stem);
assert.equal(hash(`${stem}.so`), bendHash, 'Bend rebuild differs');

const tools = sbfTools();
const rustc = path.resolve(tools, '../../rust/bin/rustc');
const rustElf = 'build/rmsnorm-rust.so';
const rustFlags = ['--edition=2021', '--crate-type=cdylib', '--target', 'sbpf-solana-solana',
  '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort'];
run(rustc, [...rustFlags, 'benchmarks/rmsnorm-rust/main.rs', '-o', rustElf]);
const rustHash = hash(rustElf);
run(rustc, [...rustFlags, 'benchmarks/rmsnorm-rust/main.rs', '-o', rustElf]);
assert.equal(hash(rustElf), rustHash, 'Rust rebuild differs');

function makeRow(values: number[]): WireValue {
  assert.equal(values.length, 64);
  const types = new Map(emitted.schema.types.map(t => [t.name, t]));
  let next = 0;
  const build = (name: string): WireValue => {
    const type = types.get(name)!;
    assert.equal(type.kind, 'adt');
    const variant = type.variants[0];
    if (name.endsWith('math.U64')) {
      const bits = BigInt.asUintN(64, BigInt(values[next++]));
      return { constructor: variant.name, fields: {
        lo: Number(bits & 0xffffffffn), hi: Number(bits >> 32n) } };
    }
    return { constructor: variant.name, fields: Object.fromEntries(
      variant.fields.map(field => [field.name, build(field.type)])) };
  };
  const row = build('Row');
  assert.equal(next, 64);
  return row;
}

function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value, y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + value / x) >> 1n; }
  return x;
}
const floorDiv = (numerator: bigint, divisor: bigint) =>
  numerator >= 0n ? numerator / divisor : -((-numerator + divisor - 1n) / divisor);
function expected(values: number[], n: number, gain: number): [number, bigint] {
  if (n === 0 || gain > 65535 || values.slice(0,n).some(v => Math.abs(v) >= 1 << 26)) return [1,0n];
  const square = values.slice(0,n).reduce((sum,v) => sum + BigInt(v)*BigInt(v), 0n);
  const root = isqrt(((square / BigInt(n)) + 17n) << 20n);
  let checksum = 0n;
  for (const v of values.slice(0,n)) {
    const q = floorDiv((BigInt(v) << 23n) + root, 2n*root);
    checksum = BigInt.asIntN(64, checksum + floorDiv(q*BigInt(gain)+2048n,4096n));
  }
  return [0,checksum];
}
const reply = (error: number, checksum: bigint) => {
  const type = emitted.schema.types.find(t => t.name === 'Reply')!;
  const word = emitted.schema.types.find(t => t.name.endsWith('math.U64'))!;
  const bits = BigInt.asUintN(64, checksum);
  return codec.encode('Reply', { constructor: type.variants[0].name, fields: { error,
    checksum: { constructor: word.variants[0].name, fields: {
      lo: Number(bits & 0xffffffffn), hi: Number(bits >> 32n) } } } });
};
const samples = Array.from({length:64}, (_,i) => (i%7===0?-1:1)*(700+(i*7919)%150000));
const standardCases = [
  ...[8,16,32,64].map(n => ({name:`mixed_${n}`,n,gain:17777,values:samples})),
  ...[0,7,8,15,31,32,63].map(i => ({name:`single_${i}`,n:64,gain:17777,
    values:Array.from({length:64},(_,j)=>j===i?(i%2?-12345:23456):0)})),
  {name:'all_zero_64',n:64,gain:17777,values:Array(64).fill(0)},
  {name:'gain_zero_32',n:32,gain:0,values:samples},
  {name:'limit_positive_8',n:8,gain:65535,values:[67108863,...Array(63).fill(0)]},
  {name:'limit_negative_8',n:8,gain:65535,values:[-67108863,...Array(63).fill(0)]},
  {name:'reject_oversize',n:8,gain:17777,values:[67108864,...Array(63).fill(0)]},
  {name:'reject_gain',n:8,gain:65536,values:samples},
  {name:'reject_empty',n:0,gain:17777,values:samples},
];
const prefixCases=[];
for(let n=0;n<=64;n++) {
  const mixed=Array.from({length:64},(_,i)=>(i%3===0?-1:1)*(13+(i*7919)%150000));
  const ignoredTail=mixed.map((value,i)=>i<n?value:67108864);
  const invalid=[...mixed];if(n)invalid[n-1]=-67108864;
  for(const [label,values] of [['mixed',mixed],['ignored-tail',ignoredTail],['invalid-last',invalid]] as const)
    prefixCases.push({name:`${label}_${n}`,n,gain:n%3===0?65535:17777,values});
}
const cases=prefixes?prefixCases:standardCases;
assert.equal(cases.length,prefixes?195:18);
fs.writeFileSync(vectors, JSON.stringify(cases.map(c => {
  const [error,checksum] = expected(c.values,c.n,c.gain);
  return {name:c.name, input:[...codec.call('normalize',[c.n,makeRow(c.values),c.gain])],
    expected:[...reply(error,checksum)]};
}),null,2)+'\n');

function measure(elf: string, result: string) {
  const env = {...process.env, RMSNORM_ELF:elf, RMSNORM_METRICS:result, RMSNORM_PREFIX_CASES:prefixes?'1':'0',
    CARGO_TARGET_DIR:path.resolve('target/rmsnorm')};
  for (let i=0;i<2;i++) {
    const runResult = spawnSync('cargo',['test','--locked','--test','rmsnorm_benchmark','--','--nocapture'],
      {stdio:'inherit',env});
    assert.ifError(runResult.error);
    assert.equal(runResult.status,0,`${elf} conformance failed`);
    if (i===0) fs.copyFileSync(result,`${result}.first`);
    else assert.equal(fs.readFileSync(result,'utf8'),fs.readFileSync(`${result}.first`,'utf8'),
      `${elf} CU did not repeat`);
  }
  const observed=JSON.parse(fs.readFileSync(result,'utf8')) as {name:string;computeUnits:number}[];
  assert.deepEqual(observed.map(row=>row.name),cases.map(row=>row.name),'measured case inventory');
  return observed;
}
const bend = measure(`${stem}.so`,`build/${name}-bend-raw.json`);
const rust = measure(rustElf,`build/${name}-rust-raw.json`);
assert.deepEqual(bend.map(x=>x.name),rust.map(x=>x.name));
const rows = bend.map((x,i)=>({name:x.name,bendCU:x.computeUnits,rustCU:rust[i].computeUnits}));
const mixed = rows.filter(row=>row.name.startsWith('mixed_'));
const slope = (key: 'bendCU'|'rustCU') => {
  const xy = mixed.map(row=>[Number(row.name.split('_')[1]),row[key]]);
  const sx = xy.reduce((s,x)=>s+x[0],0), sy=xy.reduce((s,x)=>s+x[1],0);
  const sxx=xy.reduce((s,x)=>s+x[0]*x[0],0), sxy=xy.reduce((s,x)=>s+x[0]*x[1],0);
  return (xy.length*sxy-sx*sy)/(xy.length*sxx-sx*sx);
};
const sources = [source,'benchmarks/rmsnorm-rust/main.rs',
  'scripts/benchmark-rmsnorm.ts','tests/rmsnorm_benchmark.rs','sdk/math.bend',
  'sdk/wide.bend','sdk/sqrt.bend','sdk/buffer.bend','sdk/zip-fold.bend',
  'compiler/backend.ts', 'compiler/tagged-sum-ir.ts','compiler/native-arithmetic.ts',
  ...fs.readdirSync('compiler').filter(f => f.endsWith('.ts')).map(f => `compiler/${f}`)];
fs.writeFileSync(`build/${name}-benchmark.json`,JSON.stringify({
  source:'bounded scalar-gain specialization of basanos integer RMSNorm',
  matrix:prefixes?'prefixes':'standard',caseCount:cases.length,vectorsSha256:hash(vectors),
  runtime:'LiteSVM 0.7.1',target:'SBF v0 / generic',repeatedIdentically:true,
  compiler:run(path.join(tools,'clang'),['--version'],true).split('\n')[0],
  rustCompiler:run(rustc,['--version'],true),
  bendElfHash:bendHash,rustElfHash:rustHash,
  bendHeaderHash:hash(`${stem}.h`),
  bendWireHash:hash(`${stem}.wire.h`),
  bendDispatchHash:hash(`${stem}.dispatch.h`),
  bendEntryHash:hash(`${stem}-entry.c`),
  bendElfBytes:fs.statSync(`${stem}.so`).size,rustElfBytes:fs.statSync(rustElf).size,
  sourceHashes:Object.fromEntries(sources.map(file=>[file,hash(file)])),
  mixedSlopeCUPerElement:prefixes?null:{bend:slope('bendCU'),rust:slope('rustCU')},rows},null,2)+'\n');
console.log(rows);
