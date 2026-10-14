import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {prepareBend} from '../scripts/build.ts';

prepareBend();
const {checkedProgram} = await import('../compiler/backend.ts');
const {checkedRuntimeIdentity} = await import('../compiler/checked-runtime-identity.ts');
const B = await import('../.deps/bend/bend2/bend.ts');
const source = 'tests/sha256-reference/PROOF.bend';
const root = '../../sdk/sha256-reference.hash_short';
const load = async (file = source) => (await checkedProgram(file)).book;
const originalBook = await load();
const baseline = checkedRuntimeIdentity(originalBook, [root]);
assert.ok(Object.keys(baseline.definitions).length > 100, 'transitive closure must be traversed');
assert.ok(baseline.memoValues > 0, 'checked type memo values must be included');
assert.deepEqual(checkedRuntimeIdentity(await load(), [root]), baseline);
assert.throws(() => checkedRuntimeIdentity(originalBook, [root, root]), /duplicate root/);

const dir = fs.mkdtempSync('build/checked-runtime-identity-');
const fixture = path.join(dir, 'fixture');
for (const file of ['sdk/sha256-reference.bend', 'sdk/buffer.bend', 'sdk/iteration.bend',
  'tests/sha256-reference/PROOF.bend', 'tests/sha256-reference/LAWS.bend']) {
  fs.mkdirSync(path.dirname(path.join(fixture, file)), {recursive: true});
  fs.copyFileSync(file, path.join(fixture, file));
}
const fixtureSource = path.join(fixture, source);
assert.deepEqual(checkedRuntimeIdentity(await load(fixtureSource), [root]), baseline,
  'same checked source in a different directory must preserve exact relative names');
const mutations: string[] = [];
for (const [name, file, before, after] of [
  ['round constant', 'sdk/sha256-reference.bend', '1116352408', '1116352409'],
  ['transitive generic helper', 'sdk/buffer.bend',
    'pick(T, left, right, U32.is_zero(index))', 'pick(T, right, left, U32.is_zero(index))'],
  ['constructor field order', 'sdk/sha256-reference.bend',
    'Digest256{h0: U32, h1: U32', 'Digest256{h1: U32, h0: U32'],
] as const) {
  const target = path.join(fixture, file), text = fs.readFileSync(target, 'utf8');
  assert.equal(text.split(before).length, 2, `${name}: unique mutation target`);
  try {
    fs.writeFileSync(target, text.replace(before, after));
    const identity = checkedRuntimeIdentity(await load(fixtureSource), [root]);
    assert.notEqual(identity.sha256, baseline.sha256, `${name}: identity must change`);
    mutations.push(name);
  } finally { fs.writeFileSync(target, text); }
}

const cases: string[] = [];
async function rejected(name: string, mutate: (book: Awaited<ReturnType<typeof load>>) => void, message: RegExp) {
  const book = await load(); mutate(book);
  assert.throws(() => checkedRuntimeIdentity(book, [root]), message, name); cases.push(name);
}
await rejected('foreign dependency', book => {
  const def = book.tlds[root]; assert.equal(def.$, 'Def'); if (def.$ === 'Def') def.i = ['external'];
}, /unsafe\/foreign/);
await rejected('missing dependency', book => { delete book.tlds[root]; }, /invalid runtime root/);
await rejected('unresolved checked template placeholder', book => {
  const def = book.tlds[root];
  if (def.$ === 'Def') def.e = B.Ref(baseline.unresolvedSourceReferences[0]);
}, /unresolved dependency/);
await rejected('open law', book => { book.open = 1; }, /open laws/);
await rejected('unhandled closure', book => {
  const def = book.tlds[root]; if (def.$ === 'Def') def.e = {$: 'Lam', k: 'x', i: 0, f: (() => B.Ref('U32')) as any};
}, /unsupported function/);
await rejected('cyclic checked graph', book => {
  const term: any = {$: 'App', x: B.Ref('U32')}; term.f = term;
  const def = book.tlds[root]; if (def.$ === 'Def') def.e = term;
}, /cyclic term/);

