import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Backend,checkedProgram} from '../compiler/backend.ts';
import {model} from './model.ts';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export const fixtures=[['examples/vesting/PROOF.bend','vesting.process'],['examples/exchange/PROOF.bend','exchange.process'],['examples/amm/PROOF.bend','amm.process']] as const;
export async function exportPrograms() {
 const programs=[];
 for(const [file,root] of fixtures) {
  const checked=await checkedProgram(file),before=Object.fromEntries(checked.files.map(p=>[p,hash(fs.readFileSync(p))]));
  const source=await model(file,[root]),actual=new Backend(checked.book).emit([root]);
  const ordinary=new Backend(checked.book,{nativeArithmetic:false}).emit([root]);
  for(const [p,h] of Object.entries(before))if(hash(fs.readFileSync(p))!==h)throw Error('source drift');
  programs.push({source,defaultProductionCMatches:actual.c===ordinary.c,artifact:{fixture:file,c:actual.c,cSha256:hash(actual.c),schema:actual.schema},sourceHashes:before});
 }
 return {programs,sourceModels:{
  math:JSON.stringify(await model('sdk/math.bend',['mul32_parts','mul32','mul_parts','mul'])),
  wide:JSON.stringify(await model('sdk/wide.bend',['add','product_parts','product'])),
  division:JSON.stringify(await model('sdk/math.bend',['div_step','div2','div4','div8','div16','div32','div64','divmod','div','mod'])),
 }};
}
