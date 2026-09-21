import assert from 'node:assert/strict';
import { testPure, type PureCase } from './pure.ts';
import type { WireValue } from '../sdk/wire.ts';

export async function testCollection() {
  await testPure('tests/collection.bend', ['read_range','reserve_range','get_word','get_flag','set_word','set_flag','push_word','push_flag'],
    'build/collection', schema => {
      const cases: PureCase[] = [];
      const construct=(type:string, tag:number, values:WireValue[]):WireValue=>{
        const t=schema.types.find(t=>t.name===type)!;assert(t.kind==='adt');
        const v=t.variants[tag];assert.equal(v.fields.length,values.length);
        return {constructor:v.name,fields:Object.fromEntries(v.fields.map((f,i)=>[f.name,values[i]]))};
      };
      const field=(type:string,index:number)=>{
        const t=schema.types.find(t=>t.name===type)!;assert(t.kind==='adt');
        return t.variants[0].fields[index].type;
      };
      // Include invalid metadata and arithmetic that would wrap under u32 addition.
      for(const name of ['read_range','reserve_range']) {
        const exp=schema.exports.find(e=>e.name===name)!;
        const result=schema.types.find(t=>t.name===exp.result)!;assert(result.kind==='adt');
        const range=result.variants[1].fields[0].type;
        for(const [length,capacity] of [[0,0],[0,256],[3,256],[256,256],[257,256],
          [0xfffffffe,0xffffffff],[0xffffffff,0xffffffff]])
          for(const start of [...new Set([0,1,length,Math.max(0,length-1),256,0xffffffff])])
            for(const count of [0,1,4,5,0xffffffff]) {
              const maximum=4;
              // JS numbers exactly represent sums of two u32 values: independent
              // mathematical interval oracle, without the SDK subtraction formula.
              const valid=length<=capacity && count<=maximum && start<=length &&
                start+count<=(name==='read_range'?length:capacity);
              cases.push({name,args:[construct(exp.args[0],0,[length,capacity]),start,count,maximum],
                expected:construct(exp.result,valid?1:0,valid?[construct(range,0,[start,count])]:[])});
            }
      }
      const backing=(type:string,values:WireValue[]):WireValue=>values.length===1?values[0]:
        construct(type,0,[backing(field(type,0),values.slice(0,values.length/2)),
          backing(field(type,1),values.slice(values.length/2))]);
      for(const [name,values] of [['get_word',[17,42,0,0xffffffff]],['get_flag',[true,false]]] as const) {
        const exp=schema.exports.find(e=>e.name===name)!;
        const vector=field(exp.args[0],1),storage=field(vector,1);
        const set=schema.exports.find(e=>e.name===name.replace('get_','set_'))!;
        const push=schema.exports.find(e=>e.name===name.replace('get_','push_'))!;
        const replacement:WireValue=name==='get_word'?73:true;
        const window=(start:number,length:number,xs:WireValue[])=>construct(exp.args[0],0,[start,construct(vector,0,[length,backing(storage,xs)])]);
        for(const start of [0,127,0xfffffffe])
          for(const length of [0,1,values.length,values.length+1,0xffffffff])
            for(const index of [...new Set([0,126,127,128,130,0xfffffffd,0xfffffffe,0xffffffff])]) {
              const local=index-start,valid=length<=values.length && local>=0 && local<length;
              cases.push({name,args:[construct(exp.args[0],0,[start,construct(vector,0,[length,backing(storage,[...values])])]),index],
                expected:construct(exp.result,valid?1:0,valid?[values[local]]:[])});
              const changed:WireValue[]=[...values];if(valid)changed[local]=replacement;
              cases.push({name:set.name,args:[window(start,length,[...values]),index,replacement],
                expected:construct(set.result,valid?1:0,valid?[window(start,length,changed)]:[])});
            }
        for(const start of [0,127,0xfffffffe]) for(const length of [0,1,values.length,values.length+1,0xffffffff]) {
          const valid=length<values.length,changed:WireValue[]=[...values];if(valid)changed[length]=replacement;
          cases.push({name:push.name,args:[window(start,length,[...values]),replacement],
            expected:construct(push.result,valid?1:0,valid?[window(start,length+1,changed)]:[])});
        }
      }
      return cases;
    });
}
if(import.meta.main) await testCollection();
