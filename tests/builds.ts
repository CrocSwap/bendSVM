import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { buildProgram } from '../scripts/program.ts';
import { assertReproducibleProgramBuilds, programBuildSnapshot } from './program-build-reproducibility.ts';

export async function testBuilds() {
  const dir=fs.mkdtempSync('build/reproduce-');
  const results=[];
  try {
    for(const name of ['vault','vesting','exchange']) {
      const stem=`build/${name}`,source=`examples/${name}/PROOF.bend`,root=`${name}.process`;
      const prior=crypto.createHash('sha256').update(fs.readFileSync(stem+'.so')).digest('hex');
      const first=await buildProgram(source,root,stem);
      assert.equal(first.artifacts['.so'],prior,'Public build must match test build');
      assert.ok(Object.keys(first.inputs).includes(source));
      assert.ok(Object.keys(first.inputs).includes(`examples/${name}/LAWS.bend`));
      assert.ok(Object.keys(first.inputs).includes('sdk/effects.bend'));
      const second=await buildProgram(source,root,`${dir}/${name}`);
      assertReproducibleProgramBuilds(programBuildSnapshot(first,stem),programBuildSnapshot(second,`${dir}/${name}`),
        'Fresh output directory must reproduce every artifact and stable manifest identity');
      results.push({name,artifacts:first.artifacts,elfBytes:first.elfBytes});
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
  fs.writeFileSync('build/reproducibility.json',JSON.stringify(results,null,2)+'\n');
  console.log('All three public program builds reproduce test binaries and generated interfaces');
}