// A memo is semantically relevant even when its variable spelling/index stays fixed.
const memoBook = await load(), memoDef = memoBook.tlds[root];
assert.equal(memoDef.$, 'Def');
if (memoDef.$ === 'Def') {
  memoDef.e = {$: 'Var', k: 'memo', i: 0, v: B.Ref('U32')};
  const first = checkedRuntimeIdentity(memoBook, [root]);
  memoDef.e = {$: 'Var', k: 'memo', i: 0, v: B.Ref('Bool')};
  assert.notEqual(checkedRuntimeIdentity(memoBook, [root]).sha256, first.sha256);
}
// Unreachable declarations are outside this runtime identity, not outside the proof gate.
const extra = await load(); extra.tlds.unused = {...extra.tlds[root]};
assert.equal(checkedRuntimeIdentity(extra, [root]).sha256, baseline.sha256);
// Type reduction may consume original bodies even with unchanged checked e.
const sourceBody = await load(), sourceDef = sourceBody.tlds[root];
if (sourceDef.$ === 'Def') sourceDef.v = B.Ref('U32');
assert.notEqual(checkedRuntimeIdentity(sourceBody, [root]).sha256, baseline.sha256);
assert.ok(baseline.unresolvedSourceReferences.length > 0);
const resolvedPlaceholder = await load();
resolvedPlaceholder.tlds[baseline.unresolvedSourceReferences[0]] = {...resolvedPlaceholder.tlds[root]};
assert.notEqual(checkedRuntimeIdentity(resolvedPlaceholder, [root]).sha256, baseline.sha256);
const registry = await load(), constructor = '../../sdk/sha256-reference.Digest256';
registry.ctrs[constructor] = {...registry.ctrs[constructor], n: registry.ctrs[constructor].n + 1};
assert.notEqual(checkedRuntimeIdentity(registry, [root]).sha256, baseline.sha256);
// Regression probes from independent review: source-only reachability does not
// permit arbitrary unresolved names, including another template's binder.
for (const missing of ['totally.unknown.name', '../../sdk/iteration.repeat~S']) {
  await rejected('foreign template placeholder ' + missing, book => {
    const def = book.tlds['../../sdk/buffer.pick'];
    if (def.$ === 'Def') def.e = B.Ref(missing);
  }, /unresolved dependency/);
}
await rejected('missing transitive checked helper', book => {
  delete book.tlds['../../sdk/sha256-reference.round_constant'];
}, /unresolved dependency/);
await rejected('unknown original-body reference', book => {
  const def = book.tlds[root]; if (def.$ === 'Def') def.v = B.Ref('missing.original');
}, /unresolved dependency/);
await rejected('invalid memo kind', book => {
  const def = book.tlds[root]; if (def.$ === 'Def') def.e = {$: 'Var', k: 'x', i: 0, v: {$: 'Bogus'} as any};
}, /unsupported term kind/);
await rejected('unknown memo field', book => {
  const def = book.tlds[root]; if (def.$ === 'Def') def.e = {$: 'Var', k: 'x', i: 0, v: {...B.Ref('U32'), extra: 1} as any};
}, /unknown term field/);
await rejected('invalid real nested memo', book => {
  const def = book.tlds[root]; if (def.$ !== 'Def') throw Error('missing definition');
  const seen = new Set<object>(); let changed = false;
  function visit(value: any) {
    if (changed || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.$ === 'Var' && value.v !== undefined) {value.v = {$: 'Bogus'}; changed = true; return;}
    for (const [k,v] of Object.entries(value)) if(k !== 's') visit(v);
  }
  visit(def.e); assert.ok(changed, 'real nested memo target exists');
}, /unsupported term kind/);
await rejected('bounded original-body lowering', book => {
  let term: any = B.Ref('U32'); for(let i=0;i<20_000;i++) term=B.App(term,B.Ref('U32'));
  const def=book.tlds[root]; if(def.$==='Def') def.v=term;
}, /lowering depth limit/);
const shared=await load(), sharedDef=shared.tlds[root];
if(sharedDef.$==='Def') {
  let term: any=B.Ref('U32'); for(let i=0;i<40;i++)term=B.App(term,term);
  sharedDef.v=term;
  assert.notEqual(checkedRuntimeIdentity(shared,[root]).sha256,baseline.sha256);
}
const helper='../../sdk/sha256-reference.short_length';
assert.notEqual(checkedRuntimeIdentity(originalBook,[root,helper]).sha256,
  checkedRuntimeIdentity(originalBook,[helper,root]).sha256,'root order binds export order');
