// Test-only interception around real build work; the public command has no failure flag.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const phase=process.env.SHA_LIBRARY_TEST_FAILURE;
assert(['after-ordinary','after-qualified-compile','after-build','before-manifest','ordinary-object-swap','object-after-profile-swap'].includes(phase!));
const injected=()=>{throw new Error(`Injected ${phase} failure`);};
const write=fs.writeFileSync;
fs.writeFileSync=function(file,...args) {
  const result=write.call(fs,file,...args as [any,any]);
  if (phase==='after-ordinary' && String(file).endsWith('/library.manifest.json')) injected();
  return result;
} as typeof fs.writeFileSync;
const read=fs.readFileSync;
let swapped=false;
fs.readFileSync=function(file,...args) {
  if (String(file).endsWith('/library.qualified.sbf.o')) {
    assert(fs.existsSync(file),'The actual qualified compilation must finish before this control');
    if (phase==='after-qualified-compile') injected();
    if (phase==='ordinary-object-swap' && !swapped) {
      swapped=true;
      fs.copyFileSync(path.join(path.dirname(String(file)),'library.sbf.o'),file);
    }
  }
  const result=read.call(fs,file,...args as [any]);
  if (phase==='object-after-profile-swap' && String(file).endsWith('/library.qualified.sbf.su') && !swapped) {
    swapped=true;
    const directory=path.dirname(String(file));
    fs.copyFileSync(path.join(directory,'library.sbf.o'),path.join(directory,'library.qualified.sbf.o'));
  }
  return result;
} as typeof fs.readFileSync;
const rename=fs.renameSync;
fs.renameSync=function(from,to) {
  if (phase==='before-manifest' && String(to).endsWith('/active.json')) injected();
  const result=rename.call(fs,from,to);
  if (phase==='after-build' && path.basename(String(from)).startsWith('stage-') && path.basename(String(to)).startsWith('generation-')) injected();
  return result;
};
