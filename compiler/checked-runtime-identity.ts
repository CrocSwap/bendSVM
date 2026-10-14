import crypto from 'node:crypto';
import * as B from '../.deps/bend/bend2/bend.ts';
import {IdentityTermLower, identityArray} from './identity-terms.ts';

export type CheckedRuntimeIdentity = {
  version: 1;
  roots: string[];
  sha256: string;
  definitions: Record<string, string>;
  unresolvedSourceReferences: string[];
  memoValues: number;
};

const termKinds = new Set(['Var', 'Ref', 'Sub', 'Let', 'Typ', 'Qnt', 'Qua', 'Min',
  'All', 'Lam', 'App', 'ADT', 'Ctr', 'Mat', 'Efq', 'Eql', 'Rfl', 'Rwt', 'Hol', 'Ann']);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const digest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reject = (message: string): never => { throw new Error(`Checked runtime identity: ${message}`); };

// Inspect descriptors before reading declaration fields. Arbitrary proxies are
// outside the supported checked-book input, as are non-parametric closures.
function dataRecord(value: unknown): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('invalid declaration record');
  if (Object.getOwnPropertySymbols(value).length) reject('symbol declaration property');
  for (const d of Object.values(Object.getOwnPropertyDescriptors(value)))
    if (!Object.hasOwn(d, 'value') || !d.enumerable) reject('accessor or hidden declaration property');
}

function arity(value: unknown): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    reject('invalid declaration arity');
}
function constructorRecord(value: unknown): void {
  dataRecord(value);
  if (typeof value.k !== 'string' || !value.k) reject('invalid constructor name');
  arity(value.n);
}

