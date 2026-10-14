import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {wireCodec} from '../sdk/wire.ts';

// Concrete existential inputs only. Universal proof queries never use these pins.
const [input, output] = process.argv.slice(2);
assert(input && output, 'expected fixture input and fresh profile output');
const payload = JSON.parse(fs.readFileSync(input, 'utf8'));
const fields = (count:number, first:number) => Object.fromEntries(
  Array.from({length:count}, (_, i) => [String.fromCharCode(97+i), i===0 ? first : 0]));
const value = (constructor:string, fields:any) => ({constructor,fields});
const key = (first:number) => value('../sdk/context.Key',fields(8,first));
const bytes = () => value('../sdk/cpi.Bytes64',fields(16,42));
const meta = (active:boolean) => value('../sdk/cpi.Meta', {
  index:active ? 11 : 0, key:key(active ? 12 : 0), writable:active, signer:false,
});
const instruction = value('cpi-pair.Run', {
  effect:value('../sdk/cpi.Invoke', {
    program:2, program_key:key(3), length:1, data:bytes(), count:1,
    accounts:value('../sdk/cpi.Metas',Object.fromEntries(
      Array.from({length:8}, (_,i) => [String.fromCharCode(97+i),meta(i===0)]))),
  }),
  second_data:bytes(),
});
assert.deepEqual(payload.fixtures.map((f:any)=>f.name), ['cpi-2','cpi-3','cpi-4']);
const rows = payload.fixtures.map((f:any) => {
  const codec=wireCodec(f.schema), type=f.schema.exports[0].args[2];
  const encoded=Array.from(codec.encode(type,instruction));
  assert.deepEqual(Array.from(codec.encode(type,codec.decode(type,Uint8Array.from(encoded)))),encoded);
  return {fixture:f.name,instruction,bytes:encoded};
});
const files=[import.meta.path,'sdk/wire.ts','compiler/schema.ts',input];
fs.writeFileSync(output,JSON.stringify({rows,inputs:Object.fromEntries(files.map(p=>
  [p,createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))},null,2)+'\n');
console.log('Constructed three canonical caller witness profiles without historical proof input');
