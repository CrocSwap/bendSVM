// Bounded Basanos quantized linear_row: one 32-term signed i8 dot product,
// followed by the two fixed-point rounding stages. Both programs use the
// same canonical input, independent oracle and LiteSVM measurement path.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { compileSbf, prepareBend, run, sbfTools } from './build.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';

const indexed=process.argv.includes('--indexed');
const sourceFile=indexed?'benchmarks/linear-indexed.bend':'benchmarks/linear.bend';
const stem=indexed?'build/linear-indexed-bend':'build/linear-bend';
const reportFile=indexed?'build/linear-indexed-benchmark.json':'build/linear-benchmark.json';
const vectorsFile=indexed?'build/linear-indexed-vectors.json':'build/linear-vectors.json';
fs.mkdirSync('build', { recursive: true });
prepareBend();
const book = await checkedBook(sourceFile);
const emitted = new Backend(book).emit(['linear']);
writeArtifacts(stem, emitted);
const codec = wireCodec(emitted.schema);
assert.equal(codec.call('linear', [0, makeRow(Array(32).fill(0)),
  makeRow(Array(32).fill(0)), 0, 0]).length, 333);

fs.writeFileSync(`${stem}-entry.c`, `#include "solana_min.h"
#include "${path.basename(stem)}.dispatch.h"
u64 entrypoint(const u8 *input) {
  if (read_le(input,8) != 0 || read_le(input+8,8) != 333) return 1;
  u8 output[14]; u64 written=0;
  if (!bend_wire_dispatch(input+16,333,output,sizeof(output),&written) || written!=14) return 2;
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
const rustElf = 'build/linear-rust.so';
const rustFlags = ['--edition=2021', '--crate-type=cdylib', '--target', 'sbpf-solana-solana',
  '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort'];
run(rustc, [...rustFlags, 'benchmarks/linear-rust/main.rs', '-o', rustElf]);
const rustHash = hash(rustElf);
run(rustc, [...rustFlags, 'benchmarks/linear-rust/main.rs', '-o', rustElf]);
assert.equal(hash(rustElf), rustHash, 'Rust rebuild differs');
for (const elf of [`${stem}.so`, rustElf])
  assert.match(run(path.join(tools,'llvm-readelf'),['-h',elf],true),
    /Flags:\s+0x0\b/,`${elf} must target SBF v0`);

function makeRow(values: number[]): WireValue {
  assert.equal(values.length, 32);
  const types = new Map(emitted.schema.types.map(t => [t.name, t]));
  let next = 0;
  const build = (name: string): WireValue => {
    if (name === 'U32') return values[next++];
    const type = types.get(name)!;
    assert.equal(type.kind, 'adt');
    const variant = type.variants[0];
    return { constructor: variant.name, fields: Object.fromEntries(
      variant.fields.map(field => [field.name, build(field.type)])) };
  };
  const row = build('Row');
  assert.equal(next, 32);
  return row;
}

const signedByte = (value: number) => value < 128 ? value : value - 256;
function expected(q: number[], w: number[], n: number, a: number, m: number): [number, bigint] {
  if (n === 0 || n > 32 || a > 1048576 || m > 65535 ||
      q.slice(0,n).concat(w.slice(0,n)).some(v => v > 255)) return [1,0n];
  let dot = 0n;
  for (let i=0; i<n; i++) dot += BigInt(signedByte(q[i])) * BigInt(signedByte(w[i]));
  const t = (dot * BigInt(m) + 32768n) >> 16n;
  return [0,(t * BigInt(a) + 32768n) >> 16n];
}
const reply = (error: number, output: bigint) => {
  const type = emitted.schema.types.find(t => t.name === 'Reply')!;
  const word = emitted.schema.types.find(t => t.name.endsWith('math.U64'))!;
  const bits = BigInt.asUintN(64, output);
  return codec.encode('Reply', { constructor: type.variants[0].name, fields: { error,
    output: { constructor: word.variants[0].name, fields: {
      lo: Number(bits & 0xffffffffn), hi: Number(bits >> 32n) } } } });
};
const qs = Array.from({length:32}, (_,i) => (i*37+11)%256);
const ws = Array.from({length:32}, (_,i) => (i*79+63)%256);
const zero = Array(32).fill(0);
const withCell = (base: number[], at: number, value: number) =>
  base.map((v,i)=>i===at?value:v);
const cases = [
  ...[4,8,16,32].map(n => ({name:`mixed_${n}`,n,a:500000,m:50000,q:qs,w:ws})),
  ...[0,7,8,15,16,31].map(i => ({name:`single_${i}`,n:32,a:500000,m:50000,
    q:withCell(zero,i,i%2?128:127),w:withCell(zero,i,127)})),
  {name:'all_zero_32',n:32,a:500000,m:50000,q:zero,w:zero},
  {name:'positive_tie',n:1,a:1048576,m:256,q:withCell(zero,0,128),w:withCell(zero,0,255)},
  {name:'negative_tie',n:1,a:1048576,m:256,q:withCell(zero,0,128),w:withCell(zero,0,1)},
  {name:'scale_zero',n:32,a:0,m:50000,q:qs,w:ws},
  {name:'reject_q_byte',n:8,a:500000,m:50000,q:withCell(qs,3,256),w:ws},
  {name:'reject_w_byte',n:8,a:500000,m:50000,q:qs,w:withCell(ws,7,256)},
  {name:'reject_scale',n:8,a:1048577,m:50000,q:qs,w:ws},
  {name:'reject_multiplier',n:8,a:500000,m:65536,q:qs,w:ws},
  {name:'reject_empty',n:0,a:500000,m:50000,q:qs,w:ws},
  {name:'reject_long',n:33,a:500000,m:50000,q:qs,w:ws},
  ...(indexed?[]:[{name:'reject_huge',n:0xffffffff,a:500000,m:50000,q:qs,w:ws}]),
];
fs.writeFileSync(vectorsFile, JSON.stringify(cases.map(c => {
  const [error,output] = expected(c.q,c.w,c.n,c.a,c.m);
  return {name:c.name, input:[...codec.call('linear',[c.n,makeRow(c.q),makeRow(c.w),c.a,c.m])],
    expected:[...reply(error,output)]};
}),null,2)+'\n');

function measure(elf: string, result: string) {
  const env = {...process.env, LINEAR_ELF:elf, LINEAR_METRICS:result,
    LINEAR_VECTORS:path.resolve(vectorsFile),
    CARGO_TARGET_DIR:path.resolve('target/linear')};
  for (let i=0;i<2;i++) {
    const runResult = spawnSync('cargo',['test','--locked','--test','linear_benchmark','--','--nocapture'],
      {stdio:'inherit',env});
    assert.ifError(runResult.error);
    assert.equal(runResult.status,0,`${elf} conformance failed`);
    if (i===0) fs.copyFileSync(result,`${result}.first`);
    else assert.equal(fs.readFileSync(result,'utf8'),fs.readFileSync(`${result}.first`,'utf8'),
      `${elf} CU did not repeat`);
  }
  return JSON.parse(fs.readFileSync(result,'utf8')) as {name:string;computeUnits:number}[];
}
const bend = measure(`${stem}.so`,`${stem}-raw.json`);
const rust = measure(rustElf,'build/linear-rust-raw.json');
assert.deepEqual(bend.map(x=>x.name),rust.map(x=>x.name));
const rows = bend.map((x,i)=>({name:x.name,bendCU:x.computeUnits,rustCU:rust[i].computeUnits}));
const mixed = rows.filter(row=>row.name.startsWith('mixed_'));
const slope = (key: 'bendCU'|'rustCU') => {
  const xy = mixed.map(row=>[Number(row.name.split('_')[1]),row[key]]);
  const sx = xy.reduce((s,x)=>s+x[0],0), sy=xy.reduce((s,x)=>s+x[1],0);
  const sxx=xy.reduce((s,x)=>s+x[0]*x[0],0), sxy=xy.reduce((s,x)=>s+x[0]*x[1],0);
  return (xy.length*sxy-sx*sy)/(xy.length*sxx-sx*sx);
};
const sources = [sourceFile,'benchmarks/linear-rust/main.rs',
  'scripts/benchmark-linear.ts','tests/linear_benchmark.rs','sdk/math.bend',
  'sdk/buffer.bend',...(indexed?[]:['sdk/zip-fold.bend','sdk/signed.bend']),
  'compiler/backend.ts', 'compiler/tagged-sum-ir.ts','compiler/native-arithmetic.ts',
  ...fs.readdirSync('compiler').filter(f => f.endsWith('.ts')).map(f => `compiler/${f}`)];
fs.writeFileSync(reportFile,JSON.stringify({
  source:`bounded 32-term signed-byte quantized linear row from basanos (${indexed?'indexed':'zip-fold'} Bend source)`,
  vectorsFile,
  fixtureContract:'333 canonical instruction bytes -> 14 return bytes; no accounts or CPIs',
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
  mixedSlopeCUPerElement:{bend:slope('bendCU'),rust:slope('rustCU')},rows},null,2)+'\n');
console.log(rows);
