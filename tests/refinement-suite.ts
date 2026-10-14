import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {runRefinementSuite, type RefinementCheck} from '../verification/suite.ts';

// Exercise the runner's failure and evidence lifetime contracts using tiny
// child programs. These are runner tests, not stand-ins for SMT checks.
export function testRefinementSuite() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bendsvm-refinement-suite-'));
  const index=path.join(dir,'suite.json');
  const report=path.join(dir,'check.json');
  const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const child=(name:string,body:string,artifact=report):RefinementCheck=>{
    const file=path.join(dir,name+'.ts');
    fs.writeFileSync(file,`import fs from 'node:fs';\nconst report=${JSON.stringify(artifact)};\n${body}\n`);
    return [name,file,artifact];
  };
  const good=child('success','fs.writeFileSync(report,JSON.stringify({passed:true,claim:"first"}));');
  try {
    const first=runRefinementSuite([good],index);
    const entry=first.checks[0];
    assert.equal(hash(entry.artifact),entry.sha256);
    fs.writeFileSync(report,JSON.stringify({passed:true,claim:'later focused run'}));
    assert.equal(hash(entry.artifact),entry.sha256,'Focused overwrite invalidated suite evidence');
    assert.equal(JSON.parse(fs.readFileSync(entry.artifact,'utf8')).claim,'first');
    const laterFailure=child('later-failure','process.exit(7);',path.join(dir,'second.json'));
    assert.throws(()=>runRefinementSuite([good,laterFailure],index),/later-failure refinement failed/);
    assert(!fs.existsSync(index),'Partial suite published success');
    assert.equal(hash(entry.artifact),entry.sha256);
    const failures: [RefinementCheck,RegExp][]=[
      [child('nonzero','process.exit(7);'),/nonzero refinement failed/],
      [child('no-output',''),/ENOENT/],
      [child('invalid-json','fs.writeFileSync(report,"{");'),/JSON/],
      [child('failed-report','fs.writeFileSync(report,JSON.stringify({passed:false}));'),/explicitly failed/],
      [child('signal','process.kill(process.pid,"SIGTERM");'),/signal refinement failed/],
      [child('timeout','setInterval(()=>{},1000);'),/ETIMEDOUT/],
      [child('publish-then-fail','fs.writeFileSync(report,JSON.stringify({passed:true,fresh:true})); process.exit(7);'),/publish-then-fail refinement failed/],
      [child('publish-then-timeout','fs.writeFileSync(report,JSON.stringify({passed:true,fresh:true})); setInterval(()=>{},1000);'),/ETIMEDOUT/],
      [child('publish-then-signal','fs.writeFileSync(report,JSON.stringify({passed:true,fresh:true})); process.kill(process.pid,"SIGTERM");'),/publish-then-signal refinement failed/],
    ];
    for(const [check,reason] of failures) {
      fs.writeFileSync(index,JSON.stringify({passed:true,old:true}));
      fs.writeFileSync(report,JSON.stringify({passed:true,stale:true}));
      assert.throws(()=>runRefinementSuite([check],index,{timeoutMs:1000}),reason,check[0]);
      assert(!fs.existsSync(index),`${check[0]} left a success index`);
      assert(!fs.existsSync(report),`${check[0]} left a conventional child report`);
      assert.equal(hash(entry.artifact),entry.sha256,'Failure damaged prior evidence');
    }
    const quarantined=fs.readdirSync(dir).filter(name=>name.endsWith('.quarantine'));
    assert(quarantined.some(name=>fs.readFileSync(path.join(dir,name),'utf8').includes('"fresh":true')),
      'Failed child output was discarded');
    const snapshotBytes=fs.readdirSync(path.join(dir,'refinement-reports'))
      .map(name=>fs.readFileSync(path.join(dir,'refinement-reports',name),'utf8'));
    assert(!snapshotBytes.some(bytes=>bytes.includes('"fresh":true')),
      'Failed child output entered the accepted-report archive');
    assert.throws(()=>runRefinementSuite([],index),/Empty/);
    const recovered=runRefinementSuite([good],index);
    assert.equal(recovered.checks[0].sha256,entry.sha256);
    fs.writeFileSync(entry.artifact,'corrupted snapshot');
    assert.throws(()=>runRefinementSuite([good],index),/Corrupt report snapshot/);
    assert(!fs.existsSync(index),'Corruption left a success index');
    assert(fs.readdirSync(path.join(dir,'refinement-reports')).some(name=>
      fs.readFileSync(path.join(dir,'refinement-reports',name),'utf8')===JSON.stringify(recovered,null,2)+'\n'),
      'Child archive failure discarded the prior suite index');
    assert(fs.readdirSync(dir).some(name=>name.startsWith('check.json.') && name.endsWith('.quarantine') &&
      fs.readFileSync(path.join(dir,name),'utf8')===JSON.stringify({passed:true,claim:'first'})),
      'Child archive failure discarded the prior check report');
    const archiveFailureDir=path.join(dir,'archive-failure');
    fs.mkdirSync(archiveFailureDir);
    const blockedIndex=path.join(archiveFailureDir,'suite.json');
    const oldBytes=JSON.stringify({passed:true,prior:'preserve exactly'});
    fs.writeFileSync(blockedIndex,oldBytes);
    fs.writeFileSync(path.join(archiveFailureDir,'refinement-reports'),'not a directory');
    assert.throws(()=>runRefinementSuite([good],blockedIndex),/EEXIST|ENOTDIR/);
    assert(!fs.existsSync(blockedIndex),'Archive setup failure left a success index');
    assert(fs.readdirSync(archiveFailureDir).some(name=>name.endsWith('.quarantine') &&
      fs.readFileSync(path.join(archiveFailureDir,name),'utf8')===oldBytes),
      'Archive setup failure lost the previous bytes');
    const freshDir=path.join(dir,'fresh-corrupt-snapshot');
    fs.mkdirSync(path.join(freshDir,'refinement-reports'),{recursive:true});
    const freshIndex=path.join(freshDir,'suite.json');
    const freshReport=path.join(freshDir,'check.json');
    const freshBytes=JSON.stringify({passed:true,freshSnapshot:true});
    const freshHash=crypto.createHash('sha256').update(freshBytes).digest('hex');
    fs.writeFileSync(path.join(freshDir,'refinement-reports',freshHash+'.json'),'corrupt');
    const freshChild=child('fresh-corrupt-snapshot',`fs.writeFileSync(report,${JSON.stringify(freshBytes)});`,freshReport);
    assert.throws(()=>runRefinementSuite([freshChild],freshIndex),/Corrupt report snapshot/);
    assert(!fs.existsSync(freshIndex) && !fs.existsSync(freshReport),
      'Fresh snapshot corruption left a conventional success report');
    assert(fs.readdirSync(freshDir).some(name=>name.endsWith('.quarantine') &&
      fs.readFileSync(path.join(freshDir,name),'utf8')===freshBytes),
      'Fresh snapshot corruption discarded child output');
    console.log('Refinement suite: snapshots survive overwrite; stale/missing/failed/signalled/timed-out reports fail closed');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
if(import.meta.main)testRefinementSuite();
