import fs from 'node:fs';
import assert from 'node:assert/strict';
import {buildProgram} from '../scripts/program.ts';
import {checkedBook} from '../compiler/backend.ts';
import {collectionStorageCodec} from '../sdk/collection-storage.ts';

export async function testQueue() {
  await buildProgram('examples/queue/PROOF.bend','queue.process','build/queue','examples/queue/storage.json');
  const schema=JSON.parse(fs.readFileSync('build/queue.schema.json','utf8'));
  const layout=JSON.parse(fs.readFileSync('build/queue.interface.json','utf8'));
  const client=collectionStorageCodec(schema,layout);
  assert.equal(layout.effects,'token-v2');assert.equal(layout.collection.windowCapacity,2);
  assert.equal(client.allocationBytes(256),11064);
  const settle=client.instruction({constructor:'queue.Settle',fields:{count:2,fuel:2}});
  assert.deepEqual([...settle.slice(0,10)],[1,3,2,0,0,0,2,0,0,0]);assert.equal(settle.length,68);
  const source=fs.readFileSync('examples/queue/queue.bend','utf8');
  for(const [name,start,before,after] of [
    ['terminal','def process(', '    case Closed{}:\n      Rejected{2}', '    case Closed{}:\n      Rejected{1}'],
    ['authorization','def authorized(', '      Rejected{1}', '      Rejected{2}'],
    ['conservation','def finish_page(', '      Rejected{6}', '      Accepted{state, window, length, effects}'],
    ['arithmetic failure','def deduct(', '      M.Err{code}', '      M.Ok{M.zero()}'],
  ]) {
    const dir=fs.mkdtempSync('build/queue-negative-');
    try {
      const index=source.indexOf(start);assert(index>=0);const tail=source.slice(index);assert(tail.includes(before));
      fs.writeFileSync(`${dir}/queue.bend`,source.slice(0,index)+tail.replace(before,after));
      for(const file of ['PROOF.bend','LAWS.bend'])fs.copyFileSync(`examples/queue/${file}`,`${dir}/${file}`);
      await assert.rejects(()=>checkedBook(`${dir}/PROOF.bend`),undefined,name);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  }
  console.log('Queue checked laws, four law mutations and generated client passed');
}
if(import.meta.main)await testQueue();
