import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';


// Standalone ABI 2 assurance. Every positive and mutated C fixture is written
// by compiler/artifacts.ts with the actual multi-storage layout option, then
// read back from disk with its complete include closure.
const root = process.cwd();
const directory = process.env.TOKEN_COMPOSITION_FIXTURES!;
assert(directory);
fs.mkdirSync(directory,{recursive:true});
const sha = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shaText = (text:string) => crypto.createHash('sha256').update(text).digest('hex');
const immutableInputs:Record<string,string> = {};
const selections = [2,3,4].map(n=>[`token-${n}`,`tests/multi-token-${n}.bend`,'process',`tests/multi-token-${n}.layout.json`] as const);
const {Backend,checkedProgram} = await import(path.join(root,'compiler/backend.ts'));
const {writeArtifacts} = await import(path.join(root,'compiler/artifacts.ts'));
const {model} = await import(path.join(root,'verification/model.ts'));
const fixtures:any[] = [];
for (const [name,source,entry,layoutPath] of selections) {
  const checked = await checkedProgram(source);
  const emitted = new Backend(checked.book).emit([entry]);
  const layout = JSON.parse(fs.readFileSync(layoutPath,'utf8'));
  const stem = `${directory}/${name}`;
  writeArtifacts(stem,emitted,entry,{stateAccounts:layout.stateAccounts});
  const files:Record<string,string> = {}, paths:Record<string,string> = {};
  const pending = [{file:`${name}.c`, found:`${stem}.c`}];
  while (pending.length) {
    const {file,found} = pending.pop()!;
    if (file in files) {
      assert.equal(path.resolve(paths[file]),path.resolve(found),`${name}: ambiguous include binding ${file}`);
      continue;
    }
    files[file] = fs.readFileSync(found,'utf8'); paths[file] = found;
    for (const match of files[file].matchAll(/^[ \t]*#[ \t]*include[ \t]*(["<])([^">\n]+)[">]/gm)) {
      // Match Clang's quoted-header directory search followed by -Ibuild -Iruntime.
      const search=match[1]==='"'?[path.dirname(found),'build','runtime']:['build','runtime'];
      const resolved=search.map(dir=>path.join(dir,match[2])).find(p=>fs.existsSync(p));
      assert(resolved,`${name}: unresolved include ${match[2]}`);
      pending.push({file:match[2],found:resolved});
    }
  }
  const schemaPath=stem+'.schema.json', interfacePath=stem+'.interface.json';
  const schema=JSON.parse(fs.readFileSync(schemaPath,'utf8'));
  const iface=JSON.parse(fs.readFileSync(interfacePath,'utf8'));
  assert.equal(iface.version,2,`${name}: actual compiler did not emit ABI 2`);
  assert.equal(iface.stateAccounts.length,Number(name.at(-1)),`${name}: wrong account coverage`);
  for (const file of [...checked.files,source,layoutPath,schemaPath,interfacePath,...Object.values(paths)])
    immutableInputs[path.resolve(file)] = sha(file);
  const sourceModel=await model(source,[entry]);
  assert.deepEqual(sourceModel.schema,schema);
  const program={source:sourceModel,artifact:{fixture:source,c:files[`${name}.h`],cSha256:shaText(files[`${name}.h`]),schema}};
  fixtures.push({program,name,source,root:entry,layoutPath,adapter:`${name}.c`,files,schema,interface:iface,
    schemaFileSha256:sha(schemaPath),interfaceFileSha256:sha(interfacePath),
    artifactPaths:Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,path.resolve(v)])),
    sourceDependencies:Object.fromEntries([...new Set([...checked.files,source,layoutPath])].map(f=>[path.resolve(f),sha(f)]))});
}

fs.writeFileSync(path.join(directory,'input.json'),JSON.stringify({fixtures,immutableInputs},null,2)+'\n');
console.log(path.join(directory,'input.json'));
