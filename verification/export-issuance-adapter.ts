import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,checkedProgram} from '../compiler/backend.ts';
import {writeArtifacts} from '../compiler/artifacts.ts';
import {model} from './model.ts';
import {digest,inventory} from './check-acyclic-lowering.ts';
export async function exportIssuanceAdapter(directory:string) {
fs.mkdirSync(directory,{recursive:true});
const sourceFile='tests/token-issuance.bend',root='process';
const before=inventory(),checked=await checkedProgram(sourceFile),source=await model(sourceFile,[root]);
const actual=new Backend(checked.book).emit([root]),withoutNative=new Backend(checked.book,{nativeArithmetic:false}).emit([root]);
assert.equal(actual.c,withoutNative.c);
writeArtifacts(`${directory}/issuance`,actual,root);
const files:Record<string,string>={},paths:Record<string,string>={},pending=['issuance.c'];
while(pending.length) {
 const name=pending.pop()!;if(name in files)continue;
 const file=[path.join(directory,name),path.join('runtime',name)].find(p=>fs.existsSync(p));assert.ok(file,`include ${name}`);
 files[name]=fs.readFileSync(file,'utf8');paths[name]=file;
 for(const m of files[name].matchAll(/^[ \t]*#[ \t]*include[ \t]*["<]([^">\n]+)[">]/gm))pending.push(m[1]);
}
assert.equal(files['issuance.h'],actual.c);
const schema=JSON.parse(fs.readFileSync(`${directory}/issuance.schema.json`,'utf8')),iface=JSON.parse(fs.readFileSync(`${directory}/issuance.interface.json`,'utf8'));
assert.deepEqual(schema,source.schema);assert.equal(iface.root,root);
assert.deepEqual(inventory(),before);
const program={source,artifact:{fixture:sourceFile,c:files['issuance.h'],cSha256:digest(files['issuance.h']),schema}};
const fixture={name:'issuance',source:sourceFile,root,adapter:'issuance.c',files,schema,interface:iface};
fs.writeFileSync(`${directory}/input.json`,JSON.stringify({sourceHashes:before,program,fixture,artifactHashes:Object.fromEntries(Object.entries(paths).map(([name,p])=>[p,digest(files[name])]))},null,2)+'\n');
console.log('Exported issuance executor probe and exact adapter/header closure');
}
if(import.meta.main)await exportIssuanceAdapter(process.env.BRIDGE_DIR??'build/issuance-adapter');
