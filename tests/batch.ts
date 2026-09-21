import fs from 'node:fs';
import assert from 'node:assert/strict';
import { checkedBook } from '../compiler/backend.ts';
import { buildProgram } from '../scripts/program.ts';
import { testPure, type PureCase } from './pure.ts';
import { effectLayout } from '../compiler/effects.ts';
import { model } from '../verification/model.ts';
import type { WireValue } from '../sdk/wire.ts';

export async function testBatch() {
  const manifest=await buildProgram('examples/batch/PROOF.bend','batch.process','build/batch');
  const directory=fs.mkdtempSync('build/batch-reproduce-');
  try {assert.deepEqual(await buildProgram('examples/batch/PROOF.bend','batch.process',`${directory}/batch`),manifest);}
  finally {fs.rmSync(directory,{recursive:true,force:true});}
  const source=fs.readFileSync('examples/batch/batch.bend','utf8');
  for(const [before,after] of [
    ['case Closed{}:\n      Rejected{2}','case Closed{}:\n      Rejected{0}'],
    ['case B.Invalid{}:\n      Rejected{3}','case B.Invalid{}:\n      Rejected{0}'],
    ['case False{}:\n      Rejected{6}','case False{}:\n      Accepted{Closed{}, effects}'],
    ['Math.Err{code}\n    case Math.Ok{value}:\n      positive','Math.Err{0}\n    case Math.Ok{value}:\n      positive'],
  ]) {
    const dir=fs.mkdtempSync('examples/.batch-laws-negative-');
    try {
      for(const name of ['LAWS.bend','PROOF.bend'])fs.copyFileSync(`examples/batch/${name}`,`${dir}/${name}`);
      assert(source.includes(before));fs.writeFileSync(`${dir}/batch.bend`,source.replace(before,after));
      await assert.rejects(()=>checkedBook(`${dir}/PROOF.bend`),/expected|mismatch/);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
  await testPure('examples/batch/batch.bend',['process'],'build/batch-pure',schema=>{
    const type=(name:string)=>{const t=schema.types.find(t=>t.name===name)!;assert(t.kind==='adt');return t;};
    const field=(name:string,tag:number,index:number)=>type(name).variants[tag].fields[index].type;
    const c=(name:string,tag:number,...values:WireValue[]):WireValue=>{
      const v=type(name).variants[tag];return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,values[i]]))};
    };
    const root=schema.exports[0],[context,state,ix]=root.args,out=root.result;
    const batch=field(state,1,0),keyType=field(context,0,0),wordType=field(context,0,2);
    const vector=field(batch,0,3),store=field(vector,0,1),pair=field(store,0,0),item=field(pair,0,0);
    const effects=field(out,0,1),es=field(effects,0,1),ep=field(es,0,0),effect=effectLayout(schema,effects).type;
    const detail=field(effect,5,0),binding=field(effect,5,1),recipient=field(detail,0,4),authority=field(detail,0,6);
    const key=(n:number)=>c(keyType,0,...Array(8).fill(n));
    const word=(n:bigint)=>c(wordType,0,Number(n&0xffffffffn),Number(n>>32n));
    const pack=(outer:string,inner:string,xs:WireValue[])=>c(outer,0,c(inner,0,xs[0],xs[1]),c(inner,0,xs[2],xs[3]));
    const ev=(active:WireValue[])=>c(effects,0,active.length,pack(es,ep,[...active,...Array(4-active.length).fill(c(effect,0))]));
    const transfer=(fund:boolean,index:number,amount:bigint)=>c(effect,5,
      c(detail,0,4,fund?5:6+index,fund?6:5,key(2),fund?c(recipient,1):c(recipient,2,key(10+index)),word(amount),c(authority,fund?0:1)),
      fund?c(binding,0):c(binding,1,key(3)),fund?c(binding,1,key(3)):c(binding,0),false);
    const reject=(code:number)=>c(out,1,code),max=(1n<<64n)-1n;
    const cases:PureCase[]=[];
    for(const amounts of [[10n,20n,30n,40n],[0n,1n,max,1n],[max,1n,1n,1n]])
    for(const [length,fuel] of [[0,0],[1,1],[2,2],[3,3],[4,4],[5,5],[2,1],[1,2],[1,64],[0xffffffff,1]]) {
      const obligations=c(vector,0,length,pack(store,pair,amounts.map((a,i)=>c(item,0,key(10+i),word(a)))));
      let total=0n,error=0;
      if(length>4||length!==fuel)error=3;
      else for(const amount of amounts.slice(0,length)) {if(!amount){error=3;break;}total+=amount;if(total>max){error=4;break;}}
      const stored=total<=max?total:0n;
      for(const signed of [false,true]) {
        const ctx=c(context,0,key(1),signed,word(100n));
        const init=c(ix,0,key(2),key(3),obligations,fuel);
        const expected=!signed?reject(1):error?reject(error):total===0n?reject(3):
          c(out,0,c(state,1,c(batch,0,key(1),key(2),key(3),obligations,fuel,word(total))),ev([transfer(true,0,total)]));
        cases.push({name:'process',args:[ctx,c(state,0),init],expected});
        const funded=c(state,1,c(batch,0,key(1),key(2),key(3),obligations,fuel,word(stored)));
        const settleExpected=!signed?reject(1):length>4||length!==fuel?reject(5):error?reject(error):total===0n?reject(6):
          c(out,0,c(state,2),ev(amounts.slice(0,length).map((a,i)=>transfer(false,i,a))));
        cases.push({name:'process',args:[ctx,funded,c(ix,1)],expected:settleExpected});
      }
    }
    return cases;
  });
  fs.writeFileSync('build/batch.model.json',JSON.stringify(await model('examples/batch/batch.bend',['process','sum']))+'\n');
  console.log('Batch laws and four negative mutations passed; complete source transition differential cases built');
}
if(import.meta.main)await testBatch();
