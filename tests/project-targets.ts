// Project targets: one bend.json builds and tests Fogo (SBPFv0) and Solana
// (SBPFv3) with no flags; the generated client is shared; refusals are clear.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createProject,loadProject,parseBendArgs,repository} from '../scripts/bend.ts';
import {checkSbpfV3FinalImage} from '../compiler/sbpf-v3-final-image.ts';

const parent=fs.mkdtempSync(path.join(repository,'build/project targets '));
const dir=path.join(parent,'Two Targets');
const cli=(args:string[],success:boolean,env:Record<string,string>={})=>{
  const r=spawnSync(process.execPath,[path.join(repository,'scripts/bend.ts'),...args],
    {cwd:repository,encoding:'utf8',env:{...process.env,...env}});
  assert.equal(r.status===0,success,`${args.join(' ')}\n${r.stdout}${r.stderr}`);return r;
};
const config=()=>JSON.parse(fs.readFileSync(path.join(dir,'bend.json'),'utf8'));
const setTargets=(targets:unknown)=>fs.writeFileSync(path.join(dir,'bend.json'),
  JSON.stringify({...config(),targets},null,2)+'\n');
try {
  createProject(dir);
  assert.deepEqual(config().targets,['fogo','solana'],'bend new defaults to both targets');
  const fogoOnlyProject=path.join(parent,'Fogo Only');
  cli(['new',fogoOnlyProject,'--target','fogo'],true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fogoOnlyProject,'bend.json'),'utf8')).targets,['fogo']);
  cli(['check',dir],true);cli(['verify',dir],true);
  const built=cli(['build',dir],true);
  assert.match(built.stdout,/\[fogo\] SBPFv0/);assert.match(built.stdout,/\[solana\] SBPFv3/);
  const fogo=fs.readFileSync(path.join(dir,'dist/fogo/program.so'));
  const solana=fs.readFileSync(path.join(dir,'dist/solana/program.so'));
  assert.equal(fogo.readUInt32LE(48),0,'fogo builds SBPFv0');
  assert.equal(solana.readUInt32LE(48),3,'solana builds SBPFv3');
  assert.equal(checkSbpfV3FinalImage(solana).status,'accepted');
  const solanaManifest=JSON.parse(fs.readFileSync(path.join(dir,'dist/solana/program.manifest.json'),'utf8'));
  assert.equal(solanaManifest.targetProfile,'solana-v3');
  assert.equal(solanaManifest.sbpfV3FinalImage.status,'accepted');
  const fogoManifest=JSON.parse(fs.readFileSync(path.join(dir,'dist/fogo/program.manifest.json'),'utf8'));
  assert.equal(fogoManifest.platformTools,'v1.53');assert.equal(fogoManifest.sbfCallDepth.status,'accepted');
  for(const suffix of ['.client.ts','.client.js']){
    const shared=fs.readFileSync(path.join(dir,`dist/program${suffix}`));
    assert(shared.equals(fs.readFileSync(path.join(dir,`dist/fogo/program${suffix}`))),`shared ${suffix} equals fogo`);
    assert(shared.equals(fs.readFileSync(path.join(dir,`dist/solana/program${suffix}`))),`shared ${suffix} equals solana`);
  }
  assert(!fs.existsSync(path.join(dir,'dist/program.so')),'Targeted projects do not write an untargeted ELF');

  const tested=cli(['test',dir],true);
  assert.match(tested.stdout,/\[fogo\] on LiteSVM 0\.7\.1: SBF tests passed/);
  assert.match(tested.stdout,/\[solana\] on LiteSVM 0\.13\.0 \(all-enabled features\): SBF tests passed/);
  const reports=Object.fromEntries(['fogo','solana'].map(target=>[target,
    JSON.parse(fs.readFileSync(path.join(dir,`dist/${target}/program.test-report.json`),'utf8'))]));
  assert.equal(reports.fogo.target,'fogo');assert.equal(reports.solana.target,'solana');
  assert.equal(reports.fogo.runtime,'LiteSVM 0.7.1');assert.match(reports.solana.runtime,/LiteSVM 0\.13\.0/);
  for(const report of Object.values(reports))assert(report.passed&&report.programCalls>0&&report.assertions>0);
  assert(Object.keys(reports.solana.hashes).some(file=>file.includes('test-runner-modern')));

  // One target on request; the other target's report is untouched.
  const solanaReport=fs.readFileSync(path.join(dir,'dist/solana/program.test-report.json'));
  const fogoOnly=cli(['test',dir,'--target','fogo'],true);
  assert.doesNotMatch(fogoOnly.stdout,/\[solana\]/);
  assert(solanaReport.equals(fs.readFileSync(path.join(dir,'dist/solana/program.test-report.json'))));

  // A failing test invalidates the selected targets' previous success reports.
  const test=fs.readFileSync(path.join(dir,'test.ts'),'utf8');
  fs.writeFileSync(path.join(dir,'test.ts'),'export default async function test(t) { t.equal(1,1); }\n');
  assert.match(cli(['test',dir],false).stderr,/Tests must invoke this SBF program/);
  assert(!fs.existsSync(path.join(dir,'dist/fogo/program.test-report.json')));
  assert(!fs.existsSync(path.join(dir,'dist/solana/program.test-report.json')));
  fs.writeFileSync(path.join(dir,'test.ts'),test);

  // Missing v1.57 toolchain: actionable refusal naming the fix; no Solana manifest.
  fs.rmSync(path.join(dir,'dist/solana'),{recursive:true,force:true});
  const missing=cli(['build',dir,'--target','solana'],false,{SBF_V157_TOOLS:path.join(parent,'no-such-tools')});
  assert.match(missing.stderr,/Target solana needs Anza platform-tools v1\.57/);
  assert.match(missing.stderr,/--target fogo/);
  assert(!fs.existsSync(path.join(dir,'dist/solana/program.manifest.json')));

  // Configuration and argument refusals.
  for(const [targets,label] of [[[],'empty'],[['fogo','fogo'],'duplicate'],[['ethereum'],'unknown'],['fogo','not a list']] as const){
    setTargets(targets);
    assert.throws(()=>loadProject(dir),/Invalid bend\.json targets/,label);
  }
  setTargets(['fogo']);
  assert.match(cli(['build',dir,'--target','solana'],false).stderr,/not listed in bend\.json targets/);
  const untargeted={...config()};delete untargeted.targets;
  fs.writeFileSync(path.join(dir,'bend.json'),JSON.stringify(untargeted,null,2)+'\n');
  assert.match(cli(['build',dir,'--target','fogo'],false).stderr,/--target requires "targets" in bend\.json/);
  assert.throws(()=>parseBendArgs(['check',dir,'--target','fogo']),/only with new, build and test/);
  assert.throws(()=>parseBendArgs(['build',dir,'--target','ethereum']),/Unknown target ethereum/);
  assert.throws(()=>parseBendArgs(['test',dir,'--target','fogo','--target','solana']),/Usage/);
  setTargets(['fogo','solana']);
  assert.match(cli(['test',dir,'--local-rpc','http://127.0.0.1:18899'],false).stderr,/runs one target/);
  console.log('Project targets: bend new defaults to both targets (new --target selects one); fogo SBPFv0 and solana SBPFv3 build and test with no flags; shared client, per-target reports, --target selection, missing-toolchain, configuration and argument refusals passed');
}finally{fs.rmSync(parent,{recursive:true,force:true});}
