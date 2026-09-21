// Evidence consistency gate; docs/account-collections-acceptance.md supplies the
// separate requirement-by-requirement review and explicit proof boundaries.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const marker='build/account-collections-acceptance.json';fs.rmSync(marker,{force:true});
const read=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hashes=(values:Record<string,string>)=>{assert(Object.keys(values).length);for(const [file,h] of Object.entries(values))assert.equal(hash(file),h,`Stale evidence: ${file}`);};
const evidence=new Set<string>();
const track=(file:string)=>{evidence.add(file);return read(file);};
const suite=track('build/refinement-suite.json');assert.equal(suite.passed,true);
assert.deepEqual(suite.checks.map((c:any)=>c.name),['queue','collection','batch','fold','iteration','buffer','arithmetic','division','multiplication','wide','sqrt','amm-pricing','amm','vault','vesting-payout','vesting-process','exchange']);
for(const c of suite.checks){assert.equal(hash(c.artifact),c.sha256);const r=track(c.artifact);if(r.hashes)hashes(r.hashes);}
const sat=(v:any):boolean=>!!v&&typeof v==='object'&&(v.result==='sat'||Object.values(v).some(sat));
const collection=track('build/collection-refinement.json');
assert.equal(collection.positive.claims.length,9);assert(collection.positive.claims.every((c:any)=>c.result==='unsat'));
assert.equal(collection.mutations.length,5);assert(collection.mutations.every(sat));hashes(collection.hashes);
const queue=track('build/queue-refinement.json');hashes(queue.hashes);
assert.equal(queue.positive.claims.length,428);assert(queue.positive.claims.every((c:any)=>c.result==='unsat'));
assert.equal(queue.mutations.length,7);assert(queue.mutations.every((m:any)=>sat(m)&&m.replay&&!JSON.stringify(m.replay.original).includes('undefined')&&JSON.stringify(m.replay.original)!==JSON.stringify(m.replay.mutated)));
assert.deepEqual(queue.schemaNegatives,['State','Instruction','Outcome']);
const expectedBindings=[...new Set(queue.positive.arithmeticBindings.flatMap((b:any)=>b.functions)),...new Set(queue.positive.arithmeticBindings.flatMap((b:any)=>b.types))];
assert.deepEqual(queue.bindingNegatives,expectedBindings);assert.equal(queue.bindingNegatives.length,18);
assert(queue.positive.arithmeticBindings.every((b:any)=>b.result==='checked'));
assert.equal(hash('build/queue-refinement.model.json'),queue.positive.modelSha256);
for(const file of ['build/queue-refinement.model.json','build/queue-arithmetic.model.json','build/queue-arithmetic-refinement.json'])evidence.add(file);
for(const [name,n] of [['collection',860],['generics',37],['buffer',181],['iteration',325],['fold',1092],['batch-pure',120]] as const){
 const metrics=track(`build/${name}-metrics.json`);assert.equal(metrics.cases,n);assert.equal(track(`build/${name}-vectors.json`).length,n);
 assert.equal(metrics.elf_bytes,fs.statSync(`build/${name}.so`).size);assert(metrics.max_cu>0);evidence.add(`build/${name}.so`);
}
function manifest(name:string){
 const m=track(`build/${name}.manifest.json`);hashes(m.inputs);
 for(const [suffix,h] of Object.entries(m.artifacts)){const f=`build/${name}${suffix}`;assert.equal(hash(f),h);evidence.add(f);}
 assert(m.artifacts['.resources.json']&&m.artifacts['.stack.json']);
 const resources=track(`build/${name}.resources.json`),stack=track(`build/${name}.stack.json`);
 assert(resources.largestNativeBytes<=1536&&resources.largestWireBytes<=1024);assert(stack.maxFrameBytes<=4096&&stack.functions.length);
 return m;
}
for(const name of ['vault','vesting','exchange','amm','batch','collection-store','collection-record','collection-cpi','queue'])manifest(name);
for(const [file,names] of [['build/reproducibility.json',['vault','vesting','exchange']],['build/collection-reproducibility.json',['collection-store','collection-record','collection-cpi','queue']]] as const){
 const rows=track(file);assert.deepEqual(rows.map((r:any)=>r.name),names);
 for(const r of rows)assert.deepEqual(r.artifacts,read(`build/${r.name}.manifest.json`).artifacts);
}
const benchmark=track('build/queue-benchmark.json');hashes(benchmark.hashes);
assert(benchmark.sharedConformancePassed&&benchmark.repeatedIdentically);assert.equal(benchmark.rows.length,26);
assert.deepEqual(benchmark.bendBuild,read('build/queue.manifest.json'));
const rust=track('build/queue-rust.manifest.json');assert.deepEqual(benchmark.rustBuild,rust);hashes(rust.sources);assert.equal(hash(rust.elf),rust.elfSha256);assert(rust.reproducible);evidence.add(rust.elf);
const bendRows=track('build/queue-benchmark-raw.json'),rustRows=track('build/queue-rust-benchmark-raw.json');
for(let i=0;i<26;i++){
 const {cu:bendCu,...bend}=bendRows[i],{cu:rustCu,...rust}=rustRows[i];assert.deepEqual(bend,rust);assert(bendCu>0&&rustCu>0);
 const row=benchmark.rows[i];assert.equal(row.name,bend.name);assert.equal(row.bendCu,bendCu);assert.equal(row.rustCu,rustCu);assert.equal(row.fixtureSha256,crypto.createHash('sha256').update(JSON.stringify(bend)).digest('hex'));
}
const tests=fs.readFileSync('build/account-collections-regression.log','utf8');assert.match(tests,/test result: ok\. 78 passed; 0 failed; 3 ignored;/);
for(const message of ['Target diagnostic categories','Queue checked laws','All three public program builds reproduce','collection_initialization_requires_both_signers','collection_cpi_permissions_managed_aliases','queue_guards_and_late_token_failure'])assert(tests.includes(message),`Missing test evidence: ${message}`);
assert.match(fs.readFileSync('build/account-collections-refinement-suite.log','utf8'),/All 17 source refinement commands passed/);
for(const f of ['build/account-collections-regression.log','build/account-collections-refinement-suite.log'])evidence.add(f);
const sources:string[]=[];
function walk(dir:string){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 if(entry.name.startsWith('.'))continue;const f=`${dir}/${entry.name}`;
 if(entry.isDirectory())walk(f);else if(/\.(?:ts|py|rs|bend|c|h|ld|json|md)$/.test(f))sources.push(f);
}}
for(const dir of ['compiler','runtime','sdk','examples','tests','benchmarks','scripts','verification','docs'])walk(dir);
sources.push('README.md','package.json','package-lock.json','Cargo.toml','Cargo.lock');
fs.writeFileSync(marker,JSON.stringify({evidenceConsistent:true,tests:78,ignoredBenchmarks:3,refinements:17,
 artifacts:Object.fromEntries([...evidence].sort().map(f=>[f,hash(f)])),sources:Object.fromEntries(sources.sort().map(f=>[f,hash(f)])),
 scope:'Account-backed collections, diagnostics/resources, source invariants and matched queue Rust benchmark; no end-to-end compiler proof or live-cluster deployment.'},null,2)+'\n');
console.log('Account collections evidence audit passed: current sources/artifacts, complete suites, reproducibility and matched benchmark');
