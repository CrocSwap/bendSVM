import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {repository,createProject} from '../scripts/bend.ts';

fs.rmSync('build/workflow-e2e.json',{force:true});
const parent=fs.mkdtempSync(path.join(repository,'build/workflow-e2e-'));
const cli=(directory:string,command:string,success=true)=>{
  const result=spawnSync(process.execPath,[path.join(repository,'scripts/bend.ts'),command,directory],{cwd:repository,encoding:'utf8'});
  assert.equal(result.status===0,success,result.stdout+result.stderr);return result;
};
const starter=path.join(parent,'Fresh Project');createProject(starter);
cli(starter,'check');cli(starter,'verify');cli(starter,'test');
const sourceFile=path.join(starter,'program.bend'),source=fs.readFileSync(sourceFile,'utf8');
const needle='window, value), U32.add(length, 1)';assert(source.includes(needle));
fs.writeFileSync(sourceFile,source.replace(needle,'window, U32.add(value, 1)), U32.add(length, 1)'));
cli(starter,'verify'); // The declared laws do not specify the appended payload.
const wrong=cli(starter,'test',false);assert.match(wrong.stdout+wrong.stderr,/17|18/);
assert(!fs.existsSync(path.join(starter,'dist/program.test-report.json')),'A failed run must invalidate its previous success report');
fs.writeFileSync(sourceFile,source);cli(starter,'test');

// Existing, unrelated two-state fixture exercises the same generic runner and
// generated account ordering/decoders. It has no application authorization policy.
const multi=path.join(parent,'Existing Multi Account');fs.mkdirSync(multi);
const sdk=path.relative(multi,path.join(repository,'sdk')).split(path.sep).join('/');
fs.writeFileSync(path.join(multi,'program.bend'),fs.readFileSync('tests/multi-storage.bend','utf8').replaceAll('../sdk/',sdk+'/'));
fs.copyFileSync('tests/multi-storage.layout.json',path.join(multi,'storage.json'));
fs.writeFileSync(path.join(multi,'bend.json'),JSON.stringify({version:1,source:'program.bend',root:'process',layout:'storage.json',output:'dist/program'}));
fs.writeFileSync(path.join(multi,'test.ts'),`import {createClient} from './dist/program.client.ts';
export default async function test(t) {
  const client=createClient(t.program);
  const accounts={left:await t.key('left'),actor:await t.key('actor'),right:await t.key('right')};
  const sizes=client.allocationBytes();
  await t.createAccounts([{address:accounts.left,bytes:sizes.left},{address:accounts.right,bytes:sizes.right}],client.instructions.Set({left:3,right:4},accounts,{mode:'initialize'}));
  t.equal(client.state.left(await t.data(accounts.left)),{value:3});
  t.equal(client.state.right(await t.data(accounts.right)),{value:4});
  await t.send(client.instructions.Set({left:4294967295,right:17},accounts));
  t.equal(client.state.left(await t.data(accounts.left)),{value:4294967295});
  t.equal(client.state.right(await t.data(accounts.right)),{value:17});
  await t.reject(client.instructions.AbortRequest({},accounts),298);
}
`);
cli(multi,'check');cli(multi,'test');
const single=path.join(parent,'Existing Single Account');fs.mkdirSync(single);
const singleSdk=path.relative(single,path.join(repository,'sdk')).split(path.sep).join('/');
fs.writeFileSync(path.join(single,'program.bend'),fs.readFileSync('tests/storage.bend','utf8').replaceAll('../sdk/',singleSdk+'/'));
fs.writeFileSync(path.join(single,'bend.json'),JSON.stringify({version:1,source:'program.bend',root:'process',layout:null,output:'dist/program'}));
fs.writeFileSync(path.join(single,'test.ts'),`import {createClient} from './dist/program.client.ts';
export default async function test(t) {
  const client=createClient(t.program);
  const accounts={state:await t.key('state'),actor:await t.key('owner')};
  await t.createAccounts([{address:accounts.state,bytes:client.allocationBytes().state}],client.instructions.Initialize({value:17},accounts,{mode:'initialize'}));
  const initial=client.state(await t.data(accounts.state));
  t.equal(initial.kind,'Stored');t.equal(initial.owner,accounts.actor);t.equal(initial.value,17);t.equal(typeof initial.slot,'bigint');
  await t.send(client.instructions.Set({value:42},accounts));
  t.equal(client.state(await t.data(accounts.state)).value,42);
  await t.reject(client.instructions.Set({value:99},{...accounts,actor:await t.key('attacker')}),{application:1});
}
`);
cli(single,'verify');cli(single,'check');cli(single,'test');
const reports=[starter,multi,single].map(project=>({project:path.relative(repository,project),report:JSON.parse(fs.readFileSync(path.join(project,'dist/program.test-report.json'),'utf8'))}));
assert.equal(reports[0].report.rejected,3);assert.equal(reports[1].report.rejected,1);
fs.writeFileSync('build/workflow-e2e.json',JSON.stringify({passed:true,behaviorMutationRejected:true,reports},null,2)+'\n');
console.log('Fresh collection and existing ABI 1/2 projects executed generated-client SBF transactions; behavior mutation failed, rollback and decoded state assertions passed');
