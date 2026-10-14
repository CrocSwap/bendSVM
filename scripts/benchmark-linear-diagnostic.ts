// Diagnostic copies of the production generated C. No checked source or
// production ELF is modified. All variants run the same oracle fixtures.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileSbf } from './build.ts';

const dir='build/linear-diagnostic';
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const production=['build/linear-indexed-bend.so','build/linear-rust.so',
  'build/linear-indexed-benchmark.json','build/linear-indexed-vectors.json'];
const before=Object.fromEntries(production.map(file=>[file,hash(file)]));
const baseline=JSON.parse(fs.readFileSync('build/linear-indexed-benchmark.json','utf8'));
assert.equal(before['build/linear-indexed-bend.so'],baseline.bendElfHash);
assert.equal(before['build/linear-rust.so'],baseline.rustElfHash);
for(const [file,digest] of Object.entries(baseline.sourceHashes))
  assert.equal(hash(file),digest,`stale linear source: ${file}; rerun benchmark:linear`);
for(const [file,digest] of [
  ['build/linear-indexed-bend.h',baseline.bendHeaderHash],
  ['build/linear-indexed-bend.wire.h',baseline.bendWireHash],
  ['build/linear-indexed-bend.dispatch.h',baseline.bendDispatchHash],
  ['build/linear-indexed-bend-entry.c',baseline.bendEntryHash],
] as [string,string][]) assert.equal(hash(file),digest,`stale generated file: ${file}`);

