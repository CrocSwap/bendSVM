import fs from 'node:fs';
import path from 'node:path';
import {emitClient} from './client.ts';
import type {RuntimeSchema} from './schema.ts';
import type {ProgramLayout} from '../sdk/program-client.ts';

export const clientSuffixes=['.client.ts','.client.js','.client-runtime.js','.client-runtime.d.ts'];
async function bundle(entry:string) {
  const result=await Bun.build({entrypoints:[entry],target:'browser',minify:{whitespace:true,syntax:false,identifiers:false}});
  if(!result.success)throw new Error(`Client bundling failed: ${result.logs.join('\n')}`);
  if(result.outputs.length!==1)throw new Error('Expected one portable client bundle');
  return await result.outputs[0].text();
}
export async function writeClientArtifacts(stem:string,schema:RuntimeSchema,layout:ProgramLayout) {
  const name=path.basename(stem);
  const runtime=await bundle(path.resolve(import.meta.dir,'../sdk/program-client.ts'));
  const source=emitClient(schema,layout,stem+'.client.ts',`./${name}.client-runtime.js`);
  fs.writeFileSync(stem+'.client-runtime.js',runtime);
  fs.writeFileSync(stem+'.client-runtime.d.ts',`// Public contract for the bundled canonical client runtime.\nexport type ProgramLayout=unknown;
export type AccountMeta={address:string;signer:boolean;writable:boolean};
export type CallOptions={mode?:'initialize'|'transition';remaining?:AccountMeta[]};
export type InstructionPlan={program:string;accounts:AccountMeta[];data:Uint8Array};
export declare function programClient(schema:unknown,layout:ProgramLayout,program:string):{
call(name:string,args:unknown,accounts:Record<string,string>,options?:CallOptions):InstructionPlan;
state(data:Uint8Array,field?:string,primaryAddress?:string):unknown;
collection(data:Uint8Array,stateAddress:string,start:number,count:number):{length:number;capacity:number;entries:unknown[]};
allocationBytes(capacity?:number):Record<string,number>;
};\n`);
  fs.writeFileSync(stem+'.client.ts',source);
  fs.writeFileSync(stem+'.client.js',await bundle(path.resolve(stem+'.client.ts')));
}
