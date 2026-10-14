import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {checkedProgram} from '../compiler/backend.ts';
import {checkedRuntimeIdentity} from '../compiler/checked-runtime-identity.ts';
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
const shiftedByCanonical = new Map([...renamed.names].map(([raw, canonical]) => [canonical, raw]));
const renumbered = [...normal.names].filter(([raw, canonical]) => {
  const before = raw.match(/~(\d+)$/), after = shiftedByCanonical.get(canonical)?.match(/~(\d+)$/);
  return before && after && before[1] !== after[1];
});
assert.ok(renumbered.length > 0, 'fixture must actually change raw generic-instance numbering');
assert.equal(renamed.canonical('../sdk/sha256-reference.hash_short'),normal.canonical('../../sdk/sha256-reference.hash_short'));

const original = checkedRuntimeIdentity(base.book, ['../../sdk/sha256-reference.hash_short'], normal.canonical);
const relocated = checkedRuntimeIdentity(shifted.book, ['../sdk/sha256-reference.hash_short'], renamed.canonical);
const differences = [...new Set([...Object.keys(original.definitions), ...Object.keys(relocated.definitions)])]
  .filter(name => original.definitions[name] !== relocated.definitions[name]);
fs.writeFileSync(path.join(dir, 'graph-comparison.json'), JSON.stringify({original, relocated, differences}, null, 2) + '\n');
assert.deepEqual(differences, [], 'complete checked definition graphs normalize across namespace/instance changes');
assert.equal(original.sha256, relocated.sha256);
// Each checked mutation starts from the original bytes. A prior mutation must
// not make an unrelated, ineffective mutation appear detectable.
const mutations: {name: string; sha256: string}[] = [];
for (const [name, file, before, after] of [
  ['round constant', 'sdk/sha256-reference.bend', '1116352408', '1116352409'],
  ['transitive generic helper', 'sdk/buffer.bend',
    'pick(T, left, right, U32.is_zero(index))', 'pick(T, right, left, U32.is_zero(index))'],
  ['constructor field order', 'sdk/sha256-reference.bend',
    'Digest256{h0: U32, h1: U32', 'Digest256{h1: U32, h0: U32'],
] as const) {
  const target = path.join(dir, file), text = fs.readFileSync(target, 'utf8');
  assert.equal(text.split(before).length, 2, `${name}: unique mutation target`);
  try {
    fs.writeFileSync(target, text.replace(before, after));
    const changed = await checkedProgram(path.join(dir, 'app/PROOF.bend'));
    const changedNames = checkedModuleNames(changed.book, changed.modules, bindings(dir));
    const altered = checkedRuntimeIdentity(changed.book, ['../sdk/sha256-reference.hash_short'], changedNames.canonical);
    assert.notEqual(altered.sha256, original.sha256, `${name} cannot normalize away`);
    mutations.push({name, sha256: altered.sha256});
  } finally { fs.writeFileSync(target, text); }
}
const restored = await checkedProgram(path.join(dir, 'app/PROOF.bend'));
const restoredNames = checkedModuleNames(restored.book, restored.modules, bindings(dir));
assert.equal(checkedRuntimeIdentity(restored.book, ['../sdk/sha256-reference.hash_short'], restoredNames.canonical).sha256,
  original.sha256, 'restored source is the positive control');
fs.writeFileSync(path.join(dir, 'graph-mutations.json'), JSON.stringify({mutations, restored: original.sha256}, null, 2) + '\n');
assert.throws(() => checkedRuntimeIdentity(base.book, ['../../sdk/sha256-reference.hash_short'], () => 'collision'), /canonical name collision/);
console.log(`Normalized checked graph: ${Object.keys(original.definitions).length} definitions, relocated instances agree, ${mutations.length} independent checked mutations differ; ${dir}/graph-comparison.json`);

const callbackCalls = new Map<string, number>();
const stable = checkedRuntimeIdentity(base.book, ['../../sdk/sha256-reference.hash_short'], name => {
  const calls = (callbackCalls.get(name) ?? 0) + 1;
  callbackCalls.set(name, calls);
  return normal.canonical(name) + (calls > 1 ? '#later' : '');
});
assert.equal(stable.sha256, original.sha256, 'first canonical answer is fixed for each raw name');
assert.ok([...callbackCalls.values()].every(count => count === 1));
assert.ok(stable.roots.every(name => Object.hasOwn(stable.definitions, name)));
