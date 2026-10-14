import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {checkedProgram} from '../compiler/backend.ts';
import {validateCheckedSourcePaths} from '../compiler/checked-source-paths.ts';
const source='tests/sha256-reference/PROOF.bend';
const sha=await checkedProgram(source);
assert.deepEqual(validateCheckedSourcePaths(source,sha.modules),sha.files);
const dir=fs.mkdtempSync(path.resolve('build/checked-source-paths-'));
const write=(name:string,text:string)=>{const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);return file;};
write('other/real/m.bend','import Base\nimport ../n.bend as N\n\ndef mv(x: U32) -> U32:\n  N.far(x)\n');
write('other/n.bend','import Base\n\ndef far(x: U32) -> U32:\n  x\n');
write('p/n.bend','import Base\n\ndef near(x: U32) -> U32:\n  U32.add(x, 1)\n');
fs.symlinkSync(path.join(dir,'other/real'),path.join(dir,'p/link'));
const entry=write('p/app.bend','import ./link/m.bend as M\nimport ./n.bend as N\n\ndef process(x: U32) -> U32:\n  M.mv(x)\n');
const ambiguous=await checkedProgram(entry);
assert.ok(ambiguous.book.tlds['n.far']);
assert.equal(ambiguous.book.tlds['n.near'],undefined);
assert.ok(ambiguous.modules.some(m=>m.namespace==='n'&&m.file===fs.realpathSync(path.join(dir,'p/n.bend'))),
  'reproduce the recorded-path/read-byte mismatch');
assert.throws(()=>validateCheckedSourcePaths(entry,ambiguous.modules),/symlink source component/);
// Equivalent nested imports through ordinary directories are supported.
const plain=write('other/app.bend','import ./real/m.bend as M\n\ndef process(x: U32) -> U32:\n  M.mv(x)\n');
const normal=await checkedProgram(plain);
assert.deepEqual(validateCheckedSourcePaths(plain,normal.modules),normal.files);
// File symlink aliases are deliberately outside this qualification profile.
fs.symlinkSync(path.join(dir,'other/n.bend'),path.join(dir,'alias.bend'));
const alias=write('alias-entry.bend','import ./alias.bend as N\n\ndef process(x: U32) -> U32:\n  N.far(x)\n');
const aliasProgram=await checkedProgram(alias);
assert.throws(()=>validateCheckedSourcePaths(alias,aliasProgram.modules),/symlink source component/);
assert.throws(()=>validateCheckedSourcePaths(plain,normal.modules.filter(m=>m.namespace!=='')),/missing entry module/);
assert.throws(()=>validateCheckedSourcePaths(plain,[...normal.modules,normal.modules[0]]),/duplicate recorded file/);
const E=fs.mkdtempSync(path.resolve('build/checked-dotfile-paths-'));
const w=(n:string,t:string)=>{const f=path.join(E,n);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,t);return f;};
w('app.bend','import ./a/.bend as X\n\ndef process(x: U32) -> U32:\n  X.vx(x)\n');
w('a/.bend','import Base\nimport ./s/y.bend as Y\n\ndef vx(x: U32) -> U32:\n  Y.vy(x)\n');
w('s/y.bend','import Base\nimport ../g.bend as G\n\ndef vy(x: U32) -> U32:\n  G.g(x)\n');
w('g.bend','import Base\n\ndef g(x: U32) -> U32:\n  x\n');            // recorded bytes
w('deep/g.bend','import Base\n\ndef g(x: U32) -> U32:\n  U32.add(x, 7)\n'); // bytes actually read
fs.mkdirSync(path.join(E,'deep/t'),{recursive:true});
fs.symlinkSync(path.join(E,'s/y.bend'),path.join(E,'deep/t/y.bend'));
fs.symlinkSync(path.join(E,'deep/t'),path.join(E,'a/s'));
fs.symlinkSync(path.join(E,'g.bend'),path.join(E,'a/g.bend'));
const p=await checkedProgram(path.join(E,'app.bend'));
assert.ok(p.modules.some(m => m.namespace === 'a/'));
assert.ok(p.modules.some(m => m.namespace === 'g' && m.file === fs.realpathSync(path.join(E, 'g.bend'))));
const g = p.book.tlds['g.g'];
assert(g && g.$ === 'Def');
assert.match(JSON.stringify(g.v), /U32\.add/, 'loader read deep/g.bend, not recorded identity body');
assert.throws(() => validateCheckedSourcePaths(path.join(E, 'app.bend'), p.modules), /dotfile module namespace/);
fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify({scope:'local path qualification precondition under stable filesystem; no read-time receipt',shaFiles:sha.files,ambiguousModules:ambiguous.modules,refusals:5},null,2)+'\n');
console.log(`Checked source paths: SHA/plain positives, symlink-parent mismatch reproduced and refused, five refusals; ${dir}/report.json`);
