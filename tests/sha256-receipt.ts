import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

// Full-driver failure probes using private source copies. Cargo is replaced by
// a recorded shim that selects the real previously tested Rust executable;
// these are receipt-lifetime tests, not additional cryptographic acceptance.
const sha = (file:string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const parent=path.resolve('build/sha256-receipt');fs.mkdirSync(parent,{recursive:true});
const reportPath=path.join(parent,'report.json');
if(fs.existsSync(reportPath)) fs.renameSync(reportPath,path.join(parent,`report-${sha(reportPath)}.json`));
const sourceHash=sha('tests/sha256-receipt.ts');
const root = path.resolve('build/sha256');
const reports = fs.readdirSync(root).filter(name => name.startsWith('run-'))
  .map(name => path.join(root,name,'report.json')).filter(file => fs.existsSync(file));
const baselinePath = reports.sort().at(-1);
assert(baselinePath, 'run test:sha256 successfully before receipt probes');
const baselineHash = sha(baselinePath);
const baseline = JSON.parse(fs.readFileSync(baselinePath,'utf8'));
assert.equal(baseline.passed,true,'requires the current completed acceptance format');
assert.equal(baseline.executedRustTestBinaries.length,1);
const testBinary = baseline.executedRustTestBinaries[0];
assert.equal(sha(testBinary.path),testBinary.sha256,'baseline test executable no longer matches');
const commandPath = (name:string) => {
  const r=spawnSync('which',[name],{encoding:'utf8'});assert.equal(r.status,0);return r.stdout.trim();
};
const realCargo=commandPath('cargo'), realCC=commandPath(process.env.CC??'clang');
const results=[];
for(const mode of ['child-failure','input-drift','artifact-drift'] as const) {
  const dir=fs.mkdtempSync(path.join(parent,mode+'-'));
  for(const file of Object.keys(baseline.inputs)) {
    const dest=path.join(dir,file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);
  }
  const bin=path.join(dir,'bin');fs.mkdirSync(bin);
  const compiler=path.join(bin,'probe-cc');
  fs.writeFileSync(compiler,`#!${process.execPath}
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('-c') || args.includes('tests/sha256/native.c')) {
 ${mode==='child-failure'?'process.exit(29);':mode==='input-drift'?"fs.appendFileSync('sdk/sha256.ts','\\n// injected acceptance input drift\\n');":''}
}
const r=spawnSync(${JSON.stringify(realCC)},args,{stdio:'inherit'});process.exit(r.status??30);
`,{mode:0o755});
  const executed = mode==='artifact-drift'?path.join(bin,'probe-test'):testBinary.path;
  if(mode==='artifact-drift') fs.writeFileSync(executed,`#!${process.execPath}
import fs from 'node:fs';import {spawnSync} from 'node:child_process';
const r=spawnSync(${JSON.stringify(testBinary.path)},process.argv.slice(2),{stdio:'inherit'});
if(r.status!==0) process.exit(r.status??30);
const file=process.env.SHA256_TEST_ELF; const bytes=fs.readFileSync(file);
bytes[bytes.length-1]^=1; fs.writeFileSync(file,bytes);
`,{mode:0o755});
  fs.writeFileSync(path.join(bin,'cargo'),`#!${process.execPath}
import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('--no-run')) {
 console.log(JSON.stringify({reason:'compiler-artifact',profile:{test:true},target:{name:'sha256_sbf'},executable:${JSON.stringify(executed)}}));
} else {const r=spawnSync(${JSON.stringify(realCargo)},args,{stdio:'inherit'});process.exit(r.status??30);}
`,{mode:0o755});
  const result=spawnSync(process.execPath,['tests/sha256.ts'],{cwd:dir,encoding:'utf8',timeout:120_000,
    env:{...process.env,CC:compiler,PATH:`${bin}${path.delimiter}${process.env.PATH}`},maxBuffer:4<<20});
  fs.writeFileSync(path.join(dir,'driver.log'),result.stdout+result.stderr);
  assert.ifError(result.error);
  assert.notEqual(result.status,0,`${mode}: full driver falsely passed`);
  assert.match(result.stderr,mode==='child-failure'?/failed \(29\)/:mode==='input-drift'?/SHA inputs changed during acceptance/:/compiled SHA artifacts changed during acceptance/);
  const runs=path.join(dir,'build/sha256');
  assert(fs.existsSync(runs),`${mode}: driver must begin a fresh run`);
  assert(fs.readdirSync(runs).every(run=>!fs.existsSync(path.join(runs,run,'report.json'))),
    `${mode}: failed driver published success`);
  assert.equal(sha(baselinePath),baselineHash,'failure damaged prior acceptance evidence');
  results.push({mode,exitStatus:result.status,log:path.join(dir,'driver.log'),logSha256:sha(path.join(dir,'driver.log'))});
}
assert.equal(sha('tests/sha256-receipt.ts'),sourceHash,'receipt probe source changed');
fs.writeFileSync(reportPath+'.pending',JSON.stringify({passed:true,sourceHash,
  scope:'full SHA acceptance-driver refusal and prior-evidence preservation; recorded Cargo shim reuses tested Rust binary',
  baseline:{path:baselinePath,sha256:baselineHash},results},null,2)+'\n');
fs.renameSync(reportPath+'.pending',reportPath);
console.log('SHA receipt probes: nonzero child, changed source and changed ELF reject without publishing success');
