import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Every mutation occurs in this fresh minimal source copy. Never copy target,
// build, tool caches or an entire worktree. Dependency symlinks are writable;
// the trusted drivers only read them, and the parent checks Bend revision/cleanliness.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nonce = crypto.randomUUID();
const run = path.join(repo, 'build/collection-caller-receipt', nonce);
const root = path.join(run, 'source');
const hash = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = [
  'package.json', 'package-lock.json',
  'tests/collection-store.bend', 'tests/collection-store.json',
  'tests/collection-caller-receipt.py', 'tests/collection-caller-receipt.ts',
  ...['collection_adapter_contract.py','collection_caller_syntax.py','collection_caller_paths.py',
    'collection_caller_cases.py','collection_contracts.py','check-collection-adapter-contract.ts'].map(f=>`verification/${f}`),
];
function collect(directory:string) {
  for(const entry of fs.readdirSync(path.join(repo,directory), {withFileTypes:true})) {
    if(['target','build','node_modules','.git','.deps','.fadeno','__pycache__'].includes(entry.name))continue;
    const relative=path.join(directory,entry.name);
    if(entry.isDirectory())collect(relative);
    else if(entry.isFile() && /\.(?:ts|bend|json|c|h|ld)$/.test(entry.name))files.push(relative);
  }
}
for(const directory of ['compiler','runtime','sdk','scripts'])collect(directory);
const unique=[...new Set(files)].sort();
const original=Object.fromEntries(unique.map(f=>[f,hash(path.join(repo,f))]));
for(const file of unique) {
  const to=path.join(root,file);
  fs.mkdirSync(path.dirname(to),{recursive:true});
  fs.copyFileSync(path.join(repo,file),to);
  assert.equal(hash(to),original[file]);
}
fs.mkdirSync(path.join(root,'.deps'),{recursive:true});
fs.symlinkSync(path.join(repo,'.deps/bend'),path.join(root,'.deps/bend'),'dir');
fs.symlinkSync(path.join(repo,'node_modules'),path.join(root,'node_modules'),'dir');
fs.mkdirSync(path.join(root,'build'),{recursive:true});
fs.writeFileSync(path.join(root,'build/.caller-receipt-private'),nonce,{flag:'wx'});
function execute(name:string,command:string,args:string[]) {
  const result=spawnSync(command,args,{cwd:root,env:process.env,encoding:'utf8',
    timeout:900_000,maxBuffer:16*1024*1024});
  fs.writeFileSync(path.join(run,name+'.log'),(result.stdout??'')+(result.stderr??'')+
    (result.error?`\n${result.error.stack}\n`:''));
  assert.ifError(result.error);
  assert.equal(result.status,0,`${name} failed; see ${path.join(run,name+'.log')}`);
}
execute('positive',process.execPath,['verification/check-collection-adapter-contract.ts']);
const baseline=path.join(root,'build/collection-adapter-contract-refinement.json');
const baselineHash=hash(baseline);
assert.equal(JSON.parse(fs.readFileSync(baseline,'utf8')).passed,true);
execute('failure-probes',process.env.PYTHON??'python3',['-I','-B','tests/collection-caller-receipt.py',root,nonce]);
const probeReportPath=path.join(root,'build/caller-receipt-probe-result.json');
assert(fs.existsSync(probeReportPath),'probe process returned without a report');
const probes=JSON.parse(fs.readFileSync(probeReportPath,'utf8'));
assert.equal(probes.passed,true);
assert.equal(probes.nonce,nonce);
assert.equal(probes.priorSha256,baselineHash);
assert.deepEqual(probes.cases.map((c:any)=>c.name),[
  'minimal-forgery','child-pass-then-failure','source-drift-after-child','archive-conflict',
]);
const diagnostics:Record<string,string>={
  'minimal-forgery':'caller receipt format mismatch',
  'child-pass-then-failure':'Collection caller contract exited 29',
  'source-drift-after-child':'child input hash binding',
  'archive-conflict':'prior caller receipt archive conflict',
};
const probeDirectories=fs.readdirSync(path.join(root,'build')).filter(n=>n.startsWith('caller-receipt-probes-'));
assert.equal(probeDirectories.length,1,'expected exactly one fresh probe log directory');
for(const c of probes.cases) {
  assert(Number.isInteger(c.exit)&&c.exit!==0,`${c.name} must actually fail`);
  assert.equal(c.expectedDiagnostic,diagnostics[c.name]);
  const log=fs.readFileSync(path.join(root,'build',probeDirectories[0],c.name+'.log'),'utf8');
  assert(log.split(/\r?\n/).includes('AssertionError: '+diagnostics[c.name]),
    `${c.name} failed for the wrong diagnostic`);
}
assert(!fs.existsSync(baseline),'last failure left canonical success');
assert.equal(hash(path.join(root,'build/refinement-reports',baselineHash+'.json')),baselineHash);
for(const file of unique) {
  assert.equal(hash(path.join(repo,file)),original[file],`main source changed: ${file}`);
  assert.equal(hash(path.join(root,file)),original[file],`private source not restored: ${file}`);
}
fs.writeFileSync(path.join(run,'report.json'),JSON.stringify({passed:true,
  scope:'Actual caller parent archive, forgery, child-exit and source-drift negatives in a fresh private source copy',
  baselineSha256:baselineHash,probeReportSha256:hash(probeReportPath),cases:probes.cases,sourceHashes:original,sourceRoot:root},null,2)+'\n');
console.log(`Collection caller receipt regression passed: ${run}`);
