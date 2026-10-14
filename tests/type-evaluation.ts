import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Backend, checkedProgram} from '../compiler/backend.ts';
import {TargetDiagnostic} from '../compiler/diagnostics.ts';
import {isolatedTypeWhnf} from '../compiler/type-evaluation.ts';
import * as B from '../.deps/bend/bend2/bend.ts';

const inputRoot = path.resolve(process.env.TYPE_EVALUATION_SOURCE_ROOT ?? '.');
const source = (file: string) => path.join(inputRoot, file);
const baseBook = (await checkedProgram(source('tests/sha256-reference/PROOF.bend'))).book;
const stripSpans = (value: any): any => {
  if (Array.isArray(value)) return value.map(stripSpans);
  if (!value || typeof value !== 'object') return value;
  const result: any = {};
  for (const key of Object.keys(value)) if (key !== 's') result[key] = stripSpans(value[key]);
  return result;
};
const shape = (run: () => B.HTerm): string => JSON.stringify(stripSpans(B.term_lower(run())));
const redex = () => B.App(B.Lam('y', 0, (y: any) => y), B.Ref('U32'));

// Keep raw calls confined to the isolation wrapper. This catches a new direct
// evaluator call in any compiler source file, including added/symlinked files.
function compilerSources(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return compilerSources(file);
    if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.ts')) return [file];
    return [];
  });
}
const rawEvaluatorCall = /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)?term_(?:wnf|snf)\s*\(/;
for (const file of compilerSources(path.resolve('compiler'))) {
  if (path.resolve(file) === path.resolve('compiler/type-evaluation.ts')) continue;
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), rawEvaluatorCall,
    `${path.relative('.', file)} must use isolatedTypeWhnf`);
}
const wrapperSource = fs.readFileSync('compiler/type-evaluation.ts', 'utf8');
assert.deepEqual(wrapperSource.match(/\bB\.term_(?:wnf|snf)\s*\(/g), ['B.term_wnf('],
  'the wrapper must contain exactly one raw term_wnf call and no raw term_snf call');

// A small deterministic subset of the reviewer's differential generator. The
// seed is fixed so raw order dependence is reproducible and fast to run.
const PAIR = '../../sdk/buffer.Pair';
const higher = (term: B.LTerm) => B.term_higher(term);
const tlds: any = Object.assign(Object.create(null), baseBook.tlds);
tlds.idT = {$: 'Def', n: 1, x: 0, T: higher(B.Typ(B.Qua(B.Lone()))),
  v: higher(B.Lam('T', 0, B.Var('T', 0)))};
tlds.pairOf = {$: 'Def', n: 1, x: 0, T: higher(B.Typ(B.Qua(B.Lone()))),
  v: higher(B.Lam('T', 0, B.ADT(PAIR, [B.Var('T', 0)])))};
tlds.alias0 = {$: 'Def', n: 0, x: 0, T: higher(B.Typ(B.Qua(B.Lone()))),
  v: higher(B.ADT(PAIR, [B.Ref('U32')]))};
const probeBook = {...baseBook, tlds} as B.Book;
const SPAN = {src: 'type-evaluation-probe', beg: 0, end: 1} as any;

function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
}
function generated(seed: number) {
  const random = rng(seed);
  const cells: any[] = [];
  const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
  const gen = (depth: number, scope: number): any => {
    const choices = depth <= 0
      ? ['ref', 'var', 'cell', 'rawbeta']
      : ['ref', 'var', 'cell', 'beta', 'idT', 'pairOf', 'alias', 'adt', 'let', 'ann', 'mat', 'matdef', 'ctrbox', 'rawbeta'];
    switch (pick(choices)) {
      case 'ref': return B.Ref(pick(['U32', 'Bool']));
      case 'var': {
        if (!scope) return B.Ref('U32');
        const index = Math.floor(random() * scope);
        return B.Var(`v${index}`, index, random() < 0.5 ? SPAN : undefined);
      }
      case 'cell': {
        if (cells.length && random() < 0.6) return pick(cells);
        const cell = B.Var('_', -1, undefined, higher(gen(depth - 1, 0)));
        cells.push(cell);
        return cell;
      }
      case 'beta': return B.App(B.Lam('b', scope, gen(depth - 1, scope + 1)), gen(depth - 1, scope));
      case 'idT': return B.App(B.Ref('idT'), gen(depth - 1, scope));
      case 'pairOf': return B.App(B.Ref('pairOf'), gen(depth - 1, scope));
      case 'alias': return B.Ref('alias0');
      case 'adt': return B.ADT(PAIR, [gen(depth - 1, scope)]);
      case 'let': return B.Let(['l'], [scope], [gen(depth - 1, scope)], gen(depth - 1, scope + 1), undefined, [B.Many()]);
      case 'ann': return B.Ann(gen(depth - 1, scope), B.Typ(B.Qua(B.Lone())));
      case 'mat': return B.App(B.Mat('True', gen(depth - 1, scope), B.Lam('m', scope, gen(depth - 1, scope + 1))), B.Ctr(pick(['True', 'False']), []));
      case 'matdef': return B.App(B.Mat('Nope', gen(depth - 1, scope), B.Lam('m', scope, B.Var('m', scope, SPAN))), B.Ctr('MkBox', [gen(depth - 1, scope)]));
      case 'rawbeta': {
        const cell = B.Var('_', -1, undefined, B.App(B.Lam('y', 0, (y: any) => random() < 2 ? y : y), higher(gen(depth - 1, 0))));
        cells.push(cell);
        return cell;
      }
      case 'ctrbox': return B.Ctr('MkBox', [gen(depth - 1, scope)]);
    }
  };
  return {roots: [gen(4, 0), gen(4, 0)].map(higher), cells};
}
function cellSnapshot(cells: any[]) {
  return cells.map((cell) => ({cell, i: cell.i, v: cell.v}));
}
function assertCellsUnchanged(snapshot: ReturnType<typeof cellSnapshot>, label: string) {
  for (const before of snapshot) {
    assert.equal(before.cell.i, before.i, `${label}: memo cell index changed`);
    assert.strictEqual(before.cell.v, before.v, `${label}: memo cell value identity changed`);
  }
}
function outcome(run: () => B.HTerm): string {
  try { return `ok:${shape(run)}`; }
  catch (error) { return `error:${String(error)}`; }
}

