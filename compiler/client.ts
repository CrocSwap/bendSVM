import path from 'node:path';
import type {RuntimeSchema} from './schema.ts';
import {friendlyKind,programClient,type ProgramLayout} from '../sdk/program-client.ts';

// Generated clients reuse the canonical codec; this generator emits types and
// named methods, never a second implementation of the binary protocol.
export function emitClient(schema:RuntimeSchema,layout:ProgramLayout,outputFile:string,runtimeImport?:string):string {
  programClient(schema,layout,'11111111111111111111111111111111');
  const names=new Map(schema.types.map((t,i)=>[t.name,`Value${i}`]));
  const q=JSON.stringify,short=(name:string)=>name.split('.').at(-1)!;
  const fields=(xs:{name:string,type:string}[])=>xs.length?`{ ${xs.map(f=>`${q(f.name)}: ${names.get(f.type)}`).join('; ')} }`:'Record<string, never>';
  const definitions=schema.types.map(t=>{
    const friendly=friendlyKind(t);
    const type=friendly==='key'?'string':friendly==='u64'?'bigint':t.kind==='u32'?'number':t.kind==='bool'?'boolean':
      t.variants.map(v=>`{ ${t.variants.length===1?'':`kind: ${q(short(v.sourceName??v.name))}; `}${v.fields.map(f=>`${q(f.name)}: ${names.get(f.type)}`).join('; ')} }`).join(' | ');
    return `/** ${t.name.replaceAll('*/','* /')} */\nexport type ${names.get(t.name)} = ${type};`;
  }).join('\n');
  const instruction=schema.types.find(t=>t.name===layout.instruction)!;
  if(instruction.kind!=='adt')throw new Error('Instructions must be constructors');
  let runtime=path.relative(path.dirname(path.resolve(outputFile)),path.resolve(import.meta.dir,'../sdk/program-client.ts')).split(path.sep).join('/');
  if(!runtime.startsWith('.'))runtime='./'+runtime;
  runtime=runtimeImport??runtime;
  const state=layout.version===2?`state: { ${layout.stateAccounts.map(a=>`${q(a.field)}: (data:Uint8Array) => core.state(data,${q(a.field)}) as ${names.get(a.type)}`).join(', ')} }`:
    `state: (data:Uint8Array) => core.state(data) as ${names.get(layout.state)}`;
  const collection=layout.version===3?`,\n    collection: (data:Uint8Array,stateAddress:string,start:number,count:number) => core.collection(data,stateAddress,start,count) as {length:number;capacity:number;entries:${names.get(layout.collection.element)}[]}`:'';
  return `// Generated from the checked Bend schema. Regenerate with the project build command.\nimport {programClient,type ProgramLayout,type CallOptions} from ${q(runtime)};\n${definitions}\nexport type Accounts = { ${layout.accounts.filter(n=>n!=='remaining...').map(n=>`${q(n)}: string`).join('; ')} };\nconst schema = ${q(schema)} as const;\nconst layout = ${q(layout)} as unknown as ProgramLayout;\nexport function createClient(program:string) {\n  const core=programClient(schema as any,layout,program);\n  return {\n    instructions: {\n${instruction.variants.map(v=>`      ${q(short(v.sourceName??v.name))}: (args:${fields(v.fields)},accounts:Accounts,options?:CallOptions) => core.call(${q(short(v.sourceName??v.name))},args,accounts,options)`).join(',\n')}\n    },\n    ${state}${collection},\n    allocationBytes: core.allocationBytes\n  };\n}\n`;
}
