import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Backend, checkedProgram} from '../compiler/backend.ts';
import {checkedRuntimeIdentity} from '../compiler/checked-runtime-identity.ts';
import * as B from '../.deps/bend/bend2/bend.ts';

type Baseline = {
  app: string;
  source: string;
  roots: string[];
  inputFiles: {path: string; sha256: string}[];
  identitySha256: string;
  cSha256: string;
  emissionSha256: string;
  renderingEmissionSha256: string;
};
const fixture = JSON.parse(readFileSync('tests/type-evaluation/application-baselines.json', 'utf8')) as {
  provenance: {tools: {bun: string; typescript: string; bendCommit: string; baselineCommit: string}};
  programs: Baseline[];
};
const currentRoot = path.resolve(process.env.TYPE_EVALUATION_SOURCE_ROOT ?? '.');
let inputRoot = currentRoot;
const changedApps = new Set<string>();
const bendRoot = realpathSync('.deps/bend');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stable = (value: any): any => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const relativeInput = (file: string): string => {
  const absolute = path.resolve(file);
  const bendRelative = path.relative(bendRoot, absolute);
  if (bendRelative !== '..' && !bendRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(bendRelative)) {
    return `@bend/${bendRelative.split(path.sep).join('/')}`;
  }
  const sourceRelative = path.relative(inputRoot, absolute);
  assert.notEqual(sourceRelative, '..', `unexpected source outside pinned roots: ${file}`);
  assert.ok(!sourceRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(sourceRelative),
    `unexpected source outside pinned roots: ${file}`);
  return sourceRelative.split(path.sep).join('/');
};

assert.equal(Bun.version, fixture.provenance.tools.bun, 'Bun version differs from emission fixture');
assert.equal(JSON.parse(readFileSync('node_modules/typescript/package.json', 'utf8')).version,
  fixture.provenance.tools.typescript, 'TypeScript version differs from emission fixture');
