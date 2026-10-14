import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {startTestProgram} from '../sdk/testing.ts';
import {run, sbfTools} from '../scripts/build.ts';
import {checkSbfCallDepth} from '../compiler/sbf-call-depth.ts';
import {checkFinalSbfArtifact, verifyFinalSbfArtifactReceipt} from '../compiler/sbf-call-depth-artifact.ts';

function instruction(opcode:number, destination=0, source=0, offset=0, immediate=0):string {
  const bytes=Buffer.alloc(8);
  bytes[0]=opcode;bytes[1]=(source<<4)|destination;
  bytes.writeInt16LE(offset,2);bytes.writeInt32LE(immediate,4);
  return '.byte '+[...bytes].join(',')+'\n';
}
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export async function testSbfCallDepthRuntime() {
  const directory=path.resolve('build/sbf-call-depth-runtime','run-'+crypto.randomUUID());
  fs.mkdirSync(directory,{recursive:true});
  const tools=sbfTools();const version=run(path.join(tools,'clang'),['--version'],true);
  assert(version.includes('20.1.7')&&version.includes('anza-xyz'),'Pinned Anza Clang is required');
  const rows:unknown[]=[];
  const artifacts:Record<string,string>={};
  for(const name of ['abort-write','abort-callx','return-write','return-callx','conditional-write','conditional-callx']) {
    const conditional=name.startsWith('conditional-'),aborts=name.startsWith('abort-'),callx=name.endsWith('callx');
    let assembly='.text\n.globl entrypoint\n.type entrypoint,@function\n.p2align 3\nentrypoint:\n';
    assembly+=instruction(0xbf,6,1)+instruction(0x72,6,0,96,17);
    if(conditional)assembly+='call conditional_helper\n';else if(aborts)assembly+='call abort\n';
    assembly+=instruction(0x72,6,0,97,34);
    if(callx)assembly+=instruction(0xb7,1)+instruction(0x8d,0,0,0,1);
    assembly+=instruction(0xb7,0)+instruction(0x95)+'.size entrypoint,.-entrypoint\n';
    if(conditional) {
      // Account lamports are at serialized offset 80. An actual one-lamport
      // System transfer selects the return branch; no account data injection.
      assembly+='.globl conditional_helper\n.type conditional_helper,@function\n.p2align 3\nconditional_helper:\n';
      assembly+=instruction(0x79,7,6,80)+instruction(0x57,7,0,0,1)+instruction(0x55,7,0,1,0);
      assembly+='call abort\n'+instruction(0x95)+'.size conditional_helper,.-conditional_helper\n';
    }
    const stem=path.join(directory,name);fs.writeFileSync(stem+'.s',assembly);
    run(path.join(tools,'clang'),['--target=sbf','-mcpu=generic','-c',stem+'.s','-o',stem+'.o']);
    run(path.join(tools,'ld.lld'),['-z','notext','-shared','--Bdynamic','runtime/sbf.ld','--entry','entrypoint','-z','max-page-size=4096','--gc-sections',stem+'.o','-o',stem+'.so']);
    const checked=checkSbfCallDepth(fs.readFileSync(stem+'.so'));
    const refused=callx&&!aborts;
    assert.equal(checked.status,refused?'refused':'accepted');
    if(refused)assert(checked.diagnostics.some(d=>d.code==='reachable_callx'));
    else {
      assert.equal(checked.analysis.longestFrameCount,conditional?2:1);
      const receipt=checkFinalSbfArtifact(stem+'.so',path.join(directory,'final-image'));
      verifyFinalSbfArtifactReceipt(receipt,stem+'.so');
      for(const variant of ['missing','changed','extra']) {
        const forged=JSON.parse(JSON.stringify(receipt));
        if(variant==='missing')delete forged.assumptions.terminalSyscalls;
        else if(variant==='changed')forged.assumptions.terminalSyscalls='all syscalls halt';
        else forged.assumptions.unrecognized='no calls';
        assert.throws(()=>verifyFinalSbfArtifactReceipt(forged,stem+'.so'),(e:any)=>e.code==='SBF_CALL_DEPTH_UNSUPPORTED_PROFILE');
      }
    }
    fs.writeFileSync(stem+'-checker.json',JSON.stringify(checked,null,2)+'\n');
    for(const returns of conditional?[false,true]:[false]) {
      const test=await startTestProgram(stem+'.so');
      try {
        const address=await test.key('watched');await test.createAccounts([{address,bytes:2}]);
        const allocated=await test.account(address);assert(allocated);assert.equal(allocated.lamports%2,0);
        if(returns) {
          const data=Buffer.alloc(12);data.writeUInt32LE(2);data.writeBigUInt64LE(1n,4);
          await test.send({program:'11111111111111111111111111111111',accounts:[{address:test.payer,signer:true,writable:true},{address,signer:false,writable:true}],data});
        }
        const before=await test.account(address);assert(before);assert.equal(before.lamports,allocated.lamports+Number(returns));
        const ix={program:test.program,accounts:[{address,signer:false,writable:true}],data:new Uint8Array()};
        const halts=aborts||(conditional&&!returns),succeeds=!halts&&!callx;
        if(succeeds)await test.send(ix);else await assert.rejects(test.send(ix),/ProgramFailedToComplete/);
        const result=test.receipts.at(-1)!;assert.equal(result.ok,succeeds);
        assert.equal(result.logs.some(l=>l.includes('SBF program panicked')),halts);
        const after=await test.account(address);
        assert.deepEqual(after,succeeds?{...before,data:new Uint8Array([17,34])}:before);
        rows.push({name,returningBranch:returns,before,result,after});
      }finally{await test.close();}
    }
    for(const extension of ['.s','.o','.so','-checker.json'])artifacts[stem+extension]=hash(stem+extension);
  }
  assert.equal(rows.length,8);
  const sources=[fileURLToPath(import.meta.url),...['../compiler/sbf-call-depth.ts','../compiler/sbf-call-depth-artifact.ts','../sdk/testing.ts'].map(p=>fileURLToPath(new URL(p,import.meta.url))),'runtime/sbf.ld',path.join(tools,'clang'),path.join(tools,'ld.lld')];
  const inputs=Object.fromEntries(sources.map(p=>[path.resolve(p),hash(p)]));
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify({passed:true,vmExecutions:8,rows,inputs,artifacts,scope:'Pinned offline VM abort/return and conditional guest continuation tests. Failed transactions preserve watched account balance, owner, executable flag and data exactly. SDK account snapshots omit rent_epoch; no rent metadata theorem. Exact abort assumption receipt controls reject missing/changed/extra profile fields. No application-specific compiler behavior.'},null,2)+'\n');
  console.log('Eight SBF abort/return controls and exact terminal-syscall profile refusals passed');
}
if(import.meta.main)await testSbfCallDepthRuntime();
