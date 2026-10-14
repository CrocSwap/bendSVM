import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createProject,repository} from '../scripts/bend.ts';

const parent=fs.mkdtempSync(path.join(repository,'build/workflow commands '));
const dir=path.join(parent,'My Project');
// The starter lists fogo and solana; build/test fogo only so this check runs on
// CI hosts without platform-tools v1.57 (tests/project-targets.ts covers solana).
const cli=(command:string,success:boolean)=>{
  const args=command==='build'||command==='test'?[command,dir,'--target','fogo']:[command,dir];
  const r=spawnSync(process.execPath,[path.join(repository,'scripts/bend.ts'),...args],{cwd:repository,encoding:'utf8'});
  assert.equal(r.status===0,success,r.stdout+r.stderr);return r;
};
try {
  createProject(dir);
  const source=fs.readFileSync(path.join(dir,'program.bend'),'utf8');
  assert.throws(()=>createProject(dir),/Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(dir,'program.bend'),'utf8'),source);
  cli('check',true);cli('verify',true);cli('build',true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'bend.json'),'utf8')).targets,['fogo','solana']);
  assert(fs.statSync(path.join(dir,'dist/fogo/program.so')).size>0);
  assert(fs.statSync(path.join(dir,'dist/program.client.js')).size>0);
  // An implementation violating the declared laws must fail both verification
  // and build; a generated project must not silently bypass its proof module.
  fs.writeFileSync(path.join(dir,'program.bend'),source.replaceAll('Rejected{1}','Rejected{4}'));
  cli('verify',false);cli('build',false);
  fs.writeFileSync(path.join(dir,'program.bend'),source);
  const proof=fs.readFileSync(path.join(dir,'PROOF.bend'),'utf8');
  fs.writeFileSync(path.join(dir,'PROOF.bend'),proof.replace('{==}','?TODO'));
  cli('verify',false);
  fs.writeFileSync(path.join(dir,'PROOF.bend'),proof);
  const test=fs.readFileSync(path.join(dir,'test.ts'),'utf8');
  fs.writeFileSync(path.join(dir,'test.ts'),'export default async function test(t) { t.equal(1,1); }\n');
  assert.match(cli('test',false).stderr,/Tests must invoke this SBF program/);
  assert(!fs.existsSync(path.join(dir,'dist/fogo/program.test-report.json')));
  fs.writeFileSync(path.join(dir,'test.ts'),test);
  console.log('Fresh project create/check/verify/build passed with spaced paths; overwrite, law violations, proof holes and empty execution tests rejected');
}finally{fs.rmSync(parent,{recursive:true,force:true});}
