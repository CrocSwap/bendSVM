// Diagnostic lowering experiment. Copies generated checked-Bend artifacts and
// replaces only the generated u64 divmod and/or exact u32×u32 multiplication.
// This does not change the production compiler, SDK, or benchmark ELFs.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, sbfTools } from './build.ts';
import { Backend, checkedBook } from '../compiler/backend.ts';

const root = 'build/rmsnorm-native-arithmetic';
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const production = ['build/rmsnorm-bend.so', 'build/rmsnorm-rust.so',
  'build/rmsnorm-benchmark.json', 'build/rmsnorm-vectors.json'];
const before = Object.fromEntries(production.map(file => {
  assert(fs.existsSync(file), `run benchmark:rmsnorm first: ${file}`);
  return [file, hash(file)];
}));
const baseline = JSON.parse(fs.readFileSync('build/rmsnorm-benchmark.json', 'utf8')) as {
  bendElfHash:string; rustElfHash:string; bendHeaderHash:string;
  bendWireHash:string; bendDispatchHash:string; bendEntryHash:string;
  sourceHashes:Record<string,string>;
  rows:{name:string;bendCU:number;rustCU:number}[];
};
assert.equal(hash('build/rmsnorm-bend.so'), baseline.bendElfHash, 'stale Bend ELF');
assert.equal(hash('build/rmsnorm-rust.so'), baseline.rustElfHash, 'stale Rust ELF');
for (const [file,digest] of [
  ['build/rmsnorm-bend.h',baseline.bendHeaderHash],
  ['build/rmsnorm-bend.wire.h',baseline.bendWireHash],
  ['build/rmsnorm-bend.dispatch.h',baseline.bendDispatchHash],
  ['build/rmsnorm-bend-entry.c',baseline.bendEntryHash],
]) assert.equal(hash(file),digest,`stale generated RMSNorm artifact: ${file}`);
for (const [file,digest] of Object.entries(baseline.sourceHashes))
  assert.equal(hash(file), digest, `stale RMSNorm source: ${file}`);

const word = 'bend__2e__2e__2f_sdk_2f_math_2e_U64_t';
const divResult = 'bend__2e__2e__2f_sdk_2f_math_2e_DivResult_t';
const prefix = 'bend__2e__2e__2f_sdk_2f_math_2e_';
const replacements: Record<string,{signature:string; check:string; source:string}> = {
  divmod: {
    signature:`static inline ${divResult} ${prefix}divmod(`,
    check:'div_5f_guard',
    source:`static inline ${divResult} ${prefix}divmod(${word} a0, ${word} a1) {
  unsigned long long n = ((unsigned long long)a0.as.c0.f1 << 32) | a0.as.c0.f0;
  unsigned long long d = ((unsigned long long)a1.as.c0.f1 << 32) | a1.as.c0.f0;
  if (!d) return ${prefix}DivErr_make(3u);
  unsigned long long q = n / d;
  unsigned long long r = n % d;
  return ${prefix}DivOk_make(${prefix}Division_make(
    ${prefix}U64_make((bend_u32)q, (bend_u32)(q >> 32)),
    ${prefix}U64_make((bend_u32)r, (bend_u32)(r >> 32))));
}`,
  },
  mul32: {
    signature:`static inline ${word} ${prefix}mul32(`,
    check:'mul32_5f_parts',
    source:`static inline ${word} ${prefix}mul32(bend_u32 a0, bend_u32 a1) {
  unsigned long long product = (unsigned long long)a0 * (unsigned long long)a1;
  return ${prefix}U64_make((bend_u32)product, (bend_u32)(product >> 32));
}`,
  },
};
function replaceFunction(source: string, name: keyof typeof replacements): string {
  const {signature,check,source:replacement} = replacements[name];
  assert.equal(source.split(signature).length, 2, `generated ${name} signature changed`);
  const start = source.indexOf(signature);
  const end = source.indexOf('\n}', start);
  assert(end > start, `generated ${name} body changed`);
  const old = source.slice(start, end + 2);
  assert(old.includes(check), `generated ${name} implementation changed`);
  return source.slice(0,start) + replacement + source.slice(end + 2);
}
function checkElf(elf: string, nativeDiv: boolean, nativeMul: boolean): number {
  const tools = sbfTools();
  assert.match(run(path.join(tools,'llvm-readelf'), ['-h',elf], true), /Flags:\s+0x0\b/);
  const symbols = run(path.join(tools,'llvm-readelf'), ['-s',elf], true);
  const allowed = new Set(['sol_set_return_data','sol_memcpy_','sol_memmove_','sol_memset_']);
  for (const line of symbols.split('\n').filter(line => /\bUND\b/.test(line))) {
    const symbol = line.trim().split(/\s+/).at(-1)!;
    assert(symbol === 'UND' || allowed.has(symbol), `unexpected diagnostic import: ${symbol}`);
  }
  const disassembly = run(path.join(tools,'llvm-objdump'), ['-d',elf], true);
  if (nativeDiv) assert.match(disassembly, /\bdiv64\b/, 'expected native SBF div64');
  if (nativeMul) assert.match(disassembly, /\bmul64\b/, 'expected native SBF mul64');
  return fs.statSync(elf).size;
}
const tools = sbfTools();
const clang = path.join(tools,'clang');
assert(run(clang,['--version'],true).includes('20.1.7'), 'expected pinned Anza Clang');
const flags = ['--target=sbf','-mcpu=generic','-O2','-fPIC','-ffreestanding',
  '-fno-builtin','-fno-stack-protector','-std=c17','-Wall','-Wextra','-Werror',
  '-Wframe-larger-than=4096','-fstack-usage','-ffunction-sections','-fdata-sections'];
