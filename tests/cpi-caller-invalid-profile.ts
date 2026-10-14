import fs from 'node:fs';
import {wireCodec} from '../sdk/wire.ts';
const [input,profiles,output]=process.argv.slice(2);
const p=JSON.parse(fs.readFileSync(profiles,'utf8'));
const fixtures=JSON.parse(fs.readFileSync(input,'utf8')).fixtures;
const rows=p.rows.map((r:any)=>{const f=fixtures.find((f:any)=>f.name===r.fixture);const v=structuredClone(r.instruction);v.fields.second_data.fields.b=1;return {fixture:r.fixture,bytes:Array.from(wireCodec(f.schema).encode(f.schema.exports[0].args[2],v))};});
fs.writeFileSync(output,JSON.stringify({rows},null,2)+'\n');
