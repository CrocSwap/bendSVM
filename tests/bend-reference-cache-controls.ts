// Controls for tests/bend-reference-cache.ts: any input change misses, a
// tampered entry is caught by verify mode, and off mode never reads or writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { referenceCache } from './bend-reference-cache.ts';

export function testBendReferenceCacheControls() {
  const dir = fs.mkdtempSync(path.resolve('build/bend-reference-cache-controls-'));
  try {
    const source = path.join(dir, 'source.bend');
    fs.writeFileSync(source, 'def f(x: U32) -> U32:\n  x\n');
    const schema = { types: ['U32'] };
    let evaluations = 0;
    const evaluate = (value: number) => () => { evaluations++; return Uint8Array.of(value); };
    const previous = process.env.BEND_REFERENCE_CACHE;
    const withMode = <T>(mode: string | undefined, run: () => T): T => {
      if (mode === undefined) delete process.env.BEND_REFERENCE_CACHE; else process.env.BEND_REFERENCE_CACHE = mode;
      try { return run(); } finally {
        if (previous === undefined) delete process.env.BEND_REFERENCE_CACHE; else process.env.BEND_REFERENCE_CACHE = previous;
      }
    };
    // Miss, then hit.
    withMode(undefined, () => referenceCache([source], schema).result({ name: 'f', args: [1] }, evaluate(7)));
    const hit = withMode(undefined, () => referenceCache([source], schema).result({ name: 'f', args: [1] }, evaluate(9)));
    assert.deepEqual([...hit], [7]);
    assert.equal(evaluations, 1, 'Second identical lookup must be served from the cache');
    // Each input change misses: case arguments, schema, source bytes.
    for (const [label, files, otherSchema, caseKey] of [
      ['case', [source], schema, { name: 'f', args: [2] }],
      ['schema', [source], { types: ['U64'] }, { name: 'f', args: [1] }],
    ] as const) {
      const before = evaluations;
      withMode(undefined, () => referenceCache([...files], otherSchema).result(caseKey, evaluate(1)));
      assert.equal(evaluations, before + 1, `${label} change must miss`);
    }
    const original = fs.readFileSync(source);
    fs.appendFileSync(source, '# changed\n');
    const beforeSource = evaluations;
    withMode(undefined, () => referenceCache([source], schema).result({ name: 'f', args: [1] }, evaluate(7)));
    assert.equal(evaluations, beforeSource + 1, 'Source change must miss');
    fs.writeFileSync(source, original);
    // Tamper with the stored entry: verify mode must detect it.
    const cache = withMode(undefined, () => referenceCache([source], schema));
    const contextFiles = fs.readdirSync(path.resolve('build/.bend-reference-cache'), { recursive: true }) as string[];
    const entry = contextFiles.map(file => path.resolve('build/.bend-reference-cache', file))
      .filter(file => file.endsWith('.json'))
      .find(file => JSON.parse(fs.readFileSync(file, 'utf8')).context === cache.stats.context &&
        JSON.parse(fs.readFileSync(file, 'utf8')).result[0] === 7);
    assert(entry, 'Expected the stored entry');
    const stored = JSON.parse(fs.readFileSync(entry, 'utf8'));
    fs.writeFileSync(entry, JSON.stringify({ ...stored, result: [8] }));
    assert.throws(() => withMode('verify', () => referenceCache([source], schema).result({ name: 'f', args: [1] }, evaluate(7))),
      /differs from a fresh evaluation/);
    // A corrupt entry is ignored, re-evaluated and rewritten.
    fs.writeFileSync(entry, '{not json');
    const before = evaluations;
    const repaired = withMode(undefined, () => referenceCache([source], schema).result({ name: 'f', args: [1] }, evaluate(7)));
    assert.deepEqual([...repaired], [7]);
    assert.equal(evaluations, before + 1);
    // Off mode evaluates and leaves the store unchanged.
    const snapshot = fs.readFileSync(entry);
    withMode('off', () => referenceCache([source], schema).result({ name: 'f', args: [1] }, evaluate(5)));
    assert.deepEqual(fs.readFileSync(entry), snapshot);
    assert.throws(() => withMode('bogus', () => referenceCache([source], schema)), /Unknown BEND_REFERENCE_CACHE/);
    console.log('Bend reference cache controls: hit, case/schema/source misses, tamper, corruption and off mode passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) testBendReferenceCacheControls();
