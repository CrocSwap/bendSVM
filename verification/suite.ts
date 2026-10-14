import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

export type RefinementCheck = readonly [name:string, script:string, artifact:string];

// Report snapshots preserve the evidence selected by this run. They do not
// certify later source revisions or recursively snapshot each report's inputs.
export function runRefinementSuite(checks:readonly RefinementCheck[], reportPath:string,
    options:{timeoutMs?:number} = {}) {
  assert(checks.length > 0, 'Empty refinement suite');
  assert.equal(new Set(checks.map(c=>c[0])).size, checks.length, 'Duplicate check name');
  assert.equal(new Set(checks.map(c=>path.resolve(c[2]))).size, checks.length, 'Duplicate report path');
  assert(checks.every(c=>path.resolve(c[2])!==path.resolve(reportPath)), 'Check overwrites suite report');
  const directory = path.dirname(reportPath);
  const snapshots = path.join(directory, 'refinement-reports');
  function snapshot(bytes:Buffer) {
    fs.mkdirSync(snapshots, {recursive:true});
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const artifact = path.join(snapshots, sha256+'.json');
    try { fs.writeFileSync(artifact, bytes, {flag:'wx'}); }
    catch(e) {
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      assert.deepEqual(fs.readFileSync(artifact), bytes, `Corrupt report snapshot: ${artifact}`);
    }
    return {artifact,sha256};
  }
  // Move first: an archive failure must preserve the original bytes without
  // leaving success at a conventional path. Newly failed child output stays in
  // a separate quarantine. Archived prior bytes are evidence only when selected
  // by a successful suite index, not merely because they are in the archive.
  function retire(file:string, archive:boolean) {
    if(!fs.existsSync(file))return;
    const quarantine = file+`.${crypto.randomUUID()}.quarantine`;
    fs.renameSync(file,quarantine);
    if(archive) {
      snapshot(fs.readFileSync(quarantine));
      fs.rmSync(quarantine);
    }
  }
  retire(reportPath,true);
  const pending = reportPath+`.${process.pid}.pending`;
  fs.rmSync(pending, {force:true});
  const results = [];
  try {
    for(const [name,script,sourceArtifact] of checks) {
      retire(sourceArtifact,true);
      console.log(`Checking ${name}`);
      try {
        const result=spawnSync(process.execPath,[script],{stdio:'inherit',timeout:options.timeoutMs});
        assert.ifError(result.error);
        assert.equal(result.status,0,`${name} refinement failed`);
        const bytes = fs.readFileSync(sourceArtifact);
        const report = JSON.parse(bytes.toString('utf8'));
        assert(report && typeof report==='object' && !Array.isArray(report) && Object.keys(report).length,
          `${name}: invalid report`);
        assert.notEqual(report.passed,false,`${name}: report explicitly failed`);
        results.push({name,sourceArtifact,...snapshot(bytes)});
      } catch(error) {
        retire(sourceArtifact,false);
        throw error;
      }
    }
    const report = {passed:true, checks:results};
    fs.writeFileSync(pending,JSON.stringify(report,null,2)+'\n');
    fs.renameSync(pending,reportPath);
    return report;
  } finally { fs.rmSync(pending,{force:true}); }
}
