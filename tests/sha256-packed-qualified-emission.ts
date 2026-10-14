import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Backend,checkedProgram} from '../compiler/backend.ts';
import {emitSha256PackedQualifiedSbf} from '../compiler/sha256-packed-qualified-emission.ts';
import {generateSha256Packed,type Sha256PackedIdentity} from '../compiler/sha256-packed.ts';
import type {RuntimeSchema} from '../compiler/schema.ts';

const hash=(bytes:string|Uint8Array)=>crypto.createHash('sha256').update(bytes).digest('hex');
const root=path.resolve(import.meta.dir,'..'),run=path.join(root,'build/sha256-packed-qualified-emission',crypto.randomUUID());fs.mkdirSync(run,{recursive:true});
const original='tests/sha256-packed-reference/PROOF.bend',roots=['program.hash_packed'];
const own=[import.meta.path,'compiler/sha256-packed.ts','compiler/sha256-packed-qualified-emission.ts','compiler/sha256-packed-qualification-pins.json'];
const before=Object.fromEntries(own.map(file=>[path.resolve(file),hash(fs.readFileSync(file))]));
const pins=JSON.parse(fs.readFileSync('compiler/sha256-packed-qualification-pins.json','utf8'));
const controls:{name:string;reason:string}[]=[];
const emission=await emitSha256PackedQualifiedSbf(original,roots);
const checked=await checkedProgram(original),backend=new Backend(checked.book),ordinary=backend.emit(roots),records=backend.emittedFunctions();
assert.deepEqual(emission.originalEmission,ordinary);assert.equal(hash(JSON.stringify(ordinary)),pins.ordinaryShaFixtureEmissionSha256);
assert.equal(emission.receipt.checkedRuntime.sha256,pins.checkedRuntime.sha256);assert.equal(emission.receipt.checkedRuntime.definitions,155);
assert.equal(emission.receipt.target.canonicalName,'$module:sha256-packed.hash_bounded');assert.equal(emission.receipt.target.internal,true);
assert.deepEqual(emission.schema.exports.map(e=>e.name),roots);assert.equal(Object.isFrozen(emission),true);
const target=records.find(r=>r.name===emission.receipt.target.emittedName)!;assert(target);
for(const record of records)assert.equal(emission.c.split(record.definition).length,record===target?1:2);
assert.equal(hash(emission.c),emission.receipt.replacement.resultingCSha256);
const schema:RuntimeSchema={...ordinary.schema,exports:[{name:target.name,cName:target.cName,args:target.args,result:target.result}]};
const adt=(s:RuntimeSchema,n:string):any=>{const t=s.types.find(t=>t.name===n);assert(t?.kind==='adt');return t;};
const message=adt(schema,target.args[0]).variants[0],bytes=adt(schema,message.fields[1].type).variants[0],result=adt(schema,target.result),digest=adt(schema,result.variants[1].fields[0].type).variants[0];
let child=bytes.fields[0].type;const pairs:string[]=[];
for(let i=0;i<5;i++){pairs.push(child);child=adt(schema,child).variants[0].fields[0].type;}
const identity:Sha256PackedIdentity={export:{name:target.name,cName:target.cName},u32Type:child,
 message:{type:target.args[0],constructor:message.sourceName??message.name,lengthField:'length',bytesField:'bytes'},
 bytes:{type:message.fields[1].type,constructor:bytes.sourceName??bytes.name,wordsField:'words',tailField:'tail'},
 pair:{types:pairs as Sha256PackedIdentity['pair']['types'],constructor:adt(schema,pairs[0]).variants[0].sourceName,leftField:'left',rightField:'right'},
 result:{type:target.result,rejected:result.variants[0].sourceName??result.variants[0].name,hashed:result.variants[1].sourceName??result.variants[1].name,digestField:'digest'},
 digest:{type:result.variants[1].fields[0].type,constructor:digest.sourceName??digest.name,fields:digest.fields.map((f:any)=>f.name)}};
