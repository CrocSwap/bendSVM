import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const hash = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ownInputs = [fileURLToPath(import.meta.url), path.join(root,'scripts/build-sha256-library.ts'),
  path.join(root,'scripts/build-sha256-packed-library.ts'), path.join(root,'scripts/build.ts')];
const loadedInputs = Object.fromEntries(ownInputs.map(file => [file,hash(file)]));

function requireCurrent(inputs:Record<string,string>):void {
  for (const [file,expected] of Object.entries(inputs)) {
    if (hash(file)!==expected) throw new Error(`Qualified library input changed: ${file}`);
  }
}

/** Publish objects and their provenance. Final linked ELF authorization is separate. */
export async function buildQualifiedShaLibrary(source:string, runtimeRoot:string, outputDirectory:string) {
  if (arguments.length!==3) throw new Error('Only source, runtime root and output directory are accepted');
  return publishQualifiedShaLibrary(source,runtimeRoot,outputDirectory,'short');
}

/** Packed SHA has its own reviewed source/root catalog; callers cannot supply a receipt. */
export async function buildQualifiedPackedShaLibrary(source:string, runtimeRoot:string, outputDirectory:string) {
  if (arguments.length!==3) throw new Error('Only source, runtime root and output directory are accepted');
  return publishQualifiedShaLibrary(source,runtimeRoot,outputDirectory,'packed');
}

