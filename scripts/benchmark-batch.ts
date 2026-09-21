import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildProgram } from './program.ts';
import { run } from './build.ts';

fs.mkdirSync('build',{recursive:true});
fs.rmSync('build/batch-benchmark.json',{force:true});
await buildProgram('examples/batch/PROOF.bend','batch.process','build/batch');
await import('./build-batch-rust.ts');
const results:Record<string,any[]>={};
for(const kind of ['batch','batch-rust']) {
  const env={...process.env,BATCH_PROGRAM:`build/${kind}.so`,BATCH_METRICS:`build/${kind}-benchmark-raw.json`};
  const cargo=(args:string[])=>{
    const result=spawnSync('cargo',['test','--locked','--test','sbf',...args],{stdio:'inherit',env});
    assert.ifError(result.error);assert.equal(result.status,0);
  };
  cargo(['batch_sbf','--','--nocapture']);
  cargo(['batch_benchmark_fixed_fixtures','--','--ignored','--nocapture']);
  const first=fs.readFileSync(env.BATCH_METRICS,'utf8');
  cargo(['batch_benchmark_fixed_fixtures','--','--ignored','--nocapture']);
  assert.equal(fs.readFileSync(env.BATCH_METRICS,'utf8'),first,'Benchmark must reproduce exactly');
  results[kind]=JSON.parse(first);
}
assert.equal(results.batch.length,18);
const rows=results.batch.map((bend,i)=>{
  const rust=results['batch-rust'][i];
  const {cu:bendCu,...bendFixture}=bend,{cu:rustCu,...rustFixture}=rust;
  assert.deepEqual(bendFixture,rustFixture,`Inputs, post-state and errors must match: ${bend.name}`);
  return {name:bend.name,error:bend.error,bendCu,rustCu,ratio:bendCu/rustCu,
    fixtureSha256:crypto.createHash('sha256').update(JSON.stringify(bendFixture)).digest('hex')};
});
const files=['build/batch.so','build/batch-rust.so','build/batch.manifest.json','build/batch-rust.manifest.json',
  'build/batch.interface.json','build/batch.schema.json','build/batch-benchmark-raw.json','build/batch-rust-benchmark-raw.json',
  'scripts/benchmark-batch.ts','tests/batch_sbf.rs','tests/token_fixture.rs','Cargo.toml','Cargo.lock','package.json','package-lock.json'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/batch-benchmark.json',JSON.stringify({sharedConformancePassed:true,repeatedIdentically:true,
  fixture:'Public fixed test seeds; same instructions, accounts, final state and errors',rows,
  hostRust:run('rustc',['--version'],true),bun:process.versions.bun,
  bendBuild:JSON.parse(fs.readFileSync('build/batch.manifest.json','utf8')),
  rustBuild:JSON.parse(fs.readFileSync('build/batch-rust.manifest.json','utf8')),hashes},null,2)+'\n');
console.log('Batch benchmark: 18 matched operations; conformance, repeatability, identical fixtures/outcomes and hashes verified');