const generated=generateSha256Packed(schema,identity);assert.equal(generated.slotPaths.length,40);assert.equal(new Set(generated.slotPaths).size,40);
assert.equal(hash(generated.definition),emission.receipt.replacement.definitionSha256);
assert(generated.definition.indexOf('> 151u')<generated.definition.indexOf(generated.slotPaths[0]));
assert(!generated.definition.includes(generated.slotPaths[38]));assert(!generated.definition.includes(generated.slotPaths[39]));
for(let i=0;i<151;i++)assert(generated.definition.includes(`/* active byte ${i} */`));
const schemaControls:[string,(s:RuntimeSchema)=>void,RegExp][]=[
 ['duplicate-type',s=>s.types.push(s.types[0]),/duplicate type identity/],
 ['arity',s=>s.exports[0].args.push(child),/exactly one/],
 ['bounded-u32',s=>(s.types.find(t=>t.name===child) as any).max=255,/unbounded/],
 ['missing-tail',s=>adt(s,identity.bytes.type).variants[0].fields.pop(),/field count/],
 ['swapped-packed-fields',s=>adt(s,identity.bytes.type).variants[0].fields.reverse(),/identity\/order\/type/],
 ['wrong-tail-depth',s=>adt(s,identity.bytes.type).variants[0].fields[1].type=pairs[1],/identity\/order\/type/],
 ['wrong-pair-child',s=>adt(s,pairs[0]).variants[0].fields[1].type=child,/identity\/order\/type/],
 ['recursive-pair',s=>adt(s,pairs[0]).variants[0].fields[0].type=pairs[0],/recursive schema/],
 ['nonzero-tag',s=>adt(s,identity.bytes.type).variants[0].tag=1,/order\/tag/],
 ['constructor-origin',s=>adt(s,pairs[2]).variants[0].sourceName='forged.Pair',/constructor identity/],
 ['result-order',s=>adt(s,identity.result.type).variants.reverse(),/order\/tag/],
 ['digest-order',s=>adt(s,identity.digest.type).variants[0].fields.reverse(),/identity\/order\/type/],
 ['reserved-export',s=>s.exports[0].cName='sol_sha256',/collides/],
 ['reserved-type',s=>adt(s,identity.message.type).cType='sha256_packed_message',/collides/],
 ['missing-field-type',s=>adt(s,identity.bytes.type).variants[0].fields[1].type='absent',/unknown field type/],
];
for(const [name,edit,reason] of schemaControls){const changed=structuredClone(schema);edit(changed);assert.throws(()=>generateSha256Packed(changed,identity),reason);controls.push({name,reason:reason.source});}
const fixtureFiles=[...['sha256-packed','sha256-reference','buffer','iteration'].map(n=>'sdk/'+n+'.bend'),...['program.bend','PROOF.bend','LAWS.bend'].map(n=>'tests/sha256-packed-reference/'+n)];
function fixture(name:string,edit:(relative:string,text:string)=>string=(r,t)=>t){
 const directory=path.join(run,name);for(const relative of fixtureFiles){const file=path.join(directory,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,edit(relative,fs.readFileSync(relative,'utf8')));}return {directory,source:path.join(directory,original)};
}
async function reject(name:string,source:string,reason:RegExp,inputRoots:any=roots){await assert.rejects(()=>emitSha256PackedQualifiedSbf(source,inputRoots),reason);controls.push({name,reason:reason.source});}
const relocated=fixture('relocated-renumbered',(r,t)=>r.endsWith('/PROOF.bend')?'import ./before.bend as Before\n'+t:t);
fs.writeFileSync(path.join(relocated.directory,'tests/sha256-packed-reference/before.bend'),'import ../../sdk/buffer.bend as B\n\ndef before(value: B.Pair<Bool>) -> Bool:\n  B.pair_get(Bool, value, 0)\n');
const moved=await emitSha256PackedQualifiedSbf(relocated.source,roots);assert.equal(moved.receipt.checkedRuntime.sha256,emission.receipt.checkedRuntime.sha256);assert.notDeepEqual(moved.receipt.sourceInputs,emission.receipt.sourceInputs);
const changedHelper=fixture('changed-helper',(r,t)=>r==='sdk/sha256-packed.bend'?t.replace('U32.mod(index, 4)','U32.mod(index, 3)'):t);
await reject('changed-packed-helper',changedHelper.source,/required sha256-packed module is absent or its full-byte pin changed/);
const changedS=fixture('changed-reference',(r,t)=>r==='sdk/sha256-reference.bend'?t+'\n# changed\n':t);await reject('changed-reference',changedS.source,/required sha256-reference module/);
const broken=fixture('proof-hole',(r,t)=>r.endsWith('/PROOF.bend')?t.replace('{==}','?TODO'):t);await reject('proof-hole',broken.source,/holes|open laws/);
const unsafe=fixture('unsafe',(r,t)=>r.endsWith('/program.bend')?t.replace('def hash_packed','unsafe def hash_packed'):t);await reject('unsafe-wrapper',unsafe.source,/unsafe/);
await reject('internal-root',original,/must remain an internal transitive function/,[emission.receipt.target.emittedName]);
await reject('unreachable-target',original,/not emitted exactly once/,[emission.receipt.target.emittedName.replace('hash_bounded','length_valid')]);
await reject('empty-roots',original,/nonempty/ ,[]);
await reject('sparse-roots',original,/dense/,new Array(1));
const shadow=fixture('shadow-buffer',(r,t)=>r==='sdk/buffer.bend'?t.replace('pick(T, left, right, U32.is_zero(index))','pick(T, right, left, U32.is_zero(index))'):r.endsWith('/PROOF.bend')?'import ../../real/buffer.bend as Real\n'+t:t);
fs.mkdirSync(path.join(shadow.directory,'real'));fs.copyFileSync('sdk/buffer.bend',path.join(shadow.directory,'real/buffer.bend'));
await reject('exact-unrelated-buffer-does-not-authorize-shadow',shadow.source,/complete checked SHA runtime graph differs/);
// Exact source pins cannot be replaced by duplicate modules or rewritten catalogs.
const duplicate=fixture('duplicate-origin',(r,t)=>r.endsWith('/PROOF.bend')?'import ../../duplicate/sha256-packed.bend as Extra\n'+t:t);
fs.mkdirSync(path.join(duplicate.directory,'duplicate'));
for(const n of ['sha256-packed','sha256-reference','buffer','iteration'])fs.copyFileSync('sdk/'+n+'.bend',path.join(duplicate.directory,'duplicate',n+'.bend'));
await reject('ambiguous-exact-module',duplicate.source,/ambiguous exact-byte matches/);
await assert.rejects(()=>(emitSha256PackedQualifiedSbf as any)(original,roots,{allowed:true}),/only source and ordinary runtime roots/);controls.push({name:'caller-authorization-payload',reason:'only source and ordinary runtime roots'});
for(const [name,file,reason] of [
 ['catalog','compiler/sha256-packed-qualification-pins.json',/catalog bytes/],
 ['engine','compiler/sha256-packed-qualified-emission.ts',/implementation bytes/],
 ['generator','compiler/sha256-packed.ts',/support input hash mismatch/],
 ['backend','compiler/backend.ts',/support input hash mismatch/],
] as const){
 const sandbox=path.join(run,'sandbox-'+name);
 for(const relative of [...Object.keys(pins.supportFiles),'compiler/sha256-packed-qualified-emission.ts','compiler/sha256-packed-qualification-pins.json',...fixtureFiles]){
  const out=path.join(sandbox,relative);fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(path.join(root,relative),out);
 }
 for(const dependency of ['.deps','node_modules'])fs.symlinkSync(path.join(root,dependency),path.join(sandbox,dependency),'dir');
 fs.appendFileSync(path.join(sandbox,file),name==='catalog'?'\n':'\n// altered qualification support\n');
 const engine=await import(pathToFileURL(path.join(sandbox,'compiler/sha256-packed-qualified-emission.ts')).href);
 const cwd=process.cwd();try{process.chdir(sandbox);await assert.rejects(()=>engine.emitSha256PackedQualifiedSbf(original,roots),reason);}finally{process.chdir(cwd);}
 controls.push({name:'altered-'+name,reason:reason.source});
}
// A changed book after ordinary emission must fail the second same-book identity.
const savedEmit=Backend.prototype.emit;let mutated=false;
try{
 Backend.prototype.emit=function(input:string[]){const out=savedEmit.call(this,input);if(!mutated){mutated=true;const declaration=(this as any).book.tlds[emission.receipt.target.emittedName];declaration.n++;}return out;};
 await reject('same-book-mutation',original,/checked book identity changed/);
}finally{Backend.prototype.emit=savedEmit;}
const restored=await emitSha256PackedQualifiedSbf(original,roots);assert.equal(restored.receipt.replacement.resultingCSha256,emission.receipt.replacement.resultingCSha256);
for(const [file,digest] of Object.entries({...before,...emission.receipt.supportInputs}).filter(([f])=>path.isAbsolute(f)))assert.equal(hash(fs.readFileSync(file)),digest,file);
fs.writeFileSync(path.join(run,'emission.json'),JSON.stringify(emission,null,2)+'\n');
fs.writeFileSync(path.join(run,'report.json'),JSON.stringify({passed:true,controls,relocationAccepted:true,restoredPositive:true,sourceInputs:emission.receipt.sourceInputs,ownInputs:before,checkedRuntime:emission.receipt.checkedRuntime,catalogSha256:emission.receipt.qualificationCatalogSha256,scope:'Source/root graph identity and exact schema/definition substitution controls. No native/VM equivalence or final ELF authorization is established by this test.'},null,2)+'\n');console.log(JSON.stringify({passed:true,controls:controls.length,report:path.join(run,'report.json')}));
