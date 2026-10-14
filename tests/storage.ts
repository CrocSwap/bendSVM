import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { emitStorage } from '../compiler/storage.ts';
import { compileSbf } from '../scripts/build.ts';
import { storageCodec } from '../sdk/storage.ts';
import { wireCodec } from '../sdk/wire.ts';

export async function testStorage() {
  const emitted = new Backend(await checkedBook('tests/storage.bend')).emit(['process']);
  const storage = emitStorage(emitted.schema, 'process');
  const bounded = structuredClone(emitted.schema);
  const u32 = bounded.types.find(t => t.name === 'U32');
  if (!u32 || u32.kind !== 'u32') throw new Error('Expected U32 schema');
  u32.max = 64;
  assert.notDeepEqual(emitStorage(bounded, 'process').interface.header, storage.interface.header,
    'Changing a reachable scalar bound must change the state header');
  writeArtifacts('build/storage', emitted, 'process');
  const client = storageCodec(emitted.schema, storage.interface);
  assert.deepEqual([...client.instruction({ constructor: 'Initialize', fields: { value: 42 } }, 'initialize')], [0,0,42,0,0,0]);
  assert.deepEqual([...client.instruction({ constructor: 'Set', fields: { value: 42 } })], [1,1,42,0,0,0]);
  const empty = wireCodec(emitted.schema).encode('State', { constructor: 'Empty', fields: {} });
  const account = new Uint8Array([...storage.interface.header, ...empty]);
  assert.equal((client.account(account) as {constructor: string}).constructor, 'Empty');
  assert.deepEqual(client.reply(empty), client.account(account));
  assert.throws(() => client.account(account.subarray(1)), /header\/size/);
  account[4] ^= 1;
  assert.throws(() => client.account(account), /header\/size/);
  assert.throws(() => storageCodec(emitted.schema, {...storage.interface, stateBytes: 0}), /Invalid storage interface/);
  assert.throws(() => emitStorage(emitted.schema, 'missing'), /Storage root/);
  const bad = structuredClone(emitted.schema);
  bad.exports[0].args.reverse();
  assert.throws(() => emitStorage(bad, 'process'), /storage record/);
  const file = 'tests/.storage-negative.bend';
  try {
    const source = fs.readFileSync('tests/storage.bend', 'utf8');
    fs.writeFileSync(file, source.replace('Rejected{1}', 'Accepted{Stored{owner, value, slot}}'));
    await assert.rejects(() => checkedBook(file), /expected|mismatch/i);
  } finally { fs.rmSync(file, { force: true }); }
  compileSbf('build/storage.c', 'build/storage');
  console.log('Shared storage adapter generated and compiled to SBF');
}
