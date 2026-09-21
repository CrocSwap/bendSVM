import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareBend, compileSbf, BEND_COMMIT } from './build.ts';

export async function buildProgram(source: string, root: string, stem: string, layoutPath?: string) {
  prepareBend();
  const { checkedProgram, Backend } = await import('../compiler/backend.ts');
  const { writeArtifacts } = await import('../compiler/artifacts.ts');
  const checked = await checkedProgram(source);
  const layout = layoutPath === undefined ? undefined : JSON.parse(fs.readFileSync(layoutPath,'utf8'));
  if (layoutPath !== undefined && (!layout || typeof layout !== 'object' || Array.isArray(layout))) throw new Error('Invalid storage layout');
  const selection=layout?.collection?.select;
  if(layout?.collection && typeof selection!=='string')throw new Error('Collection layout requires a selection root');
  const emitted = new Backend(checked.book).emit(selection===undefined?[root]:[...new Set([root,selection])]);
  writeArtifacts(stem,emitted,root,layout);
  const {writeClientArtifacts,clientSuffixes}=await import('../compiler/client-artifacts.ts');
  await writeClientArtifacts(stem,emitted.schema,JSON.parse(fs.readFileSync(stem+'.interface.json','utf8')));
  const {version} = compileSbf(stem+'.c',stem);
  const hash = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const support=['scripts/program.ts','scripts/build.ts','package.json','package-lock.json',
    ...['compiler','runtime','sdk'].flatMap(dir=>fs.readdirSync(dir).filter(f=>/\.(?:ts|c|h|ld)$/.test(f)).map(f=>`${dir}/${f}`))];
  const inputs=[...new Set([...checked.files,...support,...(layoutPath?[layoutPath]:[])].map(f=>path.relative(process.cwd(),path.resolve(f))))].sort();
  const outputs=['.h','.c','.schema.json','.interface.json','.wire.h','.dispatch.h','.so','.resources.json','.stack.json',...clientSuffixes];
  const manifest={version:1,source:path.relative(process.cwd(),path.resolve(source)),root,
    bendCommit:BEND_COMMIT,bun:process.versions.bun,compiler:version.split('\n')[0],platformTools:'v1.53',
    target:'sbf',cpu:'generic',sbpfVersion:0,emittedFunctions:emitted.functions,
    inputs:Object.fromEntries(inputs.map(file=>[file,hash(file)])),
    artifacts:Object.fromEntries(outputs.map(suffix=>[suffix,hash(stem+suffix)])),elfBytes:fs.statSync(stem+'.so').size};
  fs.writeFileSync(stem+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');
  const resources=JSON.parse(fs.readFileSync(stem+'.resources.json','utf8')),stack=JSON.parse(fs.readFileSync(stem+'.stack.json','utf8'));
  console.log(`Largest value: ${resources.largestNativeBytes}/1536 native bytes, ${resources.largestWireBytes}/1024 wire bytes; largest frame: ${stack.maxFrameBytes}/4096 bytes`);
  console.log(`Built ${stem}.so (${manifest.elfBytes} bytes), interface and source manifest`);
  return manifest;
}

if(import.meta.main) {
  const [source,root,stem,layout,...extra]=process.argv.slice(2);
  if(!source||!root||!stem||extra.length) {
    console.error('Usage: bun scripts/program.ts PROOF.bend namespace.function output-stem [storage-layout.json]');process.exit(1);
  }
  try {await buildProgram(source,root,stem,layout);} catch(e) {console.error(e instanceof Error?e.message:e);process.exit(1);}
}
