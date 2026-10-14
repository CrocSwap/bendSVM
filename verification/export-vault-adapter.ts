import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Backend,checkedProgram} from '../compiler/backend.ts';
import {writeArtifacts} from '../compiler/artifacts.ts';
import {model} from '../verification/model.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const directory=process.env.BRIDGE_DIR??'build/vault-adapter-bridge',sourceFile='examples/vault/PROOF.bend',root='vault.process';
const before=inventory(),checked=await checkedProgram(sourceFile),source=await model(sourceFile,[root]);
const actual=new Backend(checked.book).emit([root]),withoutNative=new Backend(checked.book,{nativeArithmetic:false}).emit([root]);
assert.equal(actual.c,withoutNative.c);
writeArtifacts(`${directory}/vault`,actual,root);
const files:Record<string,string>={},paths:Record<string,string>={},pending=['vault.c'];
while(pending.length) {
 const name=pending.pop()!;if(name in files)continue;
 const file=[path.join(directory,name),path.join('runtime',name)].find(p=>fs.existsSync(p));assert.ok(file,`include ${name}`);
 files[name]=fs.readFileSync(file,'utf8');paths[name]=file;
 for(const m of files[name].matchAll(/^[ \t]*#[ \t]*include[ \t]*["<]([^">\n]+)[">]/gm))pending.push(m[1]);
}
assert.equal(files['vault.h'],actual.c);
const schema=JSON.parse(fs.readFileSync(`${directory}/vault.schema.json`,'utf8')),iface=JSON.parse(fs.readFileSync(`${directory}/vault.interface.json`,'utf8'));
assert.deepEqual(schema,source.schema);assert.equal(iface.root,root);
assert.deepEqual(inventory(),before);
const program={source,artifact:{fixture:sourceFile,c:files['vault.h'],cSha256:digest(files['vault.h']),schema}};
const fixture={name:'vault',source:sourceFile,root,adapter:'vault.c',files,schema,interface:iface};
fs.writeFileSync(`${directory}/input.json`,JSON.stringify({sourceHashes:before,program,fixture,artifactHashes:Object.fromEntries(Object.entries(paths).map(([name,p])=>[p,digest(files[name])]))},null,2)+'\n');
console.log('Exported actual PROOF-root adapter and exact included native header');
