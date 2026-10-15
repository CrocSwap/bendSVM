import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareBend, compileSbf, compileQualifiedShaSbf, BEND_COMMIT, sbfTools, run } from './build.ts';
import { publishAcceptedFinalSbfArtifact, verifyFinalSbfArtifactReceipt } from '../compiler/sbf-call-depth-artifact.ts';

function runId(): string {
  return `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomUUID()}`;
}

function preserveFile(source: string, destination: string): void {
  try {
    fs.renameSync(source, destination);
  } catch (renameError) {
    try {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.rmSync(source);
    } catch (copyError) {
      fs.rmSync(source, { force: true });
      throw new Error(`Could not preserve ${source} at ${destination}: ${String(renameError)}; ${String(copyError)}`);
    }
  }
}

function archivePriorProgramEvidence(stem: string, buildRunId: string): string | null {
  const absoluteStem = path.resolve(stem);
  const files = [`${absoluteStem}.manifest.json`, `${absoluteStem}.so`].filter(file => fs.existsSync(file));
  if (files.length === 0) return null;
  const archive = path.join(path.dirname(absoluteStem), 'sbf-call-depth-archive',
    `${path.basename(absoluteStem)}-${buildRunId}`);
  fs.mkdirSync(archive, { recursive: true });
  for (const file of files) preserveFile(file, path.join(archive, path.basename(file)));
  return path.relative(process.cwd(), archive);
}

