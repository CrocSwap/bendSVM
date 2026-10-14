// Checked-Bend source experiment: explicit static Pair fold.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Backend,checkedBook} from '../compiler/backend.ts';
import {writeArtifacts} from '../compiler/artifacts.ts';
import {compileSbf,prepareBend} from './build.ts';

const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const variant='fold';
const source=`benchmarks/linear-${variant}.bend`;
const production=JSON.parse(fs.readFileSync('build/linear-benchmark.json','utf8'));
for(const [file,digest] of Object.entries(production.sourceHashes))
  assert.equal(hash(file),digest,`stale production source: ${file}`);
const before=Object.fromEntries(['build/linear-bend.so','build/linear-rust.so',
  'build/linear-benchmark.json','build/linear-vectors.json'].map(file=>[file,hash(file)]));
prepareBend();
const stem=`build/linear-${variant}-bend`;
const emitted=new Backend(await checkedBook(source)).emit(['linear']);
writeArtifacts(stem,emitted);
fs.writeFileSync(`${stem}-entry.c`,`#include "solana_min.h"
#include "linear-${variant}-bend.dispatch.h"
u64 entrypoint(const u8 *input) {
  if (read_le(input,8) != 0 || read_le(input+8,8) != 333) return 1;
  u8 output[14]; u64 written=0;
  if (!bend_wire_dispatch(input+16,333,output,sizeof(output),&written) || written!=14) return 2;
  sol_set_return_data(output,written); return 0;
}
`);
compileSbf(`${stem}-entry.c`,stem);
const elfHash=hash(`${stem}.so`);
compileSbf(`${stem}-entry.c`,stem);
assert.equal(hash(`${stem}.so`),elfHash,'fold ELF changed on rebuild');
const metrics=`build/linear-${variant}-raw.json`;
const env={...process.env,LINEAR_ELF:path.resolve(`${stem}.so`),
  LINEAR_METRICS:path.resolve(metrics),CARGO_TARGET_DIR:path.resolve('target/linear')};
for(let i=0;i<2;i++) {
  const result=spawnSync('cargo',['test','--locked','--test','linear_benchmark','--','--nocapture'],
    {stdio:'inherit',env});
  assert.ifError(result.error);assert.equal(result.status,0,'fold oracle mismatch');
  if(i===0)fs.copyFileSync(metrics,`${metrics}.first`);
  else assert.equal(fs.readFileSync(metrics,'utf8'),fs.readFileSync(`${metrics}.first`,'utf8'));
}
for(const [file,digest] of Object.entries(before)) assert.equal(hash(file),digest,
  `fold experiment changed production artifact: ${file}`);
const rows=JSON.parse(fs.readFileSync(metrics,'utf8'));
fs.writeFileSync(`build/linear-${variant}-report.json`,JSON.stringify({
  checkedBend:true,diagnosticOnly:true,repeatedIdentically:true,
  sourceHash:hash(source),
  scriptHash:hash('scripts/benchmark-linear-fold.ts'),
  elfHash,productionHashes:before,rows},null,2)+'\n');
console.log(rows);
