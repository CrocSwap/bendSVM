import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Backend,checkedProgram} from '../compiler/backend.ts';
import {model} from './model.ts';
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
export const fixtures=[{file:'tests/lowering.bend',roots:['swap','select','update','normalize','identity']},
 {file:'tests/generics.bend',roots:['choose_word','choose_flag','nested','unwrap','present','absent']},
 {file:'examples/vault/vault.bend',roots:['authorize','deposited','withdrawn']},
 {file:'examples/vesting/vesting.bend',roots:['authorize','initialize','transfer','payout','funded_total','delta','difference','bounded','claim_result','initialize_instruction','empty']}];
export async function exportPrograms() {
const programs=[];
for(const f of fixtures) {
 const checked=await checkedProgram(f.file);
 const before=Object.fromEntries(checked.files.map(p=>[p,hash(fs.readFileSync(p))]));
 const source=await model(f.file,f.roots);
 const emitted=new Backend(checked.book,{nativeArithmetic:false}).emit(f.roots);
 const ordinary=new Backend(checked.book).emit(f.roots);
 if(emitted.c!==ordinary.c)throw Error('default production emission differs from modeled artifact');
 for(const [p,h] of Object.entries(before))if(hash(fs.readFileSync(p))!==h)throw Error('source drift');
 programs.push({source,defaultProductionCMatches:true,artifact:{fixture:f.file,c:emitted.c,cSha256:hash(emitted.c),schema:emitted.schema},sourceHashes:before});
}
return programs;
}
