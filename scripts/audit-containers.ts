// Evidence consistency gate. The written acceptance review must additionally
// explain how each requirement is covered and retain the trust boundaries.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

fs.rmSync('build/containers-acceptance.json',{force:true});
const read=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes=(values:Record<string,string>)=>{
  assert(Object.keys(values).length);
  for(const [file,expected] of Object.entries(values))assert.equal(hash(file),expected,`Stale evidence: ${file}`);
};
const suite=read('build/refinement-suite.json');
assert.equal(suite.passed,true);
assert.deepEqual(suite.checks.map((c:any)=>c.name),[
  'batch','fold','iteration','buffer','arithmetic','division','multiplication','wide',
  'sqrt','amm-pricing','amm','vault','vesting-payout','vesting-process','exchange']);
for(const check of suite.checks){
  assert.equal(hash(check.artifact),check.sha256,`Stale report: ${check.name}`);
  const report=read(check.artifact);if(report.hashes)hashes(report.hashes);
}
function hasCounterexample(value:any):boolean {
  if(!value||typeof value!=='object')return false;
  return value.result==='sat'||Object.values(value).some(hasCounterexample);
}
for(const [name,claims,mutations,cases] of [
  ['generics',11,2,37],['buffer',7,4,181],['iteration',5,2,325],['fold',3,3,1092],
] as const){
  const report=read(`build/${name}-refinement.json`);
  assert.equal(report.positive.claims.length,claims);
  assert(report.positive.claims.every((c:any)=>c.result==='unsat'));
  assert.equal(report.mutations.length,mutations);
  assert(report.mutations.every(hasCounterexample));
  const metrics=read(`build/${name}-metrics.json`);
  assert.equal(metrics.cases,cases);
  assert.equal(read(`build/${name}-vectors.json`).length,cases);
  assert.equal(metrics.elf_bytes,fs.statSync(`build/${name}.so`).size);
  assert(metrics.max_cu>0);
}
const batch=read('build/batch-refinement.json');
hashes(batch.hashes);
assert.equal(batch.positive.claims.length,788);
assert(batch.positive.claims.every((c:any)=>c.result==='unsat'));
assert.equal(batch.positive.arithmeticBinding.result,'checked');
assert.deepEqual(batch.bindingNegatives,[...batch.positive.arithmeticBinding.functions,...batch.positive.arithmeticBinding.types]);
assert(batch.uncoveredProtocolRejected);
assert.equal(batch.mutations.length,7);
assert(batch.mutations.every((m:any)=>hasCounterexample(m)&&m.replay));
assert.equal(hash('build/batch-refinement.model.json'),batch.positive.modelSha256);
assert.equal(read('build/batch-pure-metrics.json').cases,120);
const reproducibility=read('build/reproducibility.json');
assert.deepEqual(reproducibility.map((r:any)=>r.name),['vault','vesting','exchange']);
for(const entry of reproducibility){
  const manifest=read(`build/${entry.name}.manifest.json`);
  hashes(manifest.inputs);
  assert.deepEqual(entry.artifacts,manifest.artifacts);
  for(const [suffix,expected] of Object.entries(entry.artifacts))assert.equal(hash(`build/${entry.name}${suffix}`),expected);
}
for(const claim of read('build/fold-refinement.json').positive.claims){
  assert.equal(claim.cases.length,65);
  assert(claim.cases.every((c:any,i:number)=>c.fuel===i&&c.result==='unsat'));
}
const benchmark=read('build/batch-benchmark.json');
hashes(benchmark.hashes);
assert(benchmark.sharedConformancePassed&&benchmark.repeatedIdentically);
const bend=read('build/batch.manifest.json'),rust=read('build/batch-rust.manifest.json');
hashes(bend.inputs);hashes(rust.sources);
for(const [suffix,expected] of Object.entries(bend.artifacts))assert.equal(hash(`build/batch${suffix}`),expected);
assert.equal(hash(rust.elf),rust.elfSha256);assert(rust.reproducible);
assert.deepEqual(benchmark.bendBuild,bend);assert.deepEqual(benchmark.rustBuild,rust);
assert.deepEqual(benchmark.rows.map((r:any)=>r.name),[
  ...[1,2,3,4].flatMap(n=>[`fund-${n}`,`settle-${n}`,`replay-${n}`]),
  'empty','bad-fuel','overflow','funding-insufficient','unauthorized','late-frozen']);
assert(benchmark.rows.every((r:any)=>r.bendCu>0&&r.rustCu>0));
const tests=fs.readFileSync('build/containers-regression.log','utf8');
assert(/test result: ok\. 68 passed; 0 failed; 2 ignored;/.test(tests),
  'Full regression unfinished or failed: expected 68 passed, 0 failed and two explicit benchmarks ignored; inspect build/containers-regression.log');
assert.match(tests,/All three public program builds reproduce test binaries and generated interfaces/);
assert.match(tests,/AMM source-law mutations, client checks and byte-identical public build passed/);
assert.match(tests,/Batch laws and four negative mutations passed; complete source transition differential cases built/);
assert.match(fs.readFileSync('build/containers-refinement-suite.log','utf8'),/All 15 source refinement commands passed/);
const artifacts=[...new Set<string>([
  'build/refinement-suite.json',...suite.checks.map((c:any)=>c.artifact),
  'build/generics-refinement.json','build/generics.model.json',
  'build/batch-refinement.model.json','build/batch-arithmetic-refinement.json','build/batch-arithmetic.model.json',
  ...['generics','buffer','iteration','fold','batch-pure'].flatMap(name=>[
    `build/${name}-metrics.json`,`build/${name}-vectors.json`,`build/${name}.schema.json`,`build/${name}.so`]),
  'build/batch-benchmark.json','build/batch-benchmark-raw.json','build/batch-rust-benchmark-raw.json',
  'build/batch.manifest.json','build/batch-rust.manifest.json',
  'build/containers-regression.log','build/containers-refinement-suite.log','build/reproducibility.json',
])];
const sources:string[]=[];
function walk(dir:string){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name.startsWith('.'))continue;
    const file=`${dir}/${entry.name}`;
    if(entry.isDirectory())walk(file);
    else if(/\.(?:ts|py|rs|bend|c|h|ld|json|md)$/.test(file))sources.push(file);
  }
}
for(const dir of ['compiler','runtime','sdk','examples','tests','benchmarks','scripts','verification','docs'])walk(dir);
sources.push('README.md','package.json','package-lock.json','Cargo.toml','Cargo.lock');
fs.writeFileSync('build/containers-acceptance.json',JSON.stringify({
  evidenceConsistent:true,tests:68,ignoredBenchmarks:2,refinements:15,
  artifacts:Object.fromEntries(artifacts.map(f=>[f,hash(f)])),
  sources:Object.fromEntries(sources.sort().map(f=>[f,hash(f)])),
  scope:'Bounded generic containers, iteration and batch settlement. Source proofs and observed execution costs; no end-to-end compiler proof.',
},null,2)+'\n');
console.log('Containers evidence audit passed: current hashes, full suites and matched batch benchmark');
