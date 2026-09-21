import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { compileSbf } from '../scripts/build.ts';
import { testPure, type PureCase } from './pure.ts';

export async function testVesting() {
  const emitted = new Backend(await checkedBook('examples/vesting/PROOF.bend')).emit(['vesting.process']);
  writeArtifacts('build/vesting',emitted,'vesting.process');
  compileSbf('build/vesting.c','build/vesting');
  const source=fs.readFileSync('examples/vesting/vesting.bend','utf8');
  for(const [before,after] of [['Rejected{3}','Rejected{0}'],['Rejected{4}','Rejected{0}'],
    ['Rejected{6}','transfer(schedule, amount)'],['Bool.and(signed, Sol.equal(actor, beneficiary))','True{}']]) {
    const dir=fs.mkdtempSync('examples/.vesting-negative-');
    try {
      for(const name of ['LAWS.bend','PROOF.bend']) fs.copyFileSync(`examples/vesting/${name}`,`${dir}/${name}`);
      assert.ok(source.includes(before));fs.writeFileSync(`${dir}/vesting.bend`,source.replace(before,after));
      await assert.rejects(()=>checkedBook(`${dir}/PROOF.bend`),/expected|mismatch/i);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  await testPure('examples/vesting/PROOF.bend',['vesting.entitlement'],'build/entitlement',schema=>{
    const exp=schema.exports[0];
    const scalar=schema.types.find(t=>t.name===exp.args[0])!;
    const result=schema.types.find(t=>t.name===exp.result)!;
    if(scalar.kind!=='adt'||result.kind!=='adt') throw new Error('Expected data');
    const u64=(n:bigint)=>({constructor:scalar.variants[0].name,fields:{lo:Number(n&0xffffffffn),hi:Number(n>>32n)}});
    const max=(1n<<64n)-1n, cases:PureCase[]=[];
    for(const total of [1n,7n,1000n,1n<<32n,max]) for(const [start,end] of [[10n,20n],[1n,max]]) {
      for(const now of [...new Set([0n,start-1n,start,start+1n,(start+end)/2n,end-1n,end,max])]) {
        const expected=now<=start?0n:now>=end?total:total*(now-start)/(end-start);
        cases.push({name:exp.name,args:[u64(total),u64(start),u64(end),u64(now)],
          expected:{constructor:result.variants.find(v=>v.name.endsWith('.Ok'))!.name,fields:{value:u64(expected)}}});
      }
    }
    return cases;
  });
  console.log('Vesting source laws and four negative mutations passed; shared adapter built');
}