function quarantineFailedElf(stem: string, buildRunId: string): string | null {
  const elfPath = `${path.resolve(stem)}.so`;
  const manifestPath = `${path.resolve(stem)}.manifest.json`;
  const files = [elfPath, manifestPath].filter(file => fs.existsSync(file));
  if (files.length === 0) return null;
  const directory = path.join(path.dirname(elfPath), 'sbf-call-depth-refused',
    `${path.basename(stem)}-${buildRunId}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files) preserveFile(file, path.join(directory, path.basename(file)));
  return path.relative(process.cwd(), path.join(directory, path.basename(elfPath)));
}

function fileHash(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceFilesIn(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesIn(file);
    return entry.isFile() && /\.(?:ts|bend|c|h|ld|json)$/.test(entry.name) ? [file] : [];
  });
}

function evidencePath(file: string): string {
  const absolute = path.resolve(file);
  const relative = path.relative(process.cwd(), absolute);
  return relative === '..' || relative.startsWith(`..${path.sep}`) ? absolute : relative;
}

function snapshotFiles(files: string[]): Record<string, string> {
  const unique = [...new Set(files.map(file => path.resolve(file)))].sort();
  return Object.fromEntries(unique.map(file => [evidencePath(file), fileHash(file)]));
}

function assertSnapshotCurrent(snapshot: Record<string, string>, label: string): void {
  for (const [file, digest] of Object.entries(snapshot)) {
    if (!fs.existsSync(file) || fileHash(file) !== digest) throw new Error(`${label} changed before publication: ${file}`);
  }
}

/** Build one explicit SHA opt-in program through same-book qualification and the fixed SHA SBF profile. */
export async function buildQualifiedShaProgram(
  source: string,
  root: string,
  stem: string,
  layoutPath?: string,
  commandScript = path.resolve('scripts/build-sha256-program.ts'),
) {
  const buildRunId = runId();
  fs.mkdirSync(path.dirname(path.resolve(stem)), {recursive:true});
  const priorEvidenceArchive = archivePriorProgramEvidence(stem, buildRunId);
  fs.rmSync(`${path.resolve(stem)}.manifest.json`, {force:true});
  fs.rmSync(`${path.resolve(stem)}.so`, {force:true});
  let manifestTemporary: string | null = null;
  try {
    const support = [
      ...['compiler','runtime','sdk'].flatMap(sourceFilesIn),
      'node_modules/bun/bin/bun.exe','.deps/bend/bend2/bend.ts','.deps/bend/bend2/base.bend',
      'scripts/program.ts','scripts/build.ts',commandScript,'package.json','package-lock.json',
      ...(layoutPath ? [layoutPath] : []),source,
    ];
    const inputsBeforeQualification = snapshotFiles(support);
    const layoutBytes = layoutPath === undefined ? undefined : fs.readFileSync(layoutPath);
    if (layoutPath !== undefined && inputsBeforeQualification[evidencePath(layoutPath)] !==
        crypto.createHash('sha256').update(layoutBytes!).digest('hex')) {
      throw new Error('Storage layout changed while build inputs were captured');
    }
    const toolsDirectory = path.resolve(sbfTools());
    const toolExecutables = ['clang','ld.lld','llvm-readelf'].map(name=>path.join(toolsDirectory,name));
    const toolchainBefore = snapshotFiles(toolExecutables);
    prepareBend();
    const layout = layoutBytes === undefined ? undefined : JSON.parse(layoutBytes.toString('utf8'));
    if (layoutPath !== undefined && (!layout || typeof layout !== 'object' || Array.isArray(layout))) throw new Error('Invalid storage layout');
    const selection=layout?.collection?.select;
    if(layout?.collection && typeof selection!=='string')throw new Error('Collection layout requires a selection root');
    const roots = selection === undefined ? [root] : [...new Set([root, selection])];

    // This is the only authority path: qualification derives from source and
    // roots internally and retains its one checked book through Backend emission.
    const {emitSha256QualifiedSbf} = await import('../compiler/sha256-qualified-emission.ts');
    const qualified = await emitSha256QualifiedSbf(source, roots);
    assertSnapshotCurrent(inputsBeforeQualification,'Build input during qualification');
    for (const item of qualified.receipt.sourceInputs) {
      const key = evidencePath(item.path);
      if (inputsBeforeQualification[key] !== undefined && inputsBeforeQualification[key] !== item.sha256) {
        throw new Error(`Qualified source input differs from the pre-build snapshot: ${item.path}`);
      }
    }
    const inputsBeforeBuild = {...inputsBeforeQualification,
      ...Object.fromEntries(qualified.receipt.sourceInputs.map(item=>[evidencePath(item.path),item.sha256]))};
    for (const [name,digest] of Object.entries(qualified.receipt.supportInputs)) {
      if (name.startsWith('toolchain/') || name.endsWith('#normalized')) continue;
      const actualName = name.replace(/#(?:normalized|raw)$/,'');
      if (path.isAbsolute(actualName)) continue;
      if (inputsBeforeBuild[evidencePath(actualName)] !== digest) throw new Error(`Qualified support input changed before SBF build: ${name}`);
    }
    const qualifiedToolchainFiles: Record<string,string> = {
      'toolchain/bun-executable':'node_modules/bun/bin/bun.exe',
      'toolchain/bend2/bend.ts':'.deps/bend/bend2/bend.ts',
      'toolchain/bend2/base.bend':'.deps/bend/bend2/base.bend',
    };
    for (const [receiptKey,file] of Object.entries(qualifiedToolchainFiles)) {
      if (inputsBeforeBuild[evidencePath(file)] !== qualified.receipt.supportInputs[receiptKey]) {
        throw new Error(`Qualified toolchain input changed before SBF build: ${file}`);
      }
    }
    const {writeArtifacts} = await import('../compiler/artifacts.ts');
    writeArtifacts(stem, {c:qualified.c,schema:qualified.schema}, root, layout);
    const {writeClientArtifacts,clientSuffixes}=await import('../compiler/client-artifacts.ts');
    await writeClientArtifacts(stem,qualified.schema,JSON.parse(fs.readFileSync(stem+'.interface.json','utf8')));
    // The storage source needs the fixed SHA runtime declarations before it
    // includes the ordinary generated codecs and qualified Bend C header.
    const storageC = fs.readFileSync(stem+'.c','utf8');
    fs.writeFileSync(stem+'.c', '#include "solana_min.h"\n#include "bend_sha256.h"\n' + storageC);
    if (fileHash(stem+'.h') !== qualified.receipt.replacement.resultingCSha256) {
      throw new Error('Qualified C artifact does not match the same-build qualification receipt');
    }

    const generated = ['.h','.c','.schema.json','.interface.json','.wire.h','.dispatch.h',
      '.resources.json','.stack.json','.so','.o','.memory.o','.su','.memory.su',...clientSuffixes];

    const {version,imports,stack,toolchain,elfSha256:checkedElfSha256} = compileQualifiedShaSbf(stem+'.c',stem);
    const requiredImports = ['abort','sol_sha256'];
    if (requiredImports.some(name=>!imports.includes(name)) || imports.includes('sol_log_64_')) {
      throw new Error('Qualified SHA final ELF import profile was not satisfied');
    }
    if (fileHash(stem+'.so') !== checkedElfSha256) {
      throw new Error('Qualified SHA final ELF changed after SBPFv0 header/import validation');
    }
    const outputPaths = generated.map(suffix=>stem+suffix);
    const outputHashes = snapshotFiles(outputPaths);
    if (outputHashes[evidencePath(stem+'.so')] !== checkedElfSha256) {
      throw new Error('Qualified SHA final ELF changed while generated artifacts were captured');
    }
    const manifestBase = {
      version:1,source:evidencePath(source),root,roots,priorEvidenceArchive,
      bendCommit:BEND_COMMIT,bun:process.versions.bun,compiler:version.split('\n')[0],
      platformTools:'v1.53',target:'sbf',cpu:'generic',sbpfVersion:0,
      qualifiedSha256:{
        profile:'source-qualified-sha256-sbpf-v0',
        receipt:qualified.receipt,
        receiptSha256:crypto.createHash('sha256').update(JSON.stringify(qualified.receipt)).digest('hex'),
        originalEmission:{cSha256:qualified.receipt.originalEmission.cSha256,
          taggedSumLoweringSha256:qualified.receipt.originalEmission.taggedSumLoweringSha256,
          taggedSumEvidenceScope:'originalC only'},
      },
      inputs:inputsBeforeBuild,
      qualification:{sourceInputs:qualified.receipt.sourceInputs,supportInputs:qualified.receipt.supportInputs},
      toolchain:{tools:toolchainBefore,reported:toolchain,sha256Profile:'Anza v1.53 Clang 20.1.7 / LLD SBPFv0'},
      generated:Object.fromEntries(Object.entries(outputHashes).map(([file,sha256])=>[
        path.relative(path.resolve(path.dirname(stem)),path.resolve(file)),sha256])),
      artifacts:Object.fromEntries(outputPaths.map(file=>[
        path.basename(file).slice(path.basename(stem).length),outputHashes[evidencePath(file)]])),
      elfSha256:checkedElfSha256,elfBytes:fs.statSync(stem+'.so').size,
      imports,stack,
    };
    const {result:manifest}=publishAcceptedFinalSbfArtifact(
      `${stem}.so`,path.join(path.dirname(path.resolve(stem)),'sbf-call-depth'),callDepth=>{
        assertSnapshotCurrent(inputsBeforeBuild,'Build input');
        assertSnapshotCurrent(toolchainBefore,'SBF toolchain');
        assertSnapshotCurrent(outputHashes,'Generated artifact');
        if (fileHash(stem+'.so') !== checkedElfSha256) {
          throw new Error('Qualified SHA final ELF changed after SBPFv0 header/import validation');
        }
        if (run('git',['-C','.deps/bend','rev-parse','HEAD'],true) !== BEND_COMMIT ||
            run('git',['-C','.deps/bend','status','--porcelain','--untracked-files=all'],true) !== '') {
          throw new Error('Pinned Bend checkout changed before qualified SHA publication');
        }
        if (fileHash('compiler/sha256-qualification-pins.json') !== qualified.receipt.qualificationCatalogSha256) {
          throw new Error('Qualified SHA qualification JSON pins changed before publication');
        }
        if (inputsBeforeBuild[callDepth.checker.path] !== callDepth.checker.sha256) {
          throw new Error('SBF_CALL_DEPTH_CHECKER_HASH_MISMATCH: receipt checker differs from the build input snapshot');
        }
        verifyFinalSbfArtifactReceipt(callDepth,`${stem}.so`);
        if (callDepth.artifact.sha256 !== fileHash(`${stem}.so`) || callDepth.artifact.byteLength !== fs.statSync(`${stem}.so`).size) {
          throw new Error('SBF_CALL_DEPTH_ELF_HASH_MISMATCH: call-depth receipt differs from the final qualified SHA ELF');
        }
        const publishedManifest = {...manifestBase,buildRunId,sbfCallDepth:callDepth};
        manifestTemporary = `${stem}.manifest.${callDepth.runId}.tmp`;
        fs.writeFileSync(manifestTemporary,JSON.stringify(publishedManifest,null,2)+'\n',{flag:'wx'});
        fs.renameSync(manifestTemporary,`${stem}.manifest.json`);
        manifestTemporary = null;
        return publishedManifest;
      },{buildRunId});
    const resources=JSON.parse(fs.readFileSync(stem+'.resources.json','utf8'));
    console.log(`Largest value: ${resources.largestNativeBytes}/1536 native bytes, ${resources.largestWireBytes}/1024 wire bytes; largest frame: ${stack.maxFrameBytes}/4096 bytes`);
    console.log(`Built qualified SHA ${stem}.so (${manifest.elfBytes} bytes), interface and qualification manifest`);
    return manifest;
  } catch (error) {
    if (manifestTemporary) fs.rmSync(manifestTemporary,{force:true});
    const archivedElf = quarantineFailedElf(stem,buildRunId);
    throw new Error(`${error instanceof Error?error.message:String(error)}${archivedElf?`; failed ELF archived at ${archivedElf}`:''}`);
  }
}

/**
 * Explicit program targets use platform-tools v1.57: fogo-v0 (SBPFv0, the
 * ordinary v0 pipeline and call-depth gate) and solana-v3. Without a target
 * the historical v1.53 SBPFv0 build is unchanged.
 */
export type ProgramTarget = 'fogo-v0' | 'solana-v3';
export const PROGRAM_TARGETS: readonly ProgramTarget[] = ['fogo-v0', 'solana-v3'];
export async function buildProgram(source: string, root: string, stem: string, layoutPath?: string, target?: ProgramTarget) {
  if (target !== undefined && !PROGRAM_TARGETS.includes(target)) throw new Error(`Unknown program target ${target}; choose ${PROGRAM_TARGETS.join(' or ')}`);
  const buildRunId = runId();
  prepareBend();
  fs.mkdirSync(path.dirname(path.resolve(stem)), { recursive: true });
  const priorEvidenceArchive = archivePriorProgramEvidence(stem, buildRunId);
  fs.rmSync(`${path.resolve(stem)}.manifest.json`, { force: true });
  fs.rmSync(`${path.resolve(stem)}.so`, { force: true });
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
  const hash = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const support=['scripts/program.ts','scripts/build.ts','package.json','package-lock.json',
    ...(target==='solana-v3'?['scripts/build-v3.ts']:[]),
    ...['compiler','runtime','sdk'].flatMap(dir=>fs.readdirSync(dir).filter(f=>/\.(?:ts|c|h|ld)$/.test(f)).map(f=>`${dir}/${f}`))];
  const inputs=[...new Set([...checked.files,...support,...(layoutPath?[layoutPath]:[])].map(f=>path.relative(process.cwd(),path.resolve(f))))].sort();
  const outputs=['.h','.c','.schema.json','.interface.json','.wire.h','.dispatch.h','.so','.resources.json','.stack.json',...clientSuffixes];
  let manifestTemporary: string | null = null;
  try {
    // Keep linking and post-link checks inside quarantine handling: compileSbf
    // can leave a linked ELF before rejecting an unsupported import.
    if (target === 'solana-v3') {
      const {compileSbfV3} = await import('./build-v3.ts');
      const {acceptSbpfV3FinalImage} = await import('../compiler/sbpf-v3-final-image.ts');
      const compiled = compileSbfV3(stem+'.c',stem);
      const reportPath = path.join(path.dirname(path.resolve(stem)),'sbpf-v3-final-image',`${buildRunId}.json`);
      const finalImage = acceptSbpfV3FinalImage(`${stem}.so`,reportPath);
      const v3Inputs=[...new Set([...inputs,'scripts/build-v3.ts'])].sort();
      if (finalImage.checker.sha256 !== hash(finalImage.checker.path)) {
        throw new Error('SBPFV3_FINAL_IMAGE_CHECKER_CHANGED: checker differs from the build input');
      }
      const manifest={version:1,source:path.relative(process.cwd(),path.resolve(source)),root,
        priorEvidenceArchive,buildRunId,
        bendCommit:BEND_COMMIT,bun:process.versions.bun,compiler:compiled.version.split('\n')[0],
        platformTools:compiled.profile.platformTools,target:'sbf',cpu:compiled.profile.cpu,
        sbpfVersion:compiled.profile.sbpfVersion,targetProfile:compiled.profile.name,emittedFunctions:emitted.functions,
        inputs:Object.fromEntries(v3Inputs.map(file=>[file,hash(file)])),
        toolchain:compiled.toolchain,
        artifacts:Object.fromEntries(outputs.map(suffix=>[suffix,hash(stem+suffix)])),elfBytes:fs.statSync(stem+'.so').size,
        sbpfV3FinalImage:{report:path.relative(process.cwd(),reportPath),sha256:hash(reportPath),
          status:finalImage.status,maxActiveFrames:finalImage.maxActiveFrames,
          syscalls:[...new Set(finalImage.syscalls!.map(entry=>entry.name))].sort(),
          checker:finalImage.checker,artifactSha256:finalImage.artifact.sha256}};
      if (manifest.artifacts['.so'] !== finalImage.artifact.sha256) {
        throw new Error('SBPFV3_FINAL_IMAGE_CHANGED: checked ELF differs from the published artifact');
      }
      manifestTemporary = `${stem}.manifest.${buildRunId}.tmp`;
      fs.writeFileSync(manifestTemporary, JSON.stringify(manifest, null, 2) + '\n');
      fs.renameSync(manifestTemporary, `${stem}.manifest.json`);
      manifestTemporary = null;
      const resources=JSON.parse(fs.readFileSync(stem+'.resources.json','utf8'));
      console.log(`Largest value: ${resources.largestNativeBytes}/1536 native bytes, ${resources.largestWireBytes}/1024 wire bytes; largest frame: ${compiled.stack.maxFrameBytes}/4096 bytes; ${finalImage.maxActiveFrames}/64 call frames`);
      console.log(`Built SBPFv3 ${stem}.so (${manifest.elfBytes} bytes), interface and source manifest`);
      return manifest;
    }
    let selected: {profile:'fogo-v0';platformTools:string;toolchain:Record<string,{path:string;invokedAs:string;sha256:string}>} | undefined;
    let compiledVersion: string;
    if (target === 'fogo-v0') {
      const {checkLibraryTools,libraryTarget,libraryTools} = await import('../compiler/target-profile.ts');
      const profile = libraryTarget('fogo-v0');
      const tools = libraryTools(profile);
      checkLibraryTools(profile, tools, ['clang', 'ld.lld', 'llvm-readelf']);
      compiledVersion = compileSbf(stem+'.c',stem,{tools,llvm:profile.llvm,platformTools:profile.platformTools}).version;
      selected = {profile:'fogo-v0',platformTools:profile.platformTools,toolchain:Object.fromEntries(['clang','ld.lld','llvm-readelf'].map(name => {
        const file = path.join(tools, name), resolved = fs.realpathSync(file);
        return [name, {path:resolved,invokedAs:path.resolve(file),sha256:hash(resolved)}];
      }))};
    } else {
      compiledVersion = compileSbf(stem+'.c',stem).version;
    }
    const manifestBase={version:1,source:path.relative(process.cwd(),path.resolve(source)),root,
      priorEvidenceArchive,
      bendCommit:BEND_COMMIT,bun:process.versions.bun,compiler:compiledVersion.split('\n')[0],platformTools:selected?.platformTools??'v1.53',
      target:'sbf',cpu:'generic',sbpfVersion:0,
      ...(selected?{targetProfile:selected.profile,toolchain:selected.toolchain}:{}),
      emittedFunctions:emitted.functions,
      inputs:Object.fromEntries(inputs.map(file=>[file,hash(file)])),
      artifacts:Object.fromEntries(outputs.map(suffix=>[suffix,hash(stem+suffix)])),elfBytes:fs.statSync(stem+'.so').size};
    const resources=JSON.parse(fs.readFileSync(stem+'.resources.json','utf8')),
      stack=JSON.parse(fs.readFileSync(stem+'.stack.json','utf8'));
    const { result: manifest } = publishAcceptedFinalSbfArtifact(
      `${stem}.so`, path.join(path.dirname(path.resolve(stem)), 'sbf-call-depth'), callDepth => {
        if (manifestBase.inputs[callDepth.checker.path] !== callDepth.checker.sha256) {
          throw new Error('SBF_CALL_DEPTH_CHECKER_HASH_MISMATCH: receipt checker differs from the build input snapshot');
        }
        verifyFinalSbfArtifactReceipt(callDepth, `${stem}.so`);
        if (callDepth.artifact.sha256 !== hash(`${stem}.so`) ||
            callDepth.artifact.byteLength !== fs.statSync(`${stem}.so`).size) {
          throw new Error('SBF_CALL_DEPTH_ELF_HASH_MISMATCH: call-depth receipt differs from the final project ELF');
        }
        const publishedManifest = { ...manifestBase, buildRunId, sbfCallDepth: callDepth };
        manifestTemporary = `${stem}.manifest.${callDepth.runId}.tmp`;
        fs.writeFileSync(manifestTemporary, JSON.stringify(publishedManifest, null, 2) + '\n');
        fs.renameSync(manifestTemporary, `${stem}.manifest.json`);
        manifestTemporary = null;
        return publishedManifest;
      }, { buildRunId });
    console.log(`Largest value: ${resources.largestNativeBytes}/1536 native bytes, ${resources.largestWireBytes}/1024 wire bytes; largest frame: ${stack.maxFrameBytes}/4096 bytes`);
    console.log(`Built ${stem}.so (${manifest.elfBytes} bytes), interface and source manifest`);
    return manifest;
  } catch (error) {
    if (manifestTemporary) fs.rmSync(manifestTemporary, { force: true });
    const archivedElf = quarantineFailedElf(stem, buildRunId);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${archivedElf ? `; failed ELF archived at ${archivedElf}` : ''}`);
  }
}

if(import.meta.main) {
  const args=process.argv.slice(2);
  const targetIndex=args.indexOf('--target');
  const target=targetIndex<0?undefined:args[targetIndex+1];
  if(targetIndex>=0)args.splice(targetIndex,2);
  const [source,root,stem,layout,...extra]=args;
  if(!source||!root||!stem||extra.length||(targetIndex>=0&&!PROGRAM_TARGETS.includes(target as ProgramTarget))) {
    console.error('Usage: bun scripts/program.ts PROOF.bend namespace.function output-stem [storage-layout.json] [--target fogo-v0|solana-v3]');process.exit(1);
  }
  try {await buildProgram(source,root,stem,layout,target as ProgramTarget|undefined);} catch(e) {console.error(e instanceof Error?e.message:e);process.exit(1);}
}