for (const seed of [1, 37, 2307]) {
  for (const query of [0, 1]) {
    const raw = generated(seed);
    const isolated = generated(seed);
    const before = cellSnapshot(isolated.cells);
    assert.equal(outcome(() => B.term_wnf(probeBook, raw.roots[query])),
      outcome(() => isolatedTypeWhnf(probeBook, isolated.roots[query])),
      `single-query result differs for seed ${seed}, query ${query}`);
    assertCellsUnchanged(before, `seed ${seed}, query ${query}`);
  }
}

const ordered = generated(2307);
const orderedBefore = cellSnapshot(ordered.cells);
outcome(() => isolatedTypeWhnf(probeBook, ordered.roots[0]));
const isolatedAfterFirst = outcome(() => isolatedTypeWhnf(probeBook, ordered.roots[1]));
const fresh = generated(2307);
const isolatedFresh = outcome(() => isolatedTypeWhnf(probeBook, fresh.roots[1]));
assert.equal(isolatedAfterFirst, isolatedFresh, 'isolated query result depends on prior query order');
assertCellsUnchanged(orderedBefore, 'ordered isolated queries');

const rawOrdered = generated(2307);
const rawBefore = cellSnapshot(rawOrdered.cells);
outcome(() => B.term_wnf(probeBook, rawOrdered.roots[0]));
assert.ok(rawBefore.some(({cell, i}) => i === -1 && cell.i === -2),
  'raw term_wnf control must evaluate and mark a memo cell i=-2');
const rawAfterFirst = outcome(() => B.term_wnf(probeBook, rawOrdered.roots[1]));
const rawFresh = generated(2307);
const rawAlone = outcome(() => B.term_wnf(probeBook, rawFresh.roots[1]));
assert.notEqual(rawAfterFirst, rawAlone, 'raw term_wnf control must demonstrate query order dependence');

// Backend.type used to accept a shared Pair parameter only after the shared
// cell had been forced by an earlier query. The isolated path rejects it in
// every order and sharing arrangement.
function backendScenario(shared: boolean) {
  const cellA = B.Var('_', -1, undefined, redex());
  const cellB = shared ? cellA : B.Var('_', -1, undefined, redex());
  return {
    cellA,
    cellB,
    a: B.Var('memo', 0, undefined, cellA),
    b: B.Var('memo', 0, undefined, B.ADT(PAIR, [cellB])),
  };
}
const typeOutcome = (backend: any, term: B.HTerm) => {
  try { return {value: backend.type(term)}; }
  catch (error) { return {error: String(error)}; }
};
for (const shared of [true, false]) {
  for (const order of ['ab', 'ba', 'b']) {
    const scenario = backendScenario(shared);
    const before = cellSnapshot([scenario.cellA, scenario.cellB]);
    const backend = new Backend(probeBook) as any;
    const results: any = {};
    for (const query of order) results[query] = typeOutcome(backend, scenario[query as 'a' | 'b']);
    assert.ok(results.b.error?.includes('Unsupported runtime type: App'));
    assertCellsUnchanged(before, `Backend.type shared=${shared} order=${order}`);
  }
}