assert.equal(execFileSync('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  fixture.provenance.tools.bendCommit, 'Bend checkout differs from emission fixture');
assert.equal(execFileSync('git', ['-C', '.deps/bend', 'status', '--porcelain'], {encoding: 'utf8'}).trim(), '',
  'Bend dependency must remain clean');

// Preserve historical output pins when an SDK algorithm intentionally changes.
// Every substituted byte must still match the original fixture's input hash.
// Explicit external source roots remain strict: no automatic substitution.
if (!process.env.TYPE_EVALUATION_SOURCE_ROOT) {
  const archive: Record<string,string> = {'sdk/sqrt.bend':'tests/type-evaluation/historical/sqrt.bend','sdk/wide.bend':'tests/type-evaluation/historical/wide.bend'};
  const inputs = new Map<string,string>();
  for (const baseline of fixture.programs) for (const file of baseline.inputFiles) {
    if (file.path.startsWith('@bend/')) continue;
    if (inputs.has(file.path)) assert.equal(inputs.get(file.path),file.sha256,'conflicting historical input');
    inputs.set(file.path,file.sha256);
    if (hash(readFileSync(path.join(currentRoot,file.path))) !== file.sha256) changedApps.add(baseline.app);
  }
  if (changedApps.size) {
    mkdirSync('build',{recursive:true});
    inputRoot=path.resolve(mkdtempSync('build/type-evaluation-historical-'));
    for (const [file,expected] of inputs) {
      let bytes=readFileSync(path.join(currentRoot,file));
      if (hash(bytes)!==expected) {
        assert.ok(archive[file],`unapproved historical input change: ${file}`);
        bytes=readFileSync(archive[file]);
      }
      assert.equal(hash(bytes),expected,`historical source bytes differ: ${file}`);
      const target=path.join(inputRoot,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,bytes);
    }
  }
}

type MemoState = {i: number; v: unknown};
type MemoSnapshot = Map<object, MemoState>;
function snapshotMemoCells(book: B.Book): {cells: MemoSnapshot; openedClosures: number} {
  const cells: MemoSnapshot = new Map();
  const seen = new WeakSet<object>();
  const opened = new WeakSet<Function>();
  let fresh = 0;
  let openedClosures = 0;
  function visit(value: any, depth = 0): void {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
    seen.add(value);
    if (typeof value === 'function') {
      if (opened.has(value) || depth >= 400) return;
      opened.add(value);
      openedClosures++;
      const source = value.toString().replace(/\s+/g, ' ');
      const args = source.startsWith('(xs)')
        ? [Array.from({length: 8}, () => B.Var(`#memo-snapshot-${fresh++}`, 100_000 + fresh))]
        : [B.Var(`#memo-snapshot-${fresh++}`, 100_000 + fresh)];
      try { visit(value(...args), depth + 1); } catch { /* Some binders are intentionally partial. */ }
      return;
    }
    if (value.$ === 'Var' && value.i < 0) cells.set(value, {i: value.i, v: value.v});
    for (const key of Object.keys(value)) if (key !== 's') visit(value[key], depth + 1);
  }
  for (const name of Object.keys(book.tlds)) visit(book.tlds[name]);
  for (const name of Object.keys(book.ctrs)) visit(book.ctrs[name]);
  return {cells, openedClosures};
}
function assertSameSnapshot(before: MemoSnapshot, after: MemoSnapshot, label: string): void {
  assert.equal(after.size, before.size, `${label}: memo-cell set size changed`);
  for (const [cell, state] of before) {
    const actual = after.get(cell);
    assert.ok(actual, `${label}: memo cell disappeared or changed identity`);
    assert.equal(actual.i, state.i, `${label}: memo-cell index changed`);
    assert.strictEqual(actual.v, state.v, `${label}: memo-cell value identity changed`);
  }
}

function emitPreservingMemo(book: B.Book, roots: string[], label: string) {
  const identityBefore=checkedRuntimeIdentity(book,roots).sha256;
  const before = snapshotMemoCells(book);
  const stableScan = snapshotMemoCells(book);
  assertSameSnapshot(before.cells, stableScan.cells, `${label} repeated memo-cell snapshot`);
  assert.equal(stableScan.openedClosures, before.openedClosures, `${label} closure snapshot coverage changed`);
  assert.equal(checkedRuntimeIdentity(book, roots).sha256, identityBefore,
    `${label} identity changed during memo-cell snapshot`);

  const emission = new Backend(book).emit(roots);
  const after = snapshotMemoCells(book);
  assertSameSnapshot(before.cells, after.cells, `${label} emission`);
  assert.equal(after.openedClosures, before.openedClosures, `${label} closure snapshot coverage changed during emission`);
  assert.equal(checkedRuntimeIdentity(book, roots).sha256, identityBefore,
    `${label} identity changed during emission`);

  return emission;
}

for (const baseline of fixture.programs) {
  const sourceFile = path.join(inputRoot, baseline.source);
  const {book, files} = await checkedProgram(sourceFile);
  const actualInputs = files.map((file) => ({path: relativeInput(file), sha256: hash(readFileSync(file))}))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(actualInputs, baseline.inputFiles, `${baseline.app} source inputs differ from pinned provenance`);

  const identityBefore = checkedRuntimeIdentity(book, baseline.roots).sha256;
  assert.equal(identityBefore, baseline.identitySha256, `${baseline.app} checked runtime identity changed`);
  const emission=emitPreservingMemo(book,baseline.roots,baseline.app);
  assert.equal(hash(emission.c), baseline.cSha256, `${baseline.app} C emission hash changed`);
  const historicalEmission = structuredClone(emission);
  delete (historicalEmission.taggedSumLowering as any).rendered;
  assert.equal(hash(JSON.stringify(stable(historicalEmission))), baseline.emissionSha256,
    `${baseline.app} historical emission changed beyond renderer evidence`);
  assert.equal(hash(JSON.stringify(stable(emission))), baseline.renderingEmissionSha256,
    `${baseline.app} complete emission with renderer evidence changed`);
  console.log(`${baseline.app}: historical input, identity and emission pins preserved`);
}

for (const baseline of fixture.programs.filter(b=>changedApps.has(b.app))) {
  const {book}=await checkedProgram(path.join(currentRoot,baseline.source));
  emitPreservingMemo(book,baseline.roots,baseline.app+' current source');
  console.log(`${baseline.app}: current source identity and memo cells preserved during emission`);
}

console.log('Emission evidence scope: SHA-256 reference plus vault, vesting, exchange, AMM, batch and queue; finite source/hash comparison only');
