import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { compileSbf } from '../scripts/build.ts';
import fs from 'node:fs';
import assert from 'node:assert/strict';

export async function testVault() {
  const emitted = new Backend(await checkedBook('examples/vault/PROOF.bend')).emit(['vault.process']);
  writeArtifacts('build/vault',emitted,'vault.process');
  compileSbf('build/vault.c','build/vault');
  const probe = new Backend(await checkedBook('tests/settlement.bend')).emit(['process']);
  writeArtifacts('build/settlement',probe,'process');
  compileSbf('build/settlement.c','build/settlement');
  const source = fs.readFileSync('examples/vault/vault.bend','utf8');
  for (const [before,after] of [
    ['Rejected{1}','result'],
    ['Rejected{4}','Rejected{0}'],
    ['Rejected{5}','Rejected{0}'],
    ['Bool.and(signed, Sol.equal(actor, owner))','True{}'],
  ]) {
    const dir = fs.mkdtempSync('examples/.vault-negative-');
    try {
      for (const name of ['LAWS.bend','PROOF.bend']) fs.copyFileSync(`examples/vault/${name}`,`${dir}/${name}`);
      assert.ok(source.includes(before));
      fs.writeFileSync(`${dir}/vault.bend`,source.replace(before,after));
      await assert.rejects(() => checkedBook(`${dir}/PROOF.bend`),/expected|mismatch/i);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  }
  console.log('Vault laws checked; shared storage/effects adapter compiled to SBF');
}
