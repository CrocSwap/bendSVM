import crypto from 'node:crypto';
import type * as B from '../.deps/bend/bend2/bend.ts';
import type {CheckedModule} from './backend.ts';

export type ModuleBinding = {file: string; label: string};
const fail = (message: string): never => {throw new Error(`Checked module names: ${message}`);};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

// Naming only, never authorization: callers must bind source bytes and the
// complete checked graph. Modules must be the actual checkedProgram loader map.
export function checkedModuleNames(book: B.Book, modules: readonly CheckedModule[], bindings: readonly ModuleBinding[]) {
  const origins = new Map<string, Set<string>>();
  for (const module of modules) {
    if (!Array.isArray(module.declarations)) fail('missing declaration origin metadata');
    for (const name of module.declarations) {
      if (typeof name !== 'string') fail('invalid declaration origin name');
      const names = [name];
      const declaration = book.tlds[name];
      if (declaration?.$ === 'ADT') names.push(...declaration.c.map(c => c.k));
      for (const ownedName of names) {
        let owners = origins.get(ownedName);
        if (!owners) {owners = new Set(); origins.set(ownedName, owners);}
        owners.add(module.file);
      }
    }
  }
  const prefixes: {raw: string; canonical: string}[] = [];
  const boundFiles = new Set<string>(), labels = new Set<string>();
  for (const binding of bindings) {
    if (!/^[a-z][a-z0-9-]*$/.test(binding.label) || labels.has(binding.label)) fail('invalid or duplicate module label');
    if (boundFiles.has(binding.file)) fail('duplicate bound file');
    const matches = modules.filter(m => m.file === binding.file);
    if (matches.length !== 1 || !matches[0].namespace) fail('missing or ambiguous module namespace');
    if (modules.some(m => m.file !== binding.file && m.namespace === matches[0].namespace)) fail('namespace shared by different modules');
    const namespace = matches[0].namespace;
    if (modules.some(m => m.file !== binding.file && m.namespace &&
        (m.namespace.startsWith(namespace + '.') || namespace.startsWith(m.namespace + '.'))))
      fail('overlapping loaded module namespaces');
    for (const [name, owners] of origins) {
      if (name.startsWith(namespace + '.') &&
          (owners.size !== 1 || !owners.has(binding.file)))
        fail('definition origin outside bound module');
    }
    boundFiles.add(binding.file);labels.add(binding.label);
    prefixes.push({raw: matches[0].namespace + '.', canonical: `$module:${binding.label}.`});
  }
  // Longest match matters when a module name is a prefix of another module.
  prefixes.sort((a,b) => b.raw.length-a.raw.length || compare(a.raw,b.raw));
  const instances = new Map<string, {template: string; args: unknown[]}>();
  for (const [template, entries] of Object.entries(book.tmps)) {
    for (const [key, instance] of Object.entries(entries)) {
      if (instances.size >= 4096 || key.length > 1_000_000) fail('instance metadata limit');
      if (instances.has(instance)) fail('duplicate instance identity');
      if (!Object.hasOwn(book.tlds, template) || !Object.hasOwn(book.tlds, instance)) fail('missing template or instance');
      let args: unknown[];
      try {args = key.split('\n').map(part => JSON.parse(part));}
      catch {return fail('invalid instance argument encoding');}
      instances.set(instance,{template,args});
    }
  }
  const names = new Map<string,string>(), busy = new Set<string>();
  let work = 0, activeFrames = 0;
  function enter() {if (++activeFrames > 512) fail('combined traversal depth limit');}
  function canonical(name: string): string {
    enter();
    try {
    if (typeof name !== 'string') return fail('invalid resolved name');
    if (busy.size > 128) fail('name recursion limit');
    const prior=names.get(name);if(prior !== undefined)return prior;
    if(busy.has(name))fail('cyclic instance arguments');
    busy.add(name);
    let result: string;
    try {
      const instance=instances.get(name);
      if(instance) {
        const args=instance.args.map(arg=>term(arg,0));
        result=canonical(instance.template)+'~'+crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
      } else {
        const prefix=prefixes.find(p=>name.startsWith(p.raw));
        result=prefix ? prefix.canonical+name.slice(prefix.raw.length) : name;
      }
    } finally {busy.delete(name);}
    names.set(name,result);
    return result;
    } finally {activeFrames--;}
  }
  function term(value: any, depth: number): any {
    enter();
    try {
    if(depth>512 || ++work>1_000_000)fail('instance argument limit');
    if(Array.isArray(value))return value.map(x=>term(x,depth+1));
    if(value===null || typeof value!=='object')return value;
    return Object.fromEntries(Object.keys(value).sort(compare).map(key=>[key,
      key==='k'&&['Ref','ADT','Ctr','Mat','PCtr'].includes(value.$) ? canonical(value[key]) :
      key==='r'&&value.$==='ADT' ? references(value[key]) : term(value[key],depth+1)]));
    } finally {activeFrames--;}
  }
  function references(value: any): string[] {
    if(!Array.isArray(value))return fail('invalid datatype references');
    return value.map(name=>canonical(name));
  }
  // Check injection over constructors as well as declarations, not just the
  // selected closure. Placeholder references can subsequently use the same map.
  const owners = new Map<string,string>();
  for(const raw of new Set([...Object.keys(book.tlds),...Object.keys(book.ctrs)])) {
    const mapped=canonical(raw);
    const other=owners.get(mapped);
    if(other !== undefined && other !== raw)fail('canonical name collision');
    owners.set(mapped,raw);
  }
  return {names: new Map(names), canonical};
}
