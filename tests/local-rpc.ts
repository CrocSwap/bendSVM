import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {invalidateTestSuccess,LOCAL_RPC_ENDPOINT,parseBendArgs,projectCommand,repository} from '../scripts/bend.ts';

assert.deepEqual(parseBendArgs(['test','projects/my-program']),{
  command:'test',directory:'projects/my-program',options:{},
});
assert.deepEqual(parseBendArgs(['test','projects/my-program','--local-rpc',LOCAL_RPC_ENDPOINT]),{
  command:'test',directory:'projects/my-program',options:{localRpc:LOCAL_RPC_ENDPOINT},
});
assert.deepEqual(parseBendArgs(['test','projects/my-program',`--local-rpc=${LOCAL_RPC_ENDPOINT}`]),{
  command:'test',directory:'projects/my-program',options:{localRpc:LOCAL_RPC_ENDPOINT},
});
for(const endpoint of [
  'http://127.0.0.1:8899','http://localhost:18899','http://127.0.0.1:18899/',
  'https://127.0.0.1:18899','https://api.devnet.solana.com','http://192.168.1.2:18899',
]) assert.throws(()=>parseBendArgs(['test','projects/my-program','--local-rpc',endpoint]),/accepts only/);
assert.throws(()=>parseBendArgs(['check','projects/my-program','--local-rpc',LOCAL_RPC_ENDPOINT]),/only with the test command/);
assert.throws(()=>parseBendArgs(['test','projects/my-program','--local-rpc',LOCAL_RPC_ENDPOINT,'--local-rpc',LOCAL_RPC_ENDPOINT]),/Usage/);

fs.mkdirSync(path.join(repository,'build'),{recursive:true});
const root=fs.mkdtempSync(path.join(repository,'build/local-rpc-cli-test-'));
try {
  const project=path.join(root,'project');fs.mkdirSync(project);
  fs.writeFileSync(path.join(project,'bend.json'),JSON.stringify({version:1,source:'PROOF.bend',root:'sample.process',layout:null,output:'dist/program'}));
  const output=path.join(project,'dist');fs.mkdirSync(output);
  const report=path.join(output,'program.local-test-report.json');
  fs.writeFileSync(report,'{"passed":true}\n');
  fs.writeFileSync(path.join(output,'program.test-report.json'),'{"passed":true}\n');
  const loaded={dir:project,config:{version:1 as const,source:'PROOF.bend',root:'sample.process',layout:null,output:'dist/program'},source:path.join(project,'PROOF.bend'),layout:undefined,stem:path.join(output,'program')};
  assert.equal(invalidateTestSuccess(loaded,LOCAL_RPC_ENDPOINT),report);
  assert(!fs.existsSync(report),'The prior local-RPC success report must be removed before any prerequisite check');
  assert(fs.existsSync(path.join(output,'program.test-report.json')),'Offline and local-RPC test reports must remain separate');

  fs.writeFileSync(report,'{"passed":true}\n');
  await assert.rejects(projectCommand('test',project,{localRpc:LOCAL_RPC_ENDPOINT}));
  assert(!fs.existsSync(report),'A failed prerequisite must not leave stale local-RPC success evidence');
} finally {fs.rmSync(root,{recursive:true,force:true});}

console.log('Local-RPC CLI endpoint refusal and stale-success invalidation passed');
