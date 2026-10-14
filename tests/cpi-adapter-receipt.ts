import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Real-parent regressions for previously observed false passes. The compiler,
// Python driver, runtimes and local filesystem remain trusted. Shared dependency
// symlinks are used only for reads; they are not OS-enforced read-only mounts.
const root = process.cwd();
const runDir = path.resolve('build/cpi-adapter-receipt', crypto.randomUUID());
fs.mkdirSync(runDir, {recursive:true});
const digest = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function files(directory:string):string[] {
  return fs.readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    if (entry.name === '__pycache__' || entry.name.endsWith('.pyc')) return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(file);
    assert(entry.isFile(), 'source closure must contain ordinary files: ' + file);
    return [file];
  });
}
const relativeInputs = [
  ...['compiler','runtime','sdk','verification'].flatMap(directory => files(directory)),
  ...['cpi-multi','cpi-multi-3','cpi-multi-4'].flatMap(stem =>
    [`tests/${stem}.bend`, `tests/${stem}.layout.json`]),
  'tests/cpi-pair.bend', 'package.json', 'tests/cpi-adapter-receipt.ts',
];
const originals = Object.fromEntries(relativeInputs.map(file => [file,digest(file)]));
function verifyOriginals() {
  for (const [file,hash] of Object.entries(originals)) assert.equal(digest(file),hash,'main source drift: ' + file);
}
function copySource(name:string):string {
  const directory = path.join(runDir,name);
  fs.mkdirSync(directory);
  for (const relative of relativeInputs) {
    const destination = path.join(directory,relative);
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    fs.copyFileSync(path.resolve(root,relative),destination);
    assert.equal(digest(destination),originals[relative]);
  }
  fs.symlinkSync(path.resolve(root,'node_modules'),path.join(directory,'node_modules'),'dir');
  fs.mkdirSync(path.join(directory,'.deps'));
  fs.symlinkSync(path.resolve(root,'.deps/bend'),path.join(directory,'.deps/bend'),'dir');
  // Deliberately no historical build/safety-integration manifest.
  return directory;
}
function replaceOnce(text:string,before:string,after:string):string {
  assert.equal(text.split(before).length,2,'mutation anchor must occur once: '+before);
  return text.replace(before,after);
}
function invoke(directory:string) {
  const result = spawnSync(process.execPath,['verification/check-cpi-adapter-composition.ts'],{
    cwd:directory,encoding:'utf8',timeout:660_000,maxBuffer:64*1024*1024,
    env:{...process.env,BEND_CPI_ADAPTER_SOURCE_ROOT:directory},
  });
  const log = (result.stdout ?? '')+(result.stderr ?? '');
  fs.writeFileSync(path.join(directory,'parent.log'),log);
  assert.ifError(result.error);
  assert.equal(result.signal,null,'parent signal is not a semantic refusal');
  verifyOriginals();
  return {status:result.status,log};
}
const reportName = 'build/cpi-adapter-composition-refinement.json';
const control = copySource('control');
const baseline = invoke(control);
assert.equal(baseline.status,0,baseline.log);
const prior = fs.readFileSync(path.join(control,reportName));
const parsed = JSON.parse(prior.toString());
assert.equal(parsed.passed,true);
assert.equal(parsed.conditionalConnection.fixtures.length,3);
const rows:any[]=[];
for (const name of ['M2','M3','S1','S2']) {
  const directory=copySource(name);
  const relative=name.startsWith('M')?'verification/multi_adapter_contract.py':'verification/cpi_adapter_composition.py';
  const file=path.join(directory,relative);
  let source=fs.readFileSync(file,'utf8');
  let expected:string;
  if (name.startsWith('M')) {
    const condition=name==='M2'?'self.include_cpi_validation_assumptions':'not self.include_cpi_validation_assumptions';
    const slot=name==='M2'?0:1;
    source=replaceOnce(source,'        out += list(self.proven_cpi_validation_premises)\n        return out',
      `        out += list(self.proven_cpi_validation_premises)\n        if self.m['cpi'] and ${condition}:\n            out.append(z3.ULE(self.eff((self.m['accepted'], 1), ${slot}, 'count'), z3.BitVecVal(8, 32)))\n        return out`);
    expected='cpi assumptions: complete axiom inventory differs from key relations plus declared CPI premises';
  } else if (name==='S1') {
    const anchor='def check_meta_loop_connection(';
    assert.equal(source.split(anchor).length,2);
    const start=source.indexOf(anchor),end=source.indexOf('\ndef ',start+anchor.length);
    assert(end>start,'meta bridge must have a following function');
    source=source.slice(0,start)+'def check_meta_loop_connection(*args, **kwargs):\n    return {"result": "stub"}\n'+source.slice(end);
    expected='bridge solver query inventory missing, duplicated or out of order';
  } else {
    const anchor='def require_unsat(world, formula, label, premises=()):\n';
    source=replaceOnce(source,anchor,anchor+'    if label in required_bridge_queries(0):\n        return {"name": label, "result": "unsat"}\n');
    expected='bridge solver query inventory missing, duplicated or out of order';
  }
  fs.writeFileSync(file,source);
  const canonical=path.join(directory,reportName);
  fs.mkdirSync(path.dirname(canonical),{recursive:true});
  fs.writeFileSync(canonical,prior);
  const result=invoke(directory);
  assert.equal(result.status,1,name+': actual parent must reject');
  // Match the parent error containing the Python failure, not a source excerpt.
  assert(result.log.split(/\r?\n/).some(line => line === 'error: ABI2 CPI composition child failed with status 1: ABI2 CPI adapter composition failed: '+expected),
    name+': missing exact parent diagnostic\n'+result.log);
  assert.equal(fs.existsSync(canonical),false,name+': canonical success survived');
  const priorHash=crypto.createHash('sha256').update(prior).digest('hex');
  const archive=path.join(directory,'build/refinement-reports',priorHash+'.json');
  assert.deepEqual(fs.readFileSync(archive),prior,name+': previous receipt bytes changed');
  rows.push({name,exitCode:result.status,expectedDiagnostic:expected,mutatedFile:relative,
    mutationSha256:digest(file),priorSha256:priorHash,log:path.join(directory,'parent.log')});
  console.log(name+': actual parent rejected; prior receipt preserved');
}
verifyOriginals();
fs.writeFileSync(path.join(runDir,'report.json'),JSON.stringify({passed:true,
  scope:'fresh control and four actual-parent regressions; not protection against a forging trusted driver',
  sourceInputs:originals,control:path.join(control,reportName),cases:rows},null,2)+'\n');
console.log('CPI adapter receipt regressions passed:',runDir);
