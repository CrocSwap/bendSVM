import fs from 'node:fs';
import assert from 'node:assert/strict';
import { checkedBook } from '../compiler/backend.ts';
import { buildProgram } from '../scripts/program.ts';
import { ammClient, type AmmAccounts } from '../examples/amm/client.ts';
import { assertReproducibleProgramBuilds, programBuildSnapshot } from './program-build-reproducibility.ts';

export async function testAmm() {
  const source = fs.readFileSync('examples/amm/amm.bend', 'utf8');
  for (const [before, after] of [
    ['Rejected{1}', 'dispatch(state, instruction)'],
    ['Rejected{2}', 'Rejected{3}'],
    ['Rejected{code}', 'Rejected{0}'],
  ]) {
    const directory = fs.mkdtempSync('examples/.amm-negative-');
    try {
      assert.equal(source.split(before).length, 2);
      for (const file of ['pricing.bend', 'LAWS.bend', 'PROOF.bend']) fs.copyFileSync(`examples/amm/${file}`, `${directory}/${file}`);
      fs.writeFileSync(`${directory}/amm.bend`, source.replace(before, after));
      await assert.rejects(() => checkedBook(`${directory}/PROOF.bend`), /expected|mismatch/i);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
  const manifest = await buildProgram('examples/amm/PROOF.bend', 'amm.process', 'build/amm');
  const directory = fs.mkdtempSync('build/amm-reproduce-');
  try {
    const reproduced = await buildProgram('examples/amm/PROOF.bend', 'amm.process', `${directory}/amm`);
    assertReproducibleProgramBuilds(programBuildSnapshot(manifest, 'build/amm'), programBuildSnapshot(reproduced, `${directory}/amm`));
  }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
  const schema = JSON.parse(fs.readFileSync('build/amm.schema.json', 'utf8'));
  const layout = JSON.parse(fs.readFileSync('build/amm.interface.json', 'utf8'));
  const client = ammClient(schema, layout);
  const names = ['state', 'actor', 'tokenProgram', 'custody', 'userBase', 'baseVault', 'baseMint', 'userQuote', 'quoteVault', 'quoteMint', 'userLp', 'lpMint'];
  const accounts = Object.fromEntries(names.map((name, index) => [name, new Uint8Array(32).fill(index + 1)])) as AmmAccounts;
  const initial = client.initialize(accounts, 10_000n, 40_000n, 19_000n);
  assert.equal(client.stateBytes, 216);
  assert.equal(initial.data.length, 195);
  assert.deepEqual([...initial.data.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual(initial.accounts.map(a => a.isSigner), [true, true, ...Array(10).fill(false)]);
  assert.deepEqual(initial.accounts.map(a => a.isWritable), [true, false, false, false, true, true, false, true, true, false, true, true]);
  const operations = [client.deposit(accounts, 100n, 100n, 400n), client.withdraw(accounts, 100n, 50n, 200n), client.swap(accounts, true, 1000n, 906n)];
  for (const [index, operation] of operations.entries()) {
    assert.deepEqual([...operation.data.slice(0, 2)], [1, index + 1]);
    assert.equal(operation.accounts[0].isSigner, false);
    assert(operation.accounts[1].isSigner);
  }
  for (const value of [-1n, 1n << 64n]) assert.throws(() => client.deposit(accounts, value, 0n, 0n), /unsigned 64-bit/);
  assert.throws(() => client.swap(accounts, 2 as any, 1n, 0n), /bool/);
  assert.throws(() => client.swap({ ...accounts, userBase: accounts.baseVault }, true, 1n, 0n), /distinct/);
  assert.throws(() => client.swap({ ...accounts, actor: new Uint8Array(31) }, true, 1n, 0n), /32 bytes/);
  // Client address arrays are copied, so later caller mutations cannot alter a prepared instruction.
  accounts.actor.fill(99);
  assert.equal(initial.accounts[1].address[0], 2);
  fs.writeFileSync('build/amm-client-vectors.json', JSON.stringify([initial, ...operations].map(ix => ({
    data: [...ix.data], accounts: ix.accounts.map(a => ({ ...a, address: [...a.address] })),
  })), null, 2) + '\n');
  console.log('AMM source-law mutations, client checks and byte-identical public build passed');
}
if (import.meta.main) await testAmm();
