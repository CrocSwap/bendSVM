import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { emitEffects } from '../compiler/effects.ts';
import { buildProgram } from '../scripts/program.ts';

export async function testTokenIssuance() {
  const schema = new Backend(await checkedBook('tests/token-issuance.bend')).emit(['process']).schema;
  const name = '../sdk/issuance.Effects';
  assert.match(emitEffects(schema, name), /out->active = 4/);
  for (const change of ['missing-burn', 'initialize-not-bool', 'amount-not-u64', 'recipient-not-recipient']) {
    const altered = structuredClone(schema);
    const effect = altered.types.find(t => t.name === '../sdk/issuance.Effect')!;
    assert(effect.kind === 'adt');
    const mint = effect.variants.find(v => v.name.endsWith('.Mint'))!;
    if (change === 'missing-burn') effect.variants.splice(effect.variants.findIndex(v => v.name.endsWith('.Burn')), 1);
    if (change === 'initialize-not-bool') mint.fields[5].type = 'U32';
    if (change === 'amount-not-u64') mint.fields[4].type = 'U32';
    if (change === 'recipient-not-recipient') mint.fields[3].type = 'U32';
    assert.throws(() => emitEffects(altered, name), /Invalid token effect|Invalid issuance effect/);
  }
  const manifest = await buildProgram('tests/token-issuance.bend', 'process', 'build/token-issuance');
  const layout = JSON.parse(fs.readFileSync('build/token-issuance.interface.json', 'utf8'));
  assert.equal(layout.effects, 'token-v2');
  assert.equal(layout.effectSlots, 3);
  const directory = fs.mkdtempSync('build/token-issuance-reproduce-');
  try {
    assert.deepEqual(await buildProgram('tests/token-issuance.bend', 'process', `${directory}/token-issuance`), manifest);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  console.log('Issuance structure rejection and reproducible public build passed');
}

if (import.meta.main) await testTokenIssuance();