assert.throws(()=>checkedRuntimeIdentity(originalBook,['../../sdk/sha256-reference.Message']),/invalid runtime root/);
const {IdentityTermLower}=await import('../compiler/identity-terms.ts');
// A single depth-zero lowering loses the distinction between a free context
// variable and a binder with the same spelling/index. Backend reduces first.
const freeMemo = B.App(B.Lam('x', 0, (_x: any) => B.Var('x', 0)), B.Ref('U32'));
const boundMemo = B.App(B.Lam('x', 0, (x: any) => x), B.Ref('U32'));
assert.deepEqual(B.term_lower(freeMemo), B.term_lower(boundMemo), 'reproduce old collision');
assert.notDeepEqual(B.term_lower(B.term_wnf(originalBook, freeMemo)),
  B.term_lower(B.term_wnf(originalBook, boundMemo)), 'Backend reduction distinguishes the pair');
const openLower = new IdentityTermLower();
assert.notDeepEqual(openLower.lowerOpen(freeMemo), openLower.lowerOpen(boundMemo));
for (const level of [0, 1, 2, 64, 65536]) {
  const free = B.Lam('x', level, (_x: any) => B.Var('x', level));
  const bound = B.Lam('x', level, (x: any) => x);
  assert.notDeepEqual(openLower.lowerOpen(free), openLower.lowerOpen(bound), `free level ${level}`);
}
const captureBook = await load(), captureDef = captureBook.tlds[root];
assert.equal(captureDef.$, 'Def');
if (captureDef.$ === 'Def') {
  captureDef.e = {$: 'Var', k: 'memo', i: 0, v: freeMemo};
  const freeIdentity = checkedRuntimeIdentity(captureBook, [root]).sha256;
  captureDef.e = {$: 'Var', k: 'memo', i: 0, v: boundMemo};
  assert.notEqual(checkedRuntimeIdentity(captureBook, [root]).sha256, freeIdentity,
    'whole graph must retain the memo capture distinction');
}
let getterCalls = 0;
const malformedArrays: any[][] = [];
const extendedArray: any = [B.Ref('U32')]; extendedArray.extra = true; malformedArrays.push(extendedArray);
const hiddenMap: any = [B.Ref('missing.hidden')]; hiddenMap.map = () => []; malformedArrays.push(hiddenMap);
const getter: any = []; Object.defineProperty(getter, '0', {enumerable: true, get() {getterCalls++; return B.Ref('U32');}}); malformedArrays.push(getter);
malformedArrays.push(new Array(1));
const prototype: any = [B.Ref('U32')]; Object.setPrototypeOf(prototype, null); malformedArrays.push(prototype);
for (const args of malformedArrays) {
  assert.throws(() => new IdentityTermLower().lower(B.Ctr('C', args)), /term array/);
  if (captureDef.$ === 'Def') {
    captureDef.e = {$: 'Ctr', k: '../../sdk/sha256-reference.Digest256', x: args};
    assert.throws(() => checkedRuntimeIdentity(captureBook, [root]), /term array/);
  }
}
assert.equal(getterCalls, 0, 'array accessors must never execute');
// All higher-order declaration fields must preserve free/bound distinctions.
for (const field of ['v', 'T'] as const) {
  const book = await load(), def = book.tlds[root];
  assert.equal(def.$, 'Def');
  if (def.$ === 'Def') {
    def[field] = freeMemo;
    const free = checkedRuntimeIdentity(book, [root]).sha256;
    def[field] = boundMemo;
    assert.notEqual(checkedRuntimeIdentity(book, [root]).sha256, free, `declaration ${field} capture`);
  }
}
for (const registered of [false, true]) {
  const book = await load();
  const adt = Object.values(book.tlds).find(d => d.$ === 'ADT' && d.c.some(c => c.k === constructor));
  assert(adt && adt.$ === 'ADT');
  const original = adt.c.find(c => c.k === constructor)!;
  adt.c = adt.c.map(c => ({...c}));
  book.ctrs[constructor] = {...original};
  const target = registered ? book.ctrs[constructor] : adt.c.find(c => c.k === constructor)!;
  target.T = freeMemo;
  const free = checkedRuntimeIdentity(book, [root]).sha256;
  target.T = boundMemo;
  assert.notEqual(checkedRuntimeIdentity(book, [root]).sha256, free, `constructor capture registered=${registered}`);
}
let declarationGetterCalls = 0;
for (const location of ['definition', 'constructors', 'registry'] as const) {
  const book = await load();
  const adt = Object.values(book.tlds).find(d => d.$ === 'ADT')!;
  const target = location === 'definition' ? book.tlds[root] : location === 'registry' ? book.ctrs[constructor] : adt;
  const key = location === 'constructors' ? 'c' : 'T';
  Object.defineProperty(target, key, {enumerable: true, get() {declarationGetterCalls++; return null;}});
  assert.throws(() => checkedRuntimeIdentity(book, [root]), /accessor or hidden declaration/);
}
assert.equal(declarationGetterCalls, 0, 'declaration accessors never execute');
{
  const book = await load();
  const adt = Object.values(book.tlds).find(d => d.$ === 'ADT')!;
  assert(adt.$ === 'ADT');
  (adt.c as any).map = () => [];
  assert.throws(() => checkedRuntimeIdentity(book, [root]), /term array/);
}
// Malformed scalar fields must reject before JavaScript coercion hooks run.
let scalarCoercions = 0;
const maliciousScalar = {toString() {scalarCoercions++; return constructor;}, valueOf() {scalarCoercions++; return 1;}};
for (const location of ['constructor-name', 'constructor-arity', 'registry-name', 'registry-arity', 'definition-arity', 'template-arity'] as const) {
  const book = await load();
  const adt = Object.values(book.tlds).find(d => d.$ === 'ADT' && d.c.some(c => c.k === constructor));
  assert(adt && adt.$ === 'ADT');
  if (location.startsWith('constructor')) (adt.c[0] as any)[location.endsWith('name') ? 'k' : 'n'] = maliciousScalar;
  else if (location.startsWith('registry')) (book.ctrs[constructor] as any)[location.endsWith('name') ? 'k' : 'n'] = maliciousScalar;
  else {
    const name = location === 'template-arity' ? '../../sdk/buffer.pick' : root;
    assert.equal(book.tlds[name].$, 'Def');
    (book.tlds[name] as any)[location === 'template-arity' ? 'x' : 'n'] = maliciousScalar;
  }
  assert.throws(() => checkedRuntimeIdentity(book, [root]), /invalid (constructor name|declaration arity)/);
}
assert.equal(scalarCoercions, 0, 'declaration scalar coercion hooks never execute');
const lowering=new IdentityTermLower();
for(const name of Object.keys(baseline.definitions)) {
  const declaration=originalBook.tlds[name];
  assert.deepEqual(lowering.lower(declaration.T),B.term_lower(declaration.T),`pinned type lowering ${name}`);
  if(declaration.$==='Def' && declaration.v) assert.deepEqual(lowering.lower(declaration.v),B.term_lower(declaration.v),`pinned body lowering ${name}`);
}
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({baseline, mutations, rejected: cases,
  scope: 'checked runtime graph identity only; no specialization authorization'}, null, 2) + '\n');
console.log(`Checked runtime identity: ${Object.keys(baseline.definitions).length} definitions, ${mutations.length} checked source mutations, ${cases.length} refusals; ${dir}/report.json`);
