import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { emitEffects } from '../compiler/effects.ts';
import { buildProgram } from '../scripts/program.ts';

export async function testTokenThree() {
  const schema = new Backend(await checkedBook('tests/token-three.bend')).emit(['process']).schema;
  const name = '../sdk/effects3.Effects';
  assert.match(emitEffects(schema, name), /out\[2\]/);
  for (const change of ['missing', 'extra', 'renamed', 'different-type']) {
    const altered = structuredClone(schema);
    const record = altered.types.find(t => t.name === name)!;
    assert(record.kind === 'adt');
    const fields = record.variants[0].fields;
    if (change === 'missing') fields.splice(1);
    if (change === 'extra') fields.push({ ...fields[0], name: 'fourth' });
    if (change === 'renamed') fields[2].name = 'other';
    if (change === 'different-type') fields[2].type = 'U32';
    assert.throws(() => emitEffects(altered, name), /effect fields|types differ/);
  }
  const manifest = await buildProgram('tests/token-three.bend', 'process', 'build/token-three');
  const layout = JSON.parse(fs.readFileSync('build/token-three.interface.json', 'utf8'));
  assert.equal(layout.effectSlots, 3);
  const directory = fs.mkdtempSync('build/token-three-reproduce-');
  try {
    assert.deepEqual(await buildProgram('tests/token-three.bend', 'process', `${directory}/token-three`), manifest);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const multi = await buildProgram('tests/token-three-multi.bend', 'process', 'build/token-three-multi', 'tests/token-three-multi.layout.json');
  const multiDirectory = fs.mkdtempSync('build/token-three-multi-reproduce-');
  try {
    assert.deepEqual(await buildProgram('tests/token-three-multi.bend', 'process', `${multiDirectory}/token-three-multi`, 'tests/token-three-multi.layout.json'), multi);
  } finally { fs.rmSync(multiDirectory, { recursive: true, force: true }); }
  console.log('Three-effect structure rejection and reproducible public build passed');
}

if (import.meta.main) await testTokenThree();
