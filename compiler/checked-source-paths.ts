import fs from 'node:fs';
import path from 'node:path';
import {BASE_BEND} from '../.deps/bend/bend2/bend.ts';
import type {CheckedModule} from './backend.ts';

const fail=(message:string):never=>{throw new Error(`Checked source paths: ${message}`);};

// Qualification-only precondition. This does not change ordinary loading and
// is not a receipt for bytes read earlier. Requires an unchanged, non-hostile
// filesystem between checking, validation, hashing and artifact production.
export function validateCheckedSourcePaths(entry: string, modules: readonly CheckedModule[]): string[] {
  const absolute=path.resolve(entry);
  const entryDirectory=path.dirname(absolute);
  function withoutLinks(raw:string):string {
    if(!path.isAbsolute(raw))return fail('expected absolute source path');
    const parsed=path.parse(raw);
    let current=parsed.root;
    const segments=raw.slice(parsed.root.length).split(path.sep);
    if(segments.length>512)fail('path component limit');
    // Do not normalize before checking: a symlink followed by '..' is exactly
    // the ambiguous case we must see and refuse.
    for(const segment of segments) {
      if(!segment || segment==='.')continue;
      current=segment==='..'?path.dirname(current):path.join(current,segment);
      if(fs.lstatSync(current).isSymbolicLink())fail(`symlink source component ${current}`);
    }
    if(!fs.statSync(current).isFile())fail(`not a source file ${current}`);
    return fs.realpathSync(current);
  }
  const entryFile=withoutLinks(absolute);
  const baseFile=withoutLinks(BASE_BEND);
  if(modules.length>4096)fail('module count limit');
  const seen=new Set<string>();
  let hasEntry=false;
  for(const module of modules) {
    // A .bend basename loses its physical parent in child namespace resolution.
    if(module.namespace.endsWith('/'))fail('dotfile module namespace is outside the local-source profile');
    if(seen.has(module.file))fail('duplicate recorded file');
    seen.add(module.file);
    let candidate:string;
    if(module.namespace==='') {
      if(module.file===entryFile){candidate=absolute;hasEntry=true;}
      else if(module.file===baseFile)candidate=BASE_BEND;
      else return fail('unrecognized empty namespace');
    } else {
      // Hub cache addressing is not part of this local-source qualification
      // profile. Ordinary checkedProgram retains its existing package support.
      if(/^0x[0-9a-f]+\//.test(module.namespace))fail('hub import requires a separate source-path profile');
      candidate=path.isAbsolute(module.namespace)?`${module.namespace}.bend`:
        `${entryDirectory}${path.sep}${module.namespace}.bend`;
    }
    if(withoutLinks(candidate)!==module.file)fail(`loader path mismatch for ${module.namespace}`);
  }
  if(!hasEntry)fail('missing entry module');
  return [...seen];
}