function replaceOnce(source:string,oldText:string,newText:string):string {
  assert.equal(source.split(oldText).length,2,`expected one substitution: ${oldText}`);
  return source.replace(oldText,newText);
}
const getQ='bend_get32(a1, a3)',getW='bend_get32(a2, a3)';
const originalAdd=`bend__2e__2e__2f_sdk_2f_math_2e_add_5f_wrap(a4, bend_product(${getQ}, ${getW}))`;
const originalValid=`bend_Bool_2e_and(a5, bend_Bool_2e_and(bend_U32_2e_is_5f_le(${getQ}, 255u), bend_U32_2e_is_5f_le(${getW}, 255u)))`;
const nativeAdd=`bend_native_5f_dot_5f_step(a4, ${getQ}, ${getW})`;
const variants=[
  {name:'baseline',native:false,cache:false,pointer:false,ternary:false,u32:false,flat:false},
  {name:'cached-access',native:false,cache:true,pointer:false,ternary:false,u32:false,flat:false},
  {name:'native-step',native:true,cache:false,pointer:false,ternary:false,u32:false,flat:false},
  {name:'native-step-cached',native:true,cache:true,pointer:false,ternary:false,u32:false,flat:false},
  {name:'pointer-access',native:false,cache:false,pointer:true,ternary:false,u32:false,flat:false},
  {name:'native-step-pointer',native:true,cache:false,pointer:true,ternary:false,u32:false,flat:false},
  {name:'ternary-pick',native:false,cache:false,pointer:false,ternary:true,u32:false,flat:false},
  {name:'u32-step',native:false,cache:false,pointer:false,ternary:false,u32:true,flat:false},
  {name:'u32-step-pointer',native:false,cache:false,pointer:true,ternary:false,u32:true,flat:false},
  {name:'flat-buffer',native:false,cache:false,pointer:false,ternary:false,u32:false,flat:true},
  {name:'flat-buffer-u32',native:false,cache:false,pointer:false,ternary:false,u32:true,flat:true},
];
fs.mkdirSync(dir,{recursive:true});
const productionHeader=fs.readFileSync('build/linear-indexed-bend.h','utf8');
const productionEntry=fs.readFileSync('build/linear-indexed-bend-entry.c','utf8');
const nativeHelper=`static inline bend__2e__2e__2f_sdk_2f_math_2e_U64_t bend_native_5f_dot_5f_step(
    bend__2e__2e__2f_sdk_2f_math_2e_U64_t acc, bend_u32 q, bend_u32 w) {
  if (acc.tag != 0u) __builtin_unreachable();
  int qi = q <= 255u ? (q < 128u ? (int)q : (int)q - 256) : 0;
  int wi = w <= 255u ? (w < 128u ? (int)w : (int)w - 256) : 0;
  unsigned long long bits = ((unsigned long long)acc.as.c0.f1 << 32) | acc.as.c0.f0;
  bits += (unsigned long long)(long long)(qi * wi);
  return bend__2e__2e__2f_sdk_2f_math_2e_U64_make((bend_u32)bits, (bend_u32)(bits >> 32));
}
`;
const pointerGetter=`static inline bend_u32 bend_get32(bend_Row_t a0, bend_u32 a1) {
  if (a0.tag != 0u) __builtin_unreachable();
  __auto_type p4 = &a0.as.c0.f0;
  if (p4->tag != 0u) __builtin_unreachable();
  __auto_type p3 = (a1 & 16u) ? &p4->as.c0.f1 : &p4->as.c0.f0;
  if (p3->tag != 0u) __builtin_unreachable();
  __auto_type p2 = (a1 & 8u) ? &p3->as.c0.f1 : &p3->as.c0.f0;
  if (p2->tag != 0u) __builtin_unreachable();
  __auto_type p1 = (a1 & 4u) ? &p2->as.c0.f1 : &p2->as.c0.f0;
  if (p1->tag != 0u) __builtin_unreachable();
  __auto_type p0 = (a1 & 2u) ? &p1->as.c0.f1 : &p1->as.c0.f0;
  if (p0->tag != 0u) __builtin_unreachable();
  return (a1 & 1u) ? p0->as.c0.f1 : p0->as.c0.f0;
}`;
const u32Helper=`static inline bend__2e__2e__2f_sdk_2f_math_2e_U64_t bend_u32_5f_dot_5f_step(
    bend__2e__2e__2f_sdk_2f_math_2e_U64_t acc, bend_u32 q, bend_u32 w) {
  if (acc.tag != 0u) __builtin_unreachable();
  bend_u32 qi = q <= 255u ? (q < 128u ? q : q - 256u) : 0u;
  bend_u32 wi = w <= 255u ? (w < 128u ? w : w - 256u) : 0u;
  bend_u32 bits = acc.as.c0.f0 + qi * wi;
  return bend__2e__2e__2f_sdk_2f_math_2e_U64_make(bits, (bits & 0x80000000u) ? 0xffffffffu : 0u);
}
`;
const rows=[];
for(const variant of variants) {
  const stem=`${dir}/${variant.name}`;
  let header=productionHeader;
  if(variant.ternary) {
    let count=0;
    header=header.replace(/static inline ([^\n]+) (bend__2e__2e__2f_sdk_2f_buffer_2e_pick_7e_\d+)\(([^\n]+)\) \{[\s\S]*?\n\}/g,
      (_whole,result,name,args)=>{
        count++;
        return `static inline ${result} ${name}(${args}) {\n  if (a2 > 1u) __builtin_unreachable();\n  return a2 ? a0 : a1;\n}`;
      });
    assert.equal(count,5);
  }
  if(variant.pointer) {
    const start=header.indexOf('static inline bend_u32 bend_get32(');
    const end=header.indexOf('\nstatic inline ',start+7);
    assert(start>=0 && end>start);
    header=header.slice(0,start)+pointerGetter+'\n'+header.slice(end);
  }
  if(variant.native) {
    header=replaceOnce(header,originalAdd,nativeAdd);
    header=replaceOnce(header,'static __attribute__((noinline)) bend_SumResult_t bend_sum_5f_loop',
      nativeHelper+'\nstatic __attribute__((noinline)) bend_SumResult_t bend_sum_5f_loop');
  }
  if(variant.u32) {
    header=replaceOnce(header,originalAdd,
      `bend_u32_5f_dot_5f_step(a4, ${getQ}, ${getW})`);
    header=replaceOnce(header,'static __attribute__((noinline)) bend_SumResult_t bend_sum_5f_loop',
      u32Helper+'\nstatic __attribute__((noinline)) bend_SumResult_t bend_sum_5f_loop');
  }
  if(variant.cache) {
    header=replaceOnce(header,'        bend_u32 next2 = (a0 - 1u);',
      `        bend_u32 qv = ${getQ};\n        bend_u32 wv = ${getW};\n        bend_u32 next2 = (a0 - 1u);`);
    // Work within the sum-loop body only: the getter calls also occur elsewhere.
    const start=header.indexOf('static __attribute__((noinline)) bend_SumResult_t bend_sum_5f_loop');
    const end=header.indexOf('\nstatic ',start+7);
    assert(start>=0 && end>start);
    const loop=header.slice(start,end);
    header=header.slice(0,start)+loop.replaceAll(getQ,'qv').replaceAll(getW,'wv')
      .replace('bend_u32 qv = qv;','bend_u32 qv = '+getQ+';')
      .replace('bend_u32 wv = wv;','bend_u32 wv = '+getW+';')+header.slice(end);
  }
  if(variant.flat) {
    const start=header.indexOf('static __attribute__((noinline)) bend_SumResult_t bend_sum_5f_loop');
    const end=header.indexOf('\nstatic ',start+7);
    assert(start>=0 && end>start);
    const field=(root:string,index:number)=>{
      let expr=`${root}.as.c0.f0`;
      for(let shift=4;shift>=0;shift--) expr+=`.as.c0.f${(index>>shift)&1}`;
      return expr;
    };
    const setup=['  bend_u32 qbuf[32], wbuf[32];',
      ...Array.from({length:32},(_,i)=>`  qbuf[${i}] = ${field('a1',i)};`),
      ...Array.from({length:32},(_,i)=>`  wbuf[${i}] = ${field('a2',i)};`)].join('\n');
    const loop=header.slice(start,end);
    header=header.slice(0,start)+loop.replace('  for (;;) {',`${setup}\n  for (;;) {`)
      .replaceAll(getQ,'qbuf[a3 & 31u]').replaceAll(getW,'wbuf[a3 & 31u]')+header.slice(end);
  }
  fs.writeFileSync(`${stem}.h`,header);
  for(const suffix of ['.wire.h','.dispatch.h'])
    fs.copyFileSync(`build/linear-indexed-bend${suffix}`,`${dir}/linear-indexed-bend${suffix}`);
  // Quote includes resolve from this diagnostic directory.
  fs.writeFileSync(`${dir}/linear-indexed-bend.h`,header);
  fs.writeFileSync(`${stem}-entry.c`,productionEntry);
  compileSbf(`${stem}-entry.c`,stem);
  const metrics=`${stem}-raw.json`;
  const env={...process.env,LINEAR_ELF:path.resolve(`${stem}.so`),
    LINEAR_METRICS:path.resolve(metrics),
    LINEAR_VECTORS:path.resolve('build/linear-indexed-vectors.json'),
    CARGO_TARGET_DIR:path.resolve('target/linear')};
  for(let i=0;i<2;i++) {
    const result=spawnSync('cargo',['test','--locked','--test','linear_benchmark','--','--nocapture'],
      {stdio:'inherit',env});
    assert.ifError(result.error);assert.equal(result.status,0,`${variant.name} oracle mismatch`);
    if(i===0) fs.copyFileSync(metrics,`${metrics}.first`);
    else assert.equal(fs.readFileSync(metrics,'utf8'),fs.readFileSync(`${metrics}.first`,'utf8'));
  }
  const frames=JSON.parse(fs.readFileSync(`${stem}.stack.json`,'utf8')).maxFrameBytes;
  assert(frames<=4096,`${variant.name} exceeds SBF stack frame limit`);
  rows.push({name:variant.name,elfHash:hash(`${stem}.so`),frames,
    cases:JSON.parse(fs.readFileSync(metrics,'utf8'))});
}
for(const [file,digest] of Object.entries(before)) assert.equal(hash(file),digest,
  `diagnostic changed production artifact: ${file}`);
const names=(rows[0].cases as {name:string}[]).map(x=>x.name);
for(const row of rows) assert.deepEqual((row.cases as {name:string}[]).map(x=>x.name),names);
assert.deepEqual((rows[0].cases as {name:string;computeUnits:number}[]).map(x=>
  ({name:x.name,bendCU:x.computeUnits})),
  (baseline.rows as {name:string;bendCU:number}[]).map(x=>({name:x.name,bendCU:x.bendCU})),
  'regenerated diagnostic baseline differs from production');
fs.writeFileSync(`${dir}/report.json`,JSON.stringify({diagnosticOnly:true,
  diagnosticSourceHash:hash('scripts/benchmark-linear-diagnostic.ts'),
  productionHashes:before,repeatedIdentically:true,variants:rows},null,2)+'\n');
console.log(`Linear diagnostic passed: ${dir}/report.json`);
