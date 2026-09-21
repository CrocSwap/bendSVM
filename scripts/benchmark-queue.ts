import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildProgram } from './program.ts';
import { run } from './build.ts';

fs.mkdirSync('build',{recursive:true});
fs.rmSync('build/queue-benchmark.json',{force:true});
await buildProgram('examples/queue/PROOF.bend','queue.process','build/queue','examples/queue/storage.json');
await import('./build-queue-rust.ts');
const results:Record<string,any[]>={};
for(const kind of ['queue','queue-rust']) {
  const env={...process.env,QUEUE_PROGRAM:`build/${kind}.so`,QUEUE_METRICS:`build/${kind}-benchmark-raw.json`};
  const cargo=(args:string[])=>{
    const result=spawnSync('cargo',['test','--locked','--test','sbf',...args],{stdio:'inherit',env});
    assert.ifError(result.error);assert.equal(result.status,0);
  };
  cargo(['queue_sbf','--','--nocapture']);
  cargo(['queue_benchmark_fixed_fixtures','--','--ignored','--nocapture']);
  const first=fs.readFileSync(env.QUEUE_METRICS,'utf8');
  cargo(['queue_benchmark_fixed_fixtures','--','--ignored','--nocapture']);
  assert.equal(fs.readFileSync(env.QUEUE_METRICS,'utf8'),first,'Benchmark must reproduce exactly');
  results[kind]=JSON.parse(first);
}
assert.equal(results.queue.length,26);
const rows=results.queue.map((bend,i)=>{
  const rust=results['queue-rust'][i];
  const {cu:bendCu,...bendFixture}=bend,{cu:rustCu,...rustFixture}=rust;
  assert.deepEqual(bendFixture,rustFixture,`Inputs, post-state and errors must match: ${bend.name}`);
  return {name:bend.name,error:bend.error,bendCu,rustCu,ratio:bendCu/rustCu,
    fixtureSha256:crypto.createHash('sha256').update(JSON.stringify(bendFixture)).digest('hex')};
});
const files=['build/queue.so','build/queue-rust.so','build/queue.manifest.json','build/queue-rust.manifest.json',
  'build/queue.interface.json','build/queue.schema.json','build/queue-benchmark-raw.json','build/queue-rust-benchmark-raw.json',
  'scripts/benchmark-queue.ts','tests/queue_sbf.rs','tests/token_fixture.rs','Cargo.toml','Cargo.lock','package.json','package-lock.json'];
const hashes=Object.fromEntries(files.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]));
fs.writeFileSync('build/queue-benchmark.json',JSON.stringify({sharedConformancePassed:true,repeatedIdentically:true,
  fixture:'Public fixed test seeds; same instructions, accounts, final state and errors',rows,
  hostRust:run('rustc',['--version'],true),bun:process.versions.bun,
  bendBuild:JSON.parse(fs.readFileSync('build/queue.manifest.json','utf8')),
  rustBuild:JSON.parse(fs.readFileSync('build/queue-rust.manifest.json','utf8')),hashes},null,2)+'\n');
console.log('Queue benchmark: 26 matched operations; conformance, repeatability, identical fixtures/outcomes and hashes verified');
