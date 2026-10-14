import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {checkedProgram} from '../compiler/backend.ts';
import {checkedModuleNames} from '../compiler/checked-module-names.ts';
const base=await checkedProgram('tests/sha256-reference/PROOF.bend');
const labels=['sha256-reference','buffer','iteration'];
const bindings=(root:string)=>labels.map(label=>({label,file:fs.realpathSync(path.join(root,`sdk/${label}.bend`))}));
const normal=checkedModuleNames(base.book,base.modules,bindings('.'));
assert.equal(normal.canonical('../../sdk/sha256-reference.hash_short'),'$module:sha256-reference.hash_short');
for(const name of ['user.sha256-reference.hash_short','../../sdk/sha256-reference-extra.hash_short'])assert.equal(normal.canonical(name),name,'exact namespace boundary');
const dir=fs.mkdtempSync('build/checked-module-names-');
for(const label of labels){const dest=path.join(dir,`sdk/${label}.bend`);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(`sdk/${label}.bend`,dest);}
fs.mkdirSync(path.join(dir,'app'));
for(const file of ['PROOF.bend','LAWS.bend']){
 let text=fs.readFileSync(`tests/sha256-reference/${file}`,'utf8').replaceAll('../../sdk/','../sdk/');
 if(file==='PROOF.bend')text='import ./before.bend as Before\n'+text;
 fs.writeFileSync(path.join(dir,'app',file),text);
}
fs.writeFileSync(path.join(dir,'app/before.bend'),'import Base\nimport ../sdk/buffer.bend as B\n\ndef warmup(value: B.Pair<Bool>) -> Bool:\n  B.pair_get(Bool, value, 0)\n');
const shifted=await checkedProgram(path.join(dir,'app/PROOF.bend'));
const renamed=checkedModuleNames(shifted.book,shifted.modules,bindings(dir));
const shiftedInstances=new Set(Object.values(shifted.book.tmps).flatMap(entries=>Object.values(entries)).map(name=>renamed.canonical(name)));
let instanceCount=0;
for(const entries of Object.values(base.book.tmps))for(const name of Object.values(entries)){
 assert.ok(shiftedInstances.has(normal.canonical(name)),`missing canonical instance ${name}`);instanceCount++;
}
assert.ok(instanceCount>20);
assert.equal(renamed.canonical('../sdk/sha256-reference.hash_short'),normal.canonical('../../sdk/sha256-reference.hash_short'));
const reject=(fn:()=>unknown,pattern:RegExp)=>assert.throws(fn,pattern);
reject(()=>checkedModuleNames(base.book,base.modules,[...bindings('.'),bindings('.')[0]]),/duplicate module label/);
reject(()=>checkedModuleNames(base.book,base.modules,[{label:'missing',file:'/missing'}]),/missing or ambiguous/);
reject(()=>checkedModuleNames(base.book,[...base.modules,base.modules[0]], [{label:'entry',file:base.modules[0].file}]),/missing or ambiguous/);
const shadow={...base.book,tlds:{...base.book.tlds,'$module:sha256-reference.hash_short':base.book.tlds['../../sdk/sha256-reference.hash_short']}};
reject(()=>checkedModuleNames(shadow,base.modules,bindings('.')),/canonical name collision/);
const template=Object.keys(base.book.tmps).find(name=>Object.keys(base.book.tmps[name]).length>1)!;
const entries=Object.entries(base.book.tmps[template]);
const duplicate={...base.book,tmps:{...base.book.tmps,[template]:{...base.book.tmps[template],[entries[1][0]]:entries[0][1]}}};
reject(()=>checkedModuleNames(duplicate,base.modules,bindings('.')),/duplicate instance identity/);
const invalid={...base.book,tmps:{[template]:{'bad JSON':entries[0][1]}}};
reject(()=>checkedModuleNames(invalid,base.modules,bindings('.')),/invalid instance argument encoding/);
const cycle={...base.book,tmps:{[template]:{[JSON.stringify({$: 'Ref',k:entries[0][1]})]:entries[0][1]}}};
reject(()=>checkedModuleNames(cycle,base.modules,bindings('.')),/cyclic instance arguments/);
// Dotted namespaces cannot establish which loaded module owns a prefix.
for (const [bound, other] of [['lib/a', 'lib/a.b'], ['lib/a.b', 'lib/a']]) {
 reject(() => checkedModuleNames(base.book, [{file:'/bound',namespace:bound,declarations:[]},{file:'/other',namespace:other,declarations:[]}],
   [{file:'/bound',label:'bound'}]), /overlapping loaded module namespaces/);
}
// JSON nesting for the supported Nat fuel boundary must not consume the
// independent name-dependency recursion budget.
const natLib=path.join(dir,'app/nat.bend');
fs.writeFileSync(natLib,'import Base\n\ndef id_n(~n: Nat, +x: U32) -> U32:\n  x\n');
const natEntry=path.join(dir,'app/nat-entry.bend');
fs.writeFileSync(natEntry,'import ./nat.bend as N\n\ndef process(x: U32) -> U32:\n  N.id_n(64n, x)\n');
const natProgram=await checkedProgram(natEntry);
const natNames=checkedModuleNames(natProgram.book,natProgram.modules,[{file:fs.realpathSync(natLib),label:'nat'}]);
assert.ok([...natNames.names.values()].some(name=>name.startsWith('$module:nat.id_n~')));
// Loaded root and Base declarations must not be credited to an imported file.
for (const boundName of ['lib', 'U32']) {
 const location=path.join(dir,`root-origin-${boundName}`);fs.mkdirSync(location);
 const boundFile=path.join(location,`${boundName}.bend`);
 fs.writeFileSync(boundFile,'import Base\n');
 const entry=path.join(location,'app.bend');
 const declaredName=boundName==='lib'?'lib.fake':'process';
 fs.writeFileSync(entry,`import ./${boundName}.bend as Bound\n\ndef ${declaredName}(x: U32) -> U32:\n  x\n`);
 const program=await checkedProgram(entry);
 assert.ok(program.modules.find(m=>m.namespace==='')?.declarations.includes(declaredName));
 reject(()=>checkedModuleNames(program.book,program.modules,[{file:fs.realpathSync(boundFile),label:'bound'}]),
   /definition origin outside bound module/);
}
const chained={...base.book,tlds:{...base.book.tlds},tmps:{}} as typeof base.book;
const chainEntries:Record<string,string>={};
for(let i=0;i<3;i++) {
 const name=`normalization_chain_${i}`;
 chained.tlds[name]=base.book.tlds[template];
 let argument:any={$:'Ref',k:i===2?'U32':`normalization_chain_${i+1}`};
 for(let j=0;j<180;j++)argument={$:'Ctr',k:'Succ',x:[argument]};
 chainEntries[JSON.stringify(argument)]=name;
}
chained.tmps[template]=chainEntries;
reject(()=>checkedModuleNames(chained,base.modules,bindings('.')),/combined traversal depth limit/);
fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({scope:'name mapping only, not complete graph identity or authorization',instanceCount,refusals:12,baseline:base.modules,relocated:shifted.modules},null,2)+'\n');
console.log(`Checked module names: ${instanceCount} instances stable across relocation and earlier import, 12 refusals plus Nat64; ${dir}/report.json`);
