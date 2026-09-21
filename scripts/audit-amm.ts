// Evidence consistency check, not a substitute for the written source review.
// Run after the full tests, refinements, and matched benchmark have completed.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function hashes(values: Record<string,string>) {
  assert(Object.keys(values).length > 0);
  for (const [file, expected] of Object.entries(values)) assert.equal(hash(file), expected, `Stale evidence: ${file}`);
}
const suite = read('build/refinement-suite.json');
assert.equal(suite.passed, true);
assert.equal(suite.checks.length, 11);
assert.equal(new Set(suite.checks.map((c:any) => c.name)).size, 11);
for (const check of suite.checks) {
  assert.equal(hash(check.artifact), check.sha256, `Stale refinement report: ${check.name}`);
  const report = read(check.artifact);
  if (report.hashes) hashes(report.hashes);
}
for (const [name, count, mutations] of [['sqrt',69,5],['amm-pricing',11,6],['amm',27,8]] as const) {
  const report = read(`build/${name}-refinement.json`);
  hashes(report.hashes);
  assert.equal(report.positive.claims.length, count);
  assert(report.positive.claims.every((c:any) => c.result === 'unsat'));
  assert.equal(report.mutations.length, mutations);
  assert(report.mutations.every((m:any) => m.concreteWitness));
}
const amm = read('build/amm-refinement.json');
assert(amm.importMismatchesRejected && amm.uncoveredInstructionRejected);
assert.equal(amm.positive.bindings.length,4);
assert(amm.positive.bindings.every((b:any) => b.result==='checked'));
assert(read('build/sqrt-refinement.json').incorrectHelperRejected);
const bend = read('build/amm.manifest.json');
hashes(bend.inputs);
for (const [suffix, expected] of Object.entries(bend.artifacts)) assert.equal(hash(`build/amm${suffix}`), expected);
const rust = read('build/amm-rust.manifest.json');
hashes(rust.sources);
assert.equal(hash(rust.elf),rust.elfSha256);
assert(rust.reproducible);
const benchmark = read('build/amm-benchmark.json');
hashes(benchmark.hashes);
assert(benchmark.repeatedIdentically && benchmark.sharedConformancePassed);
assert.deepEqual(benchmark.bendBuild,bend);
assert.deepEqual(benchmark.rustBuild,rust);
assert.deepEqual(benchmark.rows.map((r:any)=>r.operation),[
  'initialize','deposit','swap_base','swap_quote','withdraw',
  'reject_slippage','reject_zero_input','reject_locked_shares']);
assert(benchmark.rows.every((r:any)=>r.bendCU>0 && r.rustCU>0));
for (const [name,count] of [['amm-pricing',588],['sqrt',111]] as const) {
  assert.equal(read(`build/${name}-vectors.json`).length,count);
  assert.equal(read(`build/${name}-metrics.json`).cases,count);
}
const tests=fs.readFileSync('build/amm-final-test-suite.log','utf8');
assert(/test result: ok\. 55 passed; 0 failed; 1 ignored;/.test(tests),
  'Full regression suite unfinished or failed: expected 55 passed and the explicit benchmark ignored; inspect build/amm-final-test-suite.log');
assert.match(fs.readFileSync('build/amm-final-refinement-suite.log','utf8'),/All 11 source refinement commands passed/);
assert.match(fs.readFileSync('build/amm-benchmark-check.log','utf8'),/AMM benchmark: shared conformance, identical fixtures, repeated CU results, and source\/toolchain hashes recorded/);
const artifacts=['build/refinement-suite.json','build/amm.manifest.json','build/amm-rust.manifest.json',
  'build/amm-benchmark.json','build/amm-final-test-suite.log','build/amm-final-refinement-suite.log',
  'build/amm-benchmark-check.log','build/amm-pricing-metrics.json','build/sqrt-metrics.json'];
const sources: string[]=[];
function walk(dir: string) {
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if(entry.name.startsWith('.')) continue;
    const file=`${dir}/${entry.name}`;
    if(entry.isDirectory())walk(file);
    else if(/\.(?:ts|py|rs|bend|c|h|ld|json|md)$/.test(file))sources.push(file);
  }
}
for(const dir of ['compiler','runtime','sdk','examples','tests','benchmarks','scripts','verification','docs'])walk(dir);
sources.push('README.md','package.json','package-lock.json','Cargo.toml','Cargo.lock');
fs.writeFileSync('build/amm-acceptance.json',JSON.stringify({
  evidenceConsistent:true, tests:55, benchmarkExplicitlyExecuted:true, refinements:11,
  artifacts:Object.fromEntries(artifacts.map(file=>[file,hash(file)])),
  sources:Object.fromEntries(sources.sort().map(file=>[file,hash(file)])),
  scope:'Local experimental AMM milestone; source proofs, SBF tests and observed benchmark costs. No end-to-end compiler proof or independent security audit.',
},null,2)+'\n');
console.log('AMM evidence audit passed: current source/artifact hashes, full suites, and matched benchmark');