// L1: a span-driven term_higher copy inside a match arm must retain sharing
// with a memo cell nested in an engine-created constructor argument.
function splitGraph() {
  const scrutinee = B.Var('_', -1, undefined,
    higher(B.Ctr('MkBox', [B.App(B.Ref('idT'), B.Ctr('True', []))])));
  const continuation = B.Lam('b', 0,
    B.App(B.Mat('MkBox',
      B.Lam('f', 1, B.App(B.Mat('True', B.Var('b', 0), B.Lam('_', 2, B.Var('b', 0))), B.Var('f', 1))),
      B.Lam('_', 1, B.Var('b', 0))), scrutinee));
  const term = higher(B.App(B.App(B.Mat('Nope', B.Ref('U32'),
    B.Lam('m', 0, B.Lam('k', 1, B.App(B.Var('k', 1), B.Var('m', 0, SPAN))))), scrutinee), continuation));
  return {scrutinee, term};
}
const splitRaw = splitGraph();
const splitIsolated = splitGraph();
const splitBefore = cellSnapshot([splitIsolated.scrutinee]);
assert.equal(shape(() => B.term_wnf(probeBook, splitRaw.term)),
  shape(() => isolatedTypeWhnf(probeBook, splitIsolated.term)), 'nested constructor result split memo-cell sharing');
assertCellsUnchanged(splitBefore, 'nested constructor split');

// L2: an All closure returned from isolation must copy caller arguments when
// invoked later. Forcing its result cannot mutate the caller's cell.
const pair = (baseBook.tlds[PAIR] as B.ADT);
const returnedAll: any = isolatedTypeWhnf(baseBook, pair.c[0].T);
const callerCell = B.Var('_', -1, undefined, redex());
const callerBefore = cellSnapshot([callerCell]);
const returnedSpecialization: any = returnedAll.B(callerCell);
assert.notStrictEqual(returnedSpecialization.A, callerCell, 'returned closure retained an external argument cell');
B.term_wnf(baseBook, returnedSpecialization.A);
assertCellsUnchanged(callerBefore, 'returned closure argument');

// L3: registry lookup must include prototype-inherited declarations just as
// `book.tlds[name]` does in the pinned checker.
const inherited = Object.create(baseBook.tlds);
inherited.aliasProbe = {$: 'Def', n: 0, x: 0, T: B.Typ(B.Qua(B.Lone())), v: B.Ref('U32')};
const inheritedBook = {...baseBook, tlds: Object.create(inherited)} as B.Book;
assert.equal(shape(() => B.term_wnf(inheritedBook, B.Ref('aliasProbe'))),
  shape(() => isolatedTypeWhnf(inheritedBook, B.Ref('aliasProbe'))), 'inherited type declaration was not found');

// L4: term_wnf does not consume T/e/c. Deep values in those fields must not
// spend the isolation copy budget, while a deep consumed body must fail with a
// stable coded target diagnostic.
let deepMetadata: any = B.Rfl();
for (let i = 0; i < 700; i++) deepMetadata = B.App(deepMetadata, B.Rfl());
const metadataTlds: any = Object.create(baseBook.tlds);
metadataTlds.deepMetadata = {$: 'Def', n: 0, T: deepMetadata, e: deepMetadata, c: deepMetadata, v: B.Ref('U32')};
const metadataBook = {...baseBook, tlds: metadataTlds} as B.Book;
assert.equal((new Backend(metadataBook) as any).type(B.Var('memo', 0, undefined, B.Var('_', -1, undefined, B.Ref('deepMetadata')))), 'U32');

let deepBody: any = B.Rfl();
for (let i = 0; i < 520; i++) deepBody = B.App(deepBody, B.Rfl());
const limitedTlds: any = Object.create(baseBook.tlds);
limitedTlds.deepBody = {$: 'Def', n: 0, T: B.Typ(B.Qua(B.Lone())), v: deepBody};
const limitedBook = {...baseBook, tlds: limitedTlds} as B.Book;
assert.throws(() => isolatedTypeWhnf(limitedBook, B.Ref('deepBody')),
  (error: any) => error instanceof TargetDiagnostic && error.code === 'BEND-SBF100',
  'isolation bounds must produce a coded TargetDiagnostic');

console.log('Type evaluation isolation: raw order control, deterministic differential, L1–L4, and call-site gate passed');
