import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareBend} from './build.ts';

export const repository=path.resolve(import.meta.dir,'..');
export type Project={version:1;source:string;root:string;layout:string|null;output:string};
export function loadProject(directory:string) {
  const dir=path.resolve(directory),file=path.join(dir,'bend.json');
  if(!fs.existsSync(file))throw new Error(`No bend.json in ${dir}. Create a project with: npm run bend -- new <directory>`);
  const config=JSON.parse(fs.readFileSync(file,'utf8')) as Project;
  if(config.version!==1||Object.keys(config).sort().join(',')!=='layout,output,root,source,version'||
      [config.source,config.root,config.output].some(v=>typeof v!=='string'||!v.trim())||
      (config.layout!==null&&(typeof config.layout!=='string'||!config.layout.trim())))throw new Error('Invalid bend.json: expected version, source, root, layout (path or null) and output');
  for(const value of [config.source,...(config.layout?[config.layout]:[]),config.output]) {
    const relative=path.relative(dir,path.resolve(dir,value));
    if(relative==='..'||relative.startsWith('../')||path.isAbsolute(relative))throw new Error('Project source, layout and output paths must stay inside the project');
  }
  return {dir,config,source:path.resolve(dir,config.source),layout:config.layout?path.resolve(dir,config.layout):undefined,stem:path.resolve(dir,config.output)};
}
export function createProject(destination:string) {
  const dir=path.resolve(destination);
  if(fs.existsSync(dir))throw new Error(`Refusing to overwrite existing path: ${dir}`);
  fs.mkdirSync(path.dirname(dir),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(dir),'.bend-new-'));
  try {
    let sdk=path.relative(dir,path.join(repository,'sdk')).split(path.sep).join('/');
    if(!sdk.startsWith('.'))sdk='./'+sdk;
    for(const name of fs.readdirSync(path.join(repository,'templates/collection'))){
      const quotedDirectory="'"+dir.replaceAll("'","'\\''")+"'";
      const source=fs.readFileSync(path.join(repository,'templates/collection',name),'utf8').replaceAll('@SDK@',sdk).replaceAll('@PROJECT@',quotedDirectory);
      fs.writeFileSync(path.join(staging,name),source);
    }
    fs.writeFileSync(path.join(staging,'bend.json'),JSON.stringify({version:1,source:'PROOF.bend',root:'program.process',layout:'storage.json',output:'dist/program'},null,2)+'\n');
    fs.writeFileSync(path.join(staging,'.gitignore'),'dist/\n');
    fs.renameSync(staging,dir);
  }catch(e){fs.rmSync(staging,{recursive:true,force:true});throw e;}
  return dir;
}
export async function projectCommand(command:string,directory:string) {
  const project=loadProject(directory);
  if(command==='test')fs.rmSync(project.stem+'.test-report.json',{force:true});
  process.chdir(repository);
  prepareBend();
  if(command==='build'||command==='test'){
    const {buildProgram}=await import('./program.ts');
    const manifest=await buildProgram(project.source,project.config.root,project.stem,project.layout);
    if(command==='build')return manifest;
    const testFile=path.join(project.dir,'test.ts');
    if(!fs.existsSync(testFile))throw new Error('Project has no test.ts. Export an async function accepting the SBF test context.');
    const test=await import(testFile);
    if(typeof test.default!=='function')throw new Error('test.ts must export a default test function');
    const {startTestProgram}=await import('../sdk/testing.ts');
    const t=await startTestProgram(project.stem+'.so');
    try {
      await test.default(t);
      const summary=t.summary();
      if(!summary.programCalls||!summary.assertions)throw new Error('Tests must invoke this SBF program and assert their results');
      const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const files=[testFile,path.join(project.dir,'bend.json'),project.stem+'.manifest.json','scripts/bend.ts','sdk/testing.ts','scripts/test-runner/Cargo.toml','scripts/test-runner/Cargo.lock','scripts/test-runner/src/main.rs','target/debug/bend-test-runner'];
      const report={passed:true,...summary,receipts:t.receipts,hashes:Object.fromEntries(files.map(file=>[path.relative(repository,file),hash(file)]))};
      await t.close();
      fs.writeFileSync(project.stem+'.test-report.json',JSON.stringify(report,null,2)+'\n');
      console.log(`SBF tests passed: ${summary.successful} successful transactions, ${summary.rejected} expected rejections, ${summary.assertions} assertions`);
      return report;
    }catch(e){await t.close().catch(()=>{});throw e;}
  }
  const {checkedProgram,Backend}=await import('../compiler/backend.ts');
  const checked=await checkedProgram(project.source);
  if(command==='verify'){
    console.log('Declared source laws and dependencies checked. This is not an automatic SMT or compiled-binary proof.');return;
  }
  if(command==='check'){
    const layout=project.layout?JSON.parse(fs.readFileSync(project.layout,'utf8')):undefined;
    const roots=[...new Set([project.config.root,...(layout?.collection?[layout.collection.select]:[])])];
    const emitted=new Backend(checked.book).emit(roots);
    const {emitStorage}=await import('../compiler/storage.ts');
    const {programClient}=await import('../sdk/program-client.ts');
    const adapter=emitStorage(emitted.schema,project.config.root,layout);
    programClient(emitted.schema,adapter.interface as any,'11111111111111111111111111111111');
    console.log('Source laws, SBF subset, storage layout and client compatibility checked. Build also checks compiled stack limits.');return;
  }
  throw new Error(`Unknown command: ${command}`);
}
if(import.meta.main){
  const [command,directory,...extra]=process.argv.slice(2);
  try {
    if(!command||!directory||extra.length||!['new','check','verify','build','test'].includes(command))throw new Error('Usage: npm run bend -- <new|check|verify|build|test> <project-directory>');
    if(command==='new')console.log(`Created ${createProject(directory)}`);
    else await projectCommand(command,path.resolve(directory));
  }catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}
}
