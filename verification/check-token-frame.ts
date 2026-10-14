import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const output='build/token-frame-refinement.json';
const inputs=['runtime/token.h','runtime/cpi_abi.h','runtime/solana_min.h',
 'verification/token_frame.py','verification/token_validate.py',
 'verification/adapter_contract_c.py','verification/check-token-frame.ts'];
const fields=['active','source','destination','mint','authority','recipient','initialize',
 'source_bound','destination_bound','fresh_destination'];
const keys=['mint_key','recipient_key','source_key','destination_key'];
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function uint(value:any,max:number) {assert(Number.isInteger(value)&&value>=0&&value<=max);}
function wide(value:any,bits:number) {
 assert.equal(typeof value,'string');assert.match(value,/^(0|[1-9][0-9]*)$/);
 assert(BigInt(value)<(1n<<BigInt(bits)));
}
export function validateTokenFrame(report:any) {
 assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);assert.equal(report.z3,'5.1.0');
 assert.deepEqual(Object.keys(report.inputs).sort(),[...inputs].sort());
 for(const file of inputs)assert.equal(report.inputs[file],hash(file),file);
 assert.deepEqual(report.frameSpec,{accounts:[4,12],mint:{size:82,spans:[[36,44]]},token:{size:165,spans:[[64,108],[121,129]]},endExclusive:true});
 assert.deepEqual(report.validatorClaims,['account and data read bounds','exact error/success contract','complete return coverage'].map(name=>({name,result:'unsat'})));
 assert.deepEqual(report.stablePaths,Array.from({length:31},(_,returnPath)=>({returnPath,guard:'unsat',value:'unsat'})));
 assert.deepEqual(report.frameClaims,[['managed-state-data-preserved','unsat'],['executor-decimals-read-preserved','unsat'],['state-write-detected','sat'],['decimals-write-detected','sat']].map(([name,result])=>({name,result})));
 assert.equal(report.mutablePredicates.length,2);
 for(const [i,expected] of [['mint-initialize',3,'initialize',6,36,24],['fresh-transfer',1,'fresh_destination',5,64,26]].entries()) {
  const row=report.mutablePredicates[i],w=row.witness;
  assert.deepEqual([row.name,row.result,row.before,row.after,row.account,row.offset,row.byte],[expected[0],'sat',0,expected[5],expected[3],expected[4],1]);
  assert.equal(w.account_count,7);assert.equal(w.accounts.length,7);
  assert.deepEqual(Object.keys(w.native).sort(),[...fields].sort());
  for(const field of fields)uint(w.native[field],0xffffffff);
  assert.equal(w.native.active,expected[1]);assert.equal(w.native[expected[2] as string],1);
  assert.equal(w.native.source,4);assert.equal(w.native.destination,5);assert.equal(w.native.mint,6);
  wide(w.amount,64);assert.deepEqual(Object.keys(w.keys).sort(),[...keys].sort());
  for(const key of keys)wide(w.keys[key],256);
  assert.equal(new Set(w.accounts.map((a:any)=>a.key)).size,7);
  for(const account of w.accounts) {
   wide(account.key,256);wide(account.owner,256);uint(account.size,165);
   for(const field of ['signer','writable','executable'])uint(account[field],0xffffffff);
   assert.equal(account.data.length,165);for(const byte of account.data)uint(byte,255);
  }
 }
}
export function checkTokenFrame() {
 fs.rmSync(output,{force:true});fs.rmSync(output+'.pending',{force:true});
 try {
  const child=spawnSync(process.env.PYTHON??'python3',['-B','verification/token_frame.py'],{encoding:'utf8',timeout:180000,maxBuffer:1<<22});
  assert.ifError(child.error);assert.equal(child.signal,null);assert.equal(child.status,0,child.stderr||child.stdout);
  validateTokenFrame(JSON.parse(fs.readFileSync(output,'utf8')));
  console.log('Token frame: exact claims, mutable-predicate witnesses and source bindings passed');
 } catch(error) {fs.rmSync(output,{force:true});fs.rmSync(output+'.pending',{force:true});throw error;}
}
if(import.meta.main)checkTokenFrame();