async function publishQualifiedShaLibrary(source:string, runtimeRoot:string, outputDirectory:string, profile:'short'|'packed') {
  const directory = path.resolve(outputDirectory);
  fs.mkdirSync(directory,{recursive:true});
  const lock = path.join(directory,'lock');
  fs.mkdirSync(lock);
  const id = crypto.randomUUID();
  const active = path.join(directory,'active.json');
  const archive = path.join(directory,`archive-${id}.json`);
  const stage = path.join(directory,`stage-${id}`);
  const generationName = `generation-${id}`;
  const generation = path.join(directory,generationName);
  const temporary = path.join(directory,`manifest-${id}.tmp`);
  try {
    if (fs.existsSync(active)) fs.renameSync(active,archive);
    fs.mkdirSync(stage);
    if (fs.realpathSync(process.cwd())!==fs.realpathSync(root)) {
      throw new Error('Run qualified library builds from the repository owning this module');
    }
    requireCurrent(loadedInputs);
    const {prepareBend,run,sbfTools} = await import('./build.ts');
    prepareBend();
    // Loading/building happens after success retirement, including proof/setup failures.
    const {buildLibrary} = await import('../compiler/library.ts');
    const stem = path.join(stage,'library');
    const ordinary = await buildLibrary(source,runtimeRoot,stem);
    const qualified = profile==='short'
      ? await (await import('../compiler/sha256-qualified-emission.ts')).emitSha256QualifiedSbf(source,[runtimeRoot])
      : await (await import('../compiler/sha256-packed-qualified-emission.ts')).emitSha256PackedQualifiedSbf(source,[runtimeRoot]);
    const inputs:Record<string,string> = {...loadedInputs};
    const bind = (file:string,digest:string) => {
      const absolute = path.resolve(file);
      if (inputs[absolute]!==undefined && inputs[absolute]!==digest) {
        throw new Error(`Ordinary/qualified input mismatch: ${file}`);
      }
      inputs[absolute]=digest;
    };
    for (const [file,digest] of Object.entries(ordinary.inputs)) bind(file,digest);
    for (const item of qualified.receipt.sourceInputs) bind(item.path,item.sha256);
    for (const [file,digest] of Object.entries(qualified.receipt.supportInputs)) {
      if (!file.includes('#') && !file.startsWith('toolchain/')) bind(path.join(root,file),digest);
    }
    bind(process.execPath,hash(process.execPath));
    requireCurrent(inputs);
    const strip = (text:string) => text.replace(/^#pragma once\s*$/gm,'');
    const region = strip(qualified.originalEmission.c);
    const wrapper = fs.readFileSync(stem+'.c','utf8');
    const schema = JSON.parse(fs.readFileSync(stem+'.schema.json','utf8'));
    if (wrapper.split(region).length!==2 || JSON.stringify(schema.schema)!==JSON.stringify(qualified.schema) ||
        JSON.stringify(ordinary.emittedFunctions)!==JSON.stringify(qualified.originalEmission.functions)) {
      throw new Error('Ordinary library wrapper does not match freshly qualified emission');
    }
    const sourceFile = path.join(stage,'library.qualified.c');
    const objectFile = path.join(stage,'library.qualified.sbf.o');
    fs.writeFileSync(sourceFile,'#include "bend_sha256.h"\n'+wrapper.replace(region,strip(qualified.c)));
    const tools = sbfTools();
    const clang = path.join(tools,'clang');
    const readelf = path.join(tools,'llvm-readelf');
    bind(clang,hash(clang));bind(readelf,hash(readelf));
    const version = run(clang,['--version'],true);
    if (!version.includes('20.1.7') || !version.includes('anza-xyz')) throw new Error('Expected pinned Anza Clang 20.1.7');
    const flags = ['--target=sbf','-mcpu=generic','-O2','-fPIC','-ffreestanding',
      '-fno-builtin','-fno-stack-protector','-std=c17','-Wall','-Wextra','-Werror',
      '-Wno-unused-function','-Wframe-larger-than=4096','-fstack-usage',
      '-ffunction-sections','-fdata-sections',`-I${stage}`,'-Iruntime'];
    run(clang,[...flags,'-c',sourceFile,'-o',objectFile]);
    const objectSha256 = hash(objectFile);
    const symbols = run(readelf,['-s',objectFile],true);
    const lines = symbols.split('\n');
    const imports = lines.filter(line => /\bUND\b/.test(line))
      .map(line => line.trim().split(/\s+/).at(-1)!).filter(name => name!=='UND');
    const allowed = new Set(['abort','sol_sha256','memcpy','memmove','memset']);
    if (!imports.includes('abort') || !imports.includes('sol_sha256') || imports.some(name => !allowed.has(name))) {
      throw new Error(`Unsupported qualified library object imports: ${imports.join(', ')}`);
    }
    for (const name of ['abort','sol_sha256']) {
      if (lines.some(line => line.trim().split(/\s+/).at(-1)===name && !/\bUND\b/.test(line))) {
        throw new Error(`Qualified library syscall is locally defined: ${name}`);
      }
    }
    if (!lines.some(line => /\bGLOBAL\b/.test(line) && !/\bUND\b/.test(line) && line.trim().endsWith(ordinary.symbol))) {
      throw new Error('Qualified library ABI export is missing');
    }
    const stackFile = objectFile.replace(/\.o$/,'.su');
    const stackRows = fs.readFileSync(stackFile,'utf8').trim().split('\n');
    const frames = stackRows.map(line => {
      const [,bytes,kind,...extra] = line.split('\t');
      if (!/^\d+$/.test(bytes??'') || kind!=='static' || extra.length || Number(bytes)>4096) {
        throw new Error(`Unsupported qualified library stack row: ${line}`);
      }
      return Number(bytes);
    });
    if (hash(objectFile)!==objectSha256) throw new Error('Qualified library object changed during profile checks');
    fs.writeFileSync(path.join(stage,'qualification.json'),JSON.stringify(qualified.receipt,null,2)+'\n');
    const artifacts:Record<string,{bytes:number;sha256:string}> = {};
    for (const name of fs.readdirSync(stage).sort()) {
      const file = path.join(stage,name);
      if (!fs.lstatSync(file).isFile()) throw new Error(`Unexpected library artifact: ${name}`);
      artifacts[name]={bytes:fs.statSync(file).size,sha256:hash(file)};
    }
    // The ordinary build's manifest is private evidence, never the active marker.
    for (const [name,record] of Object.entries(ordinary.artifacts)) {
      if (artifacts[name]?.bytes!==record.bytes || artifacts[name]?.sha256!==record.sha256) {
        throw new Error(`Ordinary library artifact changed: ${name}`);
      }
    }
    if (artifacts['library.qualified.sbf.o'].sha256!==objectSha256) throw new Error('Qualified library object changed after profile checks');
    requireCurrent(inputs);
    fs.renameSync(stage,generation);
    for (const [name,record] of Object.entries(artifacts)) {
      const file=path.join(generation,name);
      if (fs.statSync(file).size!==record.bytes || hash(file)!==record.sha256) throw new Error(`Library artifact changed before publication: ${name}`);
    }
    requireCurrent(inputs);
    const manifest = {
      version:1,kind:profile==='short'?'sha256-qualified-library-v1':'sha256-packed-qualified-library-v1',
      qualificationProfile:profile,id,generation:generationName,
      source:path.relative(root,path.resolve(source)),root:runtimeRoot,
      abiVersion:ordinary.abiVersion,symbol:ordinary.symbol,schemaFingerprint:ordinary.schemaFingerprint,
      canonicalInputBytes:ordinary.canonicalInputBytes,canonicalOutputBytes:ordinary.canonicalOutputBytes,
      inputs,artifacts,
      selection:{hostSource:'library.c',hostObject:'library.host.o',sbfSource:'library.qualified.c',
        sbfObject:'library.qualified.sbf.o',memoryObject:'library.sbf.memory.o',header:'library.h',bindings:'library.bindings.rs',schema:'library.schema.json'},
      qualification:{file:'qualification.json',sha256:artifacts['qualification.json'].sha256,
        catalogSha256:qualified.receipt.qualificationCatalogSha256,
        requiredFinalElfProfile:qualified.receipt.requiredFinalElfProfile},
      objectProfile:{sha256:objectSha256,imports,maxFrameBytes:Math.max(...frames),frameLimitBytes:4096,compilerVersion:version.split('\n')[0]},
      ordinaryManifest:{file:'library.manifest.json',sha256:artifacts['library.manifest.json'].sha256},
      priorArchive:fs.existsSync(archive)?{file:path.basename(archive),sha256:hash(archive)}:null,
      finalElfAuthorized:false,
      scope:`Ordinary checked-source host library and source-qualified ${profile}-SHA SBF object. Final Rust-linked image imports, stack, call depth and artifact qualification are required separately. Trusted process, stable filesystem, Bend/LLVM and SHA syscall assumptions remain.`,
    };
    fs.writeFileSync(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    fs.renameSync(temporary,active);
    console.log(`Built qualified SHA library ${runtimeRoot}: ${active}`);
    return manifest;
  } catch (error) {
    fs.rmSync(temporary,{force:true});
    fs.writeFileSync(path.join(directory,`failure-${id}.json`),JSON.stringify({
      passed:false,id,error:error instanceof Error?error.message:String(error),stage,generation,
      priorArchive:fs.existsSync(archive)?path.basename(archive):null,
    },null,2)+'\n');
    throw error;
  } finally {
    fs.rmdirSync(lock);
  }
}