// This identifies a checked runtime graph; it is NOT a proof-gate capability.
// Callers must obtain the book from checkedProgram, pin checker/lowering inputs,
// and prevent mutation between identification and use. No special lowering is
// enabled here. Names remain exact: aliases are not erased by suffix matching.
export function checkedRuntimeIdentity(book: B.Book, roots: readonly string[], canonicalName: (name: string) => string = name => name): CheckedRuntimeIdentity {
  dataRecord(book);
  dataRecord(book.tlds);
  dataRecord(book.ctrs);
  identityArray(roots);
  for (const declaration of Object.values(book.tlds)) {
    dataRecord(declaration);
    if (declaration.$ === 'Def' || declaration.$ === 'ADT') arity(declaration.n);
    if (declaration.$ === 'Def') arity(declaration.x);
    if (declaration.$ === 'ADT') {
      for (const constructor of identityArray(declaration.c)) constructorRecord(constructor);
    }
  }
  for (const constructor of Object.values(book.ctrs)) constructorRecord(constructor);
  if (book.hols || book.open) reject('unresolved holes or open laws');
  if (!roots.length || roots.some(name => typeof name !== 'string' || !name)) reject('missing root');
  if (new Set(roots).size !== roots.length) reject('duplicate root');
  // The caller supplies naming only, never authorization. Validate injection
  // across every observed name, including unresolved erased placeholders.
  const normalizedOwners = new Map<string, string>();
  const normalizedNames = new Map<string, string>();
  const normalize = (raw: string): string => {
    if (typeof raw !== 'string' || !raw) reject('invalid raw name');
    const cached = normalizedNames.get(raw);
    if (cached !== undefined) return cached;
    const name = canonicalName(raw);
    if (typeof name !== 'string' || !name) reject('invalid canonical name');
    const prior = normalizedOwners.get(name);
    if (prior !== undefined && prior !== raw) reject('canonical name collision');
    normalizedOwners.set(name, raw);
    normalizedNames.set(raw, name);
    return name;
  };
  for (const name of new Set([...Object.keys(book.tlds), ...Object.keys(book.ctrs)])) normalize(name);
  const orderedRoots = [...roots];
  for (const root of orderedRoots) {
    const declaration = Object.hasOwn(book.tlds, root) ? book.tlds[root] : undefined;
    if (!declaration || declaration.$ !== 'Def' || declaration.x || !declaration.e) reject(`invalid runtime root ${root}`);
  }
  const lowerer = new IdentityTermLower();
  const lower = (value: unknown) => lowerer.lower(value);
  const pending = orderedRoots.map(name => ({name, sourceOnly: false, placeholder: false}));
  const visited = new Map<string, boolean>();
  const unresolvedSourceReferences = new Set<string>();
  const definitions: Record<string, string> = Object.create(null);
  const owners = new Map<string, string>();
  for (const [name, declaration] of Object.entries(book.tlds)) {
    if (declaration.$ !== 'ADT') continue;
    for (const constructor of declaration.c) {
      if (owners.has(constructor.k)) reject(`duplicate constructor ${constructor.k}`);
      owners.set(constructor.k, name);
    }
  }
  let objects = 0, memoValues = 0;
  const active = new Set<object>();
  const cache = new WeakMap<object, Map<string, unknown>>();
  const placeholders = new Map<string, Set<string>>();

  // Tagged values distinguish absent fields from null and ordinary objects.
  // Unknown executable JS values reject instead of disappearing in JSON.
  function encode(value: unknown, depth = 0, sourceOnly = false, template = ''): unknown {
    if (depth > 512) reject('term depth limit');
    if (value === undefined) return ['undefined'];
    if (value === null) return ['null'];
    if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) reject('non-finite number');
      return ['number', Object.is(value, -0) ? '-0' : value];
    }
    if (typeof value !== 'object') return reject(`unsupported ${typeof value} value`);
    if (active.has(value)) reject('cyclic term object');
    const cacheKey = `${sourceOnly}:${template}`;
    const previous = cache.get(value)?.get(cacheKey);
    if (previous) return previous;
    if (++objects > 1_000_000) reject('term object limit');
    active.add(value);
    try {
      const remember = (node: unknown) => {
        const result = ['node', digest(node)];
        let entries = cache.get(value); if (!entries) {entries = new Map(); cache.set(value, entries);}
        entries.set(cacheKey, result); return result;
      };
      if (Array.isArray(value)) return remember(['array', identityArray(value).map(item => encode(item, depth + 1, sourceOnly, template))]);
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) reject('non-plain term object');
      if (Object.getOwnPropertySymbols(value).length) reject('symbol property');
      const node = value as Record<string, unknown>;
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (descriptor.get || descriptor.set || !descriptor.enumerable) reject('accessor or hidden property');
      }
      if (node.$ === 'Hol') reject('hole in runtime graph');
      if (['Ref', 'ADT', 'Ctr', 'Mat'].includes(node.$ as string)) {
        if (typeof node.k !== 'string') reject('unnamed dependency');
        // Constructor occurrences bind the owning datatype and its full ordered
        // constructor telescope. Ordinary references bind the declaration itself.
        const name = node.k as string;
        pending.push({name: node.$ === 'Ctr' || node.$ === 'Mat' ? owners.get(name) ?? name : name, sourceOnly,
          placeholder: node.$ === 'Ref' && sourceOnly && !!placeholders.get(template)?.has(name)});
      }
      return remember(['object', Object.keys(node).sort(compare).flatMap(key => {
        if (key === 's' && termKinds.has(node.$ as string)) return [];
        let child = node[key];
        if (key === 'k' && ['Ref', 'ADT', 'Ctr', 'Mat'].includes(node.$ as string))
          child = normalize(child as string);
        if (key === 'r' && node.$ === 'ADT')
          child = identityArray(child).map(name => normalize(name));
        if (node.$ === 'Var' && key === 'v' && child !== undefined) {
          // Backend.type consumes higher-order memo values. Lower them through
          // the pinned checker rather than omitting their JS closures.
          memoValues++;
          child = lowerer.lowerOpen(child);
        }
        return [[key, encode(child, depth + 1, sourceOnly, template)]];
      })]);
    } finally { active.delete(value); }
  }

  while (pending.length) {
    const {name, sourceOnly, placeholder} = pending.pop()!;
    const declaration = Object.hasOwn(book.tlds, name) ? book.tlds[name] : undefined;
    if (!declaration) {
      if (!placeholder) reject(`unresolved dependency ${name}`);
      // Only an own erased binder in a source-reachable template's checked e
      // may be absent. Its original v, types and other checked bodies get no exemption.
      unresolvedSourceReferences.add(name);
      continue;
    }
    if (visited.has(name) && (visited.get(name) === false || sourceOnly)) continue;
    if (!visited.has(name) && visited.size >= 4096) reject('definition count limit');
    visited.set(name, sourceOnly);
    if (declaration.$ === 'Def') {
      if (declaration.u || declaration.i) reject(`unsafe/foreign definition ${name}`);
      const type = lower(declaration.T);
      if (sourceOnly && declaration.x) {
        let cursor = type; const names = new Set<string>();
        for (let i = 0; i < declaration.x; i++) {
          if (cursor.$ !== 'All' || cursor.q.$ !== 'None') reject('invalid template binder');
          names.add(`${name}~${cursor.k}`); cursor = cursor.B;
        }
        placeholders.set(name, names);
      }
      const source = encode(declaration.v === null ? null : lowerer.lowerOpen(declaration.v), 0, true);
      const checked = encode(declaration.e ?? null, 0, sourceOnly, sourceOnly && declaration.x ? name : '');
      definitions[normalize(name)] = digest([encode({kind: 'Def', arity: declaration.n,
        templateArity: declaration.x, base: !!declaration.b,
        type: lowerer.lowerOpen(declaration.T)}, 0, sourceOnly), checked, source]);
    } else if (declaration.$ === 'ADT') {
      definitions[normalize(name)] = digest(encode({kind: 'ADT', arity: declaration.n,
        grade: declaration.g, base: !!declaration.b, type: lowerer.lowerOpen(declaration.T),
        constructors: declaration.c.map(c => {
          const registered = Object.hasOwn(book.ctrs, c.k) ? book.ctrs[c.k] : undefined;
          if (!registered) reject(`unregistered constructor ${c.k}`);
          return {name: normalize(c.k), arity: c.n, type: lowerer.lowerOpen(c.T),
            registered: {name: normalize(registered.k), arity: registered.n, type: lowerer.lowerOpen(registered.T)}};
        })}, 0, sourceOnly));
    } else reject(`unsupported declaration ${name}`);
  }
  const ordered = Object.fromEntries(Object.entries(definitions).sort(([a], [b]) => compare(a, b)));
  const unresolved = [...unresolvedSourceReferences].map(normalize).sort(compare);
  const normalizedRoots = orderedRoots.map(normalize);
  return {version: 1, roots: normalizedRoots,
    sha256: digest({version: 1, roots: normalizedRoots, definitions: ordered, unresolvedSourceReferences: unresolved}),
    definitions: ordered, unresolvedSourceReferences: unresolved, memoValues};
}
