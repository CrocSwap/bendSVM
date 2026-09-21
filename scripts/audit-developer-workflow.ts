import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const marker='build/developer-workflow-acceptance.json';fs.rmSync(marker,{force:true});
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidence=new Set<string>();
const read=(file:string)=>{evidence.add(file);return JSON.parse(fs.readFileSync(file,'utf8'));};
const hashes=(values:Record<string,string>)=>{assert(Object.keys(values).length);for(const [file,h] of Object.entries(values)){assert.equal(hash(file),h,`Stale evidence: ${file}`);evidence.add(file);}};
function manifest(stem:string) {
  const m=read(stem+'.manifest.json');hashes(m.inputs);
  for(const [suffix,h] of Object.entries(m.artifacts)){assert.equal(hash(stem+suffix),h,stem+suffix);evidence.add(stem+suffix);}
  for(const suffix of ['.client.ts','.client.js','.client-runtime.js','.client-runtime.d.ts'])assert(m.artifacts[suffix],`Missing generated client ${stem}${suffix}`);
  return m;
}
const e2e=read('build/workflow-e2e.json');assert(e2e.passed&&e2e.behaviorMutationRejected);assert.equal(e2e.reports.length,3);
const versions=[];
for(const {project,report} of e2e.reports){
  assert.deepEqual(read(project+'/dist/program.test-report.json'),report);hashes(report.hashes);
  assert(report.passed&&report.programCalls>0&&report.assertions>0&&report.successful>=2&&report.rejected>=1);
  assert.equal(report.transactions,report.receipts.length);assert(report.receipts.every((r:any)=>r.units>0&&r.logs.length>0));
  manifest(project+'/dist/program');versions.push(read(project+'/dist/program.interface.json').version);
}
assert.deepEqual(versions,[3,2,1]);
const packaging=read('build/client-packaging-report.json');assert(packaging.passed);assert.match(packaging.typescript,/Version \d+\.\d+\.\d+/);hashes(packaging.hashes);
for(const [name,h] of Object.entries(packaging.artifacts)){assert.equal(hash('build/'+name),h,name);evidence.add('build/'+name);}
for(const [file,names] of [['build/collection-reproducibility.json',['collection-store','collection-record','collection-cpi','queue']],['build/reproducibility.json',['vault','vesting','exchange']]] as const){
  const rows=read(file);assert.deepEqual(rows.map((r:any)=>r.name),names);
  for(const row of rows)assert.deepEqual(row.artifacts,manifest('build/'+row.name).artifacts);
}
const logs:Record<string,RegExp>={
  'build/workflow-client.log':/ABI 1\/2\/3 descriptors.*passed/,
  'build/workflow-packaging.log':/strict TypeScript positive and negative client checks passed/,
  'build/workflow-commands.log':/proof holes and empty execution tests rejected/,
  'build/workflow-e2e.log':/existing ABI 1\/2 projects executed generated-client SBF transactions/,
  'build/workflow-sbf-regression.log':/test result: ok\. 78 passed; 0 failed; 3 ignored;/,
  'build/workflow-regression-builds.log':/All three public program builds reproduce test binaries/,
  'build/workflow-reproducibility.log':/Collection and queue public builds reproduce all artifacts/,
};
for(const [file,pattern] of Object.entries(logs)){assert.match(fs.readFileSync(file,'utf8'),pattern);evidence.add(file);}
const sources:string[]=[];
function walk(dir:string){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  if(entry.name.startsWith('.')||['target','node_modules'].includes(entry.name))continue;
  const file=dir+'/'+entry.name;if(entry.isDirectory())walk(file);else if(/\.(?:ts|bend|rs|toml|lock|json|md|c|h|ld)$/.test(file))sources.push(file);
}}
for(const dir of ['compiler','sdk','runtime','scripts','templates','tests','docs'])walk(dir);
sources.push('README.md','package.json','package-lock.json','Cargo.toml','Cargo.lock');
fs.writeFileSync(marker,JSON.stringify({passed:true,requirements:6,executedAbis:versions,regressionTests:78,
  sources:Object.fromEntries(sources.sort().map(file=>[file,hash(file)])),
  evidence:Object.fromEntries([...evidence].sort().map(file=>[file,hash(file)])),
  scope:'Project create/check/verify/build/test, portable generated clients and offline signed SBF execution; no automatic SMT or live deployment.'},null,2)+'\n');
console.log('Developer workflow acceptance passed: six requirements, generated clients, strict types, fresh projects, ABI 1/2/3 SBF execution, reproducibility and 78 regression tests');