fs.mkdirSync(root,{recursive:true});
// Regenerate the limb baseline from the same checked source and backend, with
// only the generic native arithmetic option disabled. The production ELF is
// untouched and remains the comparison target for the native-both variant.
const limbSource = new Backend(await checkedBook('benchmarks/rmsnorm.bend'),
  {nativeArithmetic:false}).emit(['normalize']).c;
const variants = [
  {name:'limb_bend', changes:[]},
  {name:'native_divmod', changes:['divmod']},
  {name:'native_mul32', changes:['mul32']},
  {name:'native_both', changes:['divmod','mul32']},
] as const;
const results = [];
for (const variant of variants) {
  const dir = `${root}/${variant.name}`;
  fs.mkdirSync(dir,{recursive:true});
  for (const suffix of ['.wire.h','.dispatch.h'])
    fs.copyFileSync(`build/rmsnorm-bend${suffix}`, `${dir}/rmsnorm-bend${suffix}`);
  fs.copyFileSync('build/rmsnorm-bend-entry.c', `${dir}/entry.c`);
  let source = limbSource;
  for (const change of variant.changes) source = replaceFunction(source,change);
  fs.writeFileSync(`${dir}/rmsnorm-bend.h`,source);
  run(clang,[...flags,`-I${dir}`,'-Ibuild','-Iruntime','-c',`${dir}/entry.c`,
    '-o',`${dir}/entry.o`]);
  const frames = fs.readFileSync(`${dir}/entry.su`,'utf8').trim().split('\n')
    .map(line => Number(line.split('\t')[1]));
  assert(frames.every(Number.isFinite) && Math.max(...frames) <= 4096,
    'diagnostic SBF stack frame exceeds limit');
  const elf = `${dir}/bend.so`;
  run(path.join(tools,'ld.lld'), ['-z','notext','-shared','--Bdynamic',
    'runtime/sbf.ld','--entry','entrypoint','-z','max-page-size=4096',
    '--gc-sections',`${dir}/entry.o`,'build/rmsnorm-bend.memory.o','-o',elf]);
  const elfBytes = checkElf(elf,variant.changes.includes('divmod'),
    variant.changes.includes('mul32'));
  const metrics = `${dir}/metrics.json`;
  const env = {...process.env,RMSNORM_ELF:path.resolve(elf),
    RMSNORM_METRICS:path.resolve(metrics),CARGO_TARGET_DIR:path.resolve('target/rmsnorm')};
  for (let i=0;i<2;i++) {
    const result = spawnSync('cargo',['test','--locked','--test','rmsnorm_benchmark',
      '--','--nocapture'],{stdio:'inherit',env});
    assert.ifError(result.error);
    assert.equal(result.status,0,`${variant.name} conformance failed`);
    if (i===0) fs.copyFileSync(metrics,`${metrics}.first`);
    else assert.equal(fs.readFileSync(metrics,'utf8'),
      fs.readFileSync(`${metrics}.first`,'utf8'),`${variant.name} CU did not repeat`);
  }
  const rows = JSON.parse(fs.readFileSync(metrics,'utf8')) as
    {name:string;computeUnits:number}[];
  assert.deepEqual(rows.map(row=>row.name),baseline.rows.map(row=>row.name));
  if (variant.name === 'native_both')
    assert.deepEqual(rows.map(row=>row.computeUnits),baseline.rows.map(row=>row.bendCU),
      'production native lowering must match diagnostic CU on every fixture');
  results.push({name:variant.name,changes:variant.changes,elfSha256:hash(elf),
    elfBytes,maxFrameBytes:Math.max(...frames),rows});
}
for (const [file,digest] of Object.entries(before))
  assert.equal(hash(file),digest,`diagnostic changed production output: ${file}`);
const report = {diagnosticOnly:true,sourceSha256:hash('scripts/benchmark-rmsnorm-native-arithmetic.ts'),
  productionHashes:before,repeatedIdentically:true,baselineRows:baseline.rows,variants:results};
fs.writeFileSync(`${root}/report.json`,JSON.stringify(report,null,2)+'\n');
console.log(`RMSNorm native arithmetic diagnostic passed: ${root}/report.json`);
