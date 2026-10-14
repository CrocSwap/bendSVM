import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

// Regenerate from the current source and pinned, read-only Bend dependency.
const root = process.cwd();
const baseline = root;
const runDirectory = path.resolve(process.env.COLLECTION_CALLER_ARTIFACT_DIR ??
  path.join('build/collection-caller-runs', crypto.randomUUID()));
fs.mkdirSync(runDirectory,{recursive:true});
const stem = path.join(runDirectory,'collection-store');
const payloadPath = path.join(runDirectory,'input.json');
const outputPath = path.join(runDirectory,'result.pending.json');
const reportPath = path.resolve(process.env.COLLECTION_CALLER_RECEIPT_PATH ??
  'build/collection-adapter-contract-refinement.json');
const archive = path.resolve('build/refinement-reports');
const sha = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const expectedRunInventory = {
  'all caller paths return':1,
  'commit consumes an accepted bounded plan':1,
  'commit consumes initialized record 0':1,
  'commit consumes initialized record 1':1,
  'commit consumes initialized state encoding':1,
  'record 0 active record span follows shared contract':1,
  'record 1 active record span follows shared contract':1,
  'ordered refusal and success result':1,
  'outcome field initialized by root':6,
  'reachability: clock':1,'reachability: commit':1,'reachability: context':1,
  'reachability: instruction_decode':1,'reachability: metadata':1,'reachability: open':1,
  'reachability: plan':1,'reachability: record_decode_0':1,'reachability: record_decode_1':1,
  'reachability: record_encode_0':1,'reachability: record_encode_1':1,'reachability: return_data':1,
  'reachability: root':1,'reachability: select_window':1,'reachability: selector':1,
  'reachability: state_decode_initial':1,'reachability: state_decode_stored':1,
  'reachability: state_encode':1,'reachability: state_header_write':1,'reachability: state_payload_write':1,
  'record 0 read within loaded window':1,'record 1 read within loaded window':1,
  'root receives selected length':1,'root receives selected start':1,
  'selected field initialized by accepted select':3,'selection field initialized by selector':5,
  'stage invoked at most once: clock':1,'stage invoked at most once: commit':1,
  'stage invoked at most once: context':1,'stage invoked at most once: instruction_decode':1,
  'stage invoked at most once: metadata':1,'stage invoked at most once: open':1,
  'stage invoked at most once: plan':1,'stage invoked at most once: record_decode_0':1,
  'stage invoked at most once: record_decode_1':1,'stage invoked at most once: record_encode_0':1,
  'stage invoked at most once: record_encode_1':1,'stage invoked at most once: return_data':1,
  'stage invoked at most once: root':1,'stage invoked at most once: select_window':1,
  'stage invoked at most once: selector':1,'stage invoked at most once: state_decode_initial':1,
  'stage invoked at most once: state_decode_stored':1,'stage invoked at most once: state_encode':1,
  'stage invoked at most once: state_header_write':1,'stage invoked at most once: state_payload_write':1,
  'state byte read inside allocation':45,'state byte read precedes all mutations':45,
  'state header byte read inside constant array':20,'write occurs at most once: commit':1,
  'write occurs at most once: return_data':1,'write occurs at most once: state_header_write':1,
  'write occurs at most once: state_payload_write':1,'write order: return_data':1,
  'write order: state_header_write':1,'write order: state_payload_write':1,
};
const expectedEntryInventory = {
  'account loader receives live pointer':3,'all caller paths return':1,
  'dispatch canonical instruction bounds':1,'dispatch count exactly three':1,
  'entry loop stays within three slots':4,'instruction length read uses live pointer':1,
  'ordered refusal and success result':1,'reachability: dispatch':1,'reachability: length_read':1,
  'reachability: load_0':1,'reachability: load_1':1,'reachability: load_2':1,
  'reachability: mode_read':1,'stage invoked at most once: dispatch':1,
  'stage invoked at most once: length_read':1,'stage invoked at most once: load_0':1,
  'stage invoked at most once: load_1':1,'stage invoked at most once: load_2':1,
};
const expectedCallerAssumptions = [
  'Input pointer and serialized allocation bounds are valid under the pinned loader contract. read_account refuses unsupported duplicate markers and produces truthful Account fields; key equality and little-endian reads have their specified byte semantics.',
  'open, codecs, select, plan and checked Bend roots are free of externally observable effects (including CPI, logging and return-data changes) before commit; each modeled stage is required to execute at most once on a path, and repeated invocations reject as unsupported. Helpers and codecs initialize only their specified outputs; failure preserves managed account data.',
  'The parsed open, select, record, plan and commit calls instantiate the shared bend.collection-helper-contracts/v1 typed AST. Successful open outputs feed select; select outputs feed record and plan; plan outputs and accepted record encoders feed commit. Exact object argument spellings are source grammar facts and are not reported as SMT pointer-equality claims. Run also assumes count=3, mode<=1 and initialize=(mode==0), discharged by the exact checked entry dispatch.',
  'The imported commit contract is no-fail under the accepted plan and writes exactly its specified collection bytes. Distinct local scratch objects, account objects and loaded account allocations are disjoint. Return-data syscall has its declared no-result ABI.',
  'Generated headers must match the fixed reviewed byte allowlist, independently of the candidate manifest. This restriction does not prove their bodies: codecs and Bend roots obey their recorded schema and type layouts by assumption. Context constructors and byte-read primitives have their specified pure semantics.',
  'The restricted parser, symbolic executor, Python interpreter, proof driver and Z3 are trusted. Scalar operations outside the modeled unsigned ABI subset reject rather than receive guessed C semantics.',
];

// Clear the canonical path before any operation that can fail. Preserve bytes
// even if archiving fails. Historical JSON is evidence, not a renewed pass.
if (fs.existsSync(reportPath)) {
  const quarantine = `${reportPath}.${crypto.randomUUID()}.quarantine`;
  fs.renameSync(reportPath,quarantine);
  const bytes = fs.readFileSync(quarantine);
  fs.mkdirSync(archive,{recursive:true});
  const archived = path.join(archive,`${crypto.createHash('sha256').update(bytes).digest('hex')}.json`);
  if (!fs.existsSync(archived)) fs.writeFileSync(archived,bytes,{flag:'wx'});
  assert.deepEqual(fs.readFileSync(archived),bytes,'prior caller receipt archive conflict');
  fs.rmSync(quarantine);
}

function captureSource():Record<string,string> {
  const names = ['package.json','package-lock.json','.deps/bend/bend2/base.bend','tests/collection-store.bend','tests/collection-store.json'];
  for(const directory of ['compiler','runtime','sdk','scripts']) {
    const walk = (base:string) => {
      for(const entry of fs.readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        const file=path.join(base,entry.name);
        if(entry.isDirectory() && !['build','target','node_modules','.deps','.git','.fadeno'].includes(entry.name))walk(file);
        else if(/\.(?:ts|bend|json|c|h|ld)$/.test(entry.name))names.push(path.relative(root,file));
      }
    };
    walk(path.join(root,directory));
  }
  return Object.fromEntries([...new Set(names)].sort().map(file=>[file,sha(path.join(root,file))]));
}

const checkerNames = ['collection_adapter_contract.py','collection_caller_syntax.py','collection_caller_paths.py','collection_caller_cases.py','collection_contracts.py','check-collection-adapter-contract.ts'];
const checkerAtStart = Object.fromEntries(checkerNames.map(name=>[`verification/${name}`,sha(path.resolve('verification',name))]));

async function emitFromSnapshot() {
  const dep = path.join(baseline,'.deps','bend','bend2','base.bend');
  assert(fs.existsSync(dep),'Pinned Bend source is missing from the copied safety snapshot dependency closure');
  const bendRoot = path.join(baseline,'.deps','bend');
  const rev = spawnSync('git',['-C',bendRoot,'rev-parse','HEAD'],{encoding:'utf8'});
  const dirty = spawnSync('git',['-C',bendRoot,'status','--porcelain'],{encoding:'utf8'});
  assert.equal(rev.status,0,'Pinned Bend dependency is not a Git checkout');
  assert.equal(rev.stdout.trim(),'7561656155a4285c1e4ccfcb3505ab59524de973','Bend dependency is not at the pinned commit');
  assert.equal(dirty.status,0,'Bend cleanliness check failed');
  assert.equal(dirty.stdout.trim(),'','Shared Bend dependency must be clean');
  const cwd = process.cwd();
  try {
    process.chdir(baseline);
    const preSource = captureSource();
    const backendPath = pathToFileURL(path.join(baseline,'compiler/backend.ts')).href;
    const artifactsPath = pathToFileURL(path.join(baseline,'compiler/artifacts.ts')).href;
    const {checkedProgram,Backend} = await import(backendPath);
    const {writeArtifacts} = await import(artifactsPath);
    const source = path.join(baseline,'tests/collection-store.bend');
    const layoutPath = path.join(baseline,'tests/collection-store.json');
    const checked = await checkedProgram(source);
    const layout = JSON.parse(fs.readFileSync(layoutPath,'utf8'));
    const emitted = new Backend(checked.book).emit(['process','select']);
    assert.deepEqual(captureSource(),preSource,'source drift during checked emission');
    writeArtifacts(stem,emitted,'process',layout);

    const scriptProgram = path.join(baseline,'scripts/program.ts');
    const scriptBuild = path.join(baseline,'scripts/build.ts');
    const support = ['scripts/program.ts','scripts/build.ts','package.json','package-lock.json',
      ...['compiler','runtime','sdk'].flatMap(dir=>fs.readdirSync(path.join(baseline,dir))
        .filter(f=>/\.(?:ts|c|h|ld)$/.test(f)).map(f=>`${dir}/${f}`))];
    const relative = (p:string) => {
      const absolute = path.resolve(p);
      const local = path.relative(baseline,absolute);
      if (!local.startsWith(`..${path.sep}`) && local !== '..') return local;
      const marker = `${path.sep}.deps${path.sep}`;
      const markerAt = absolute.lastIndexOf(marker);
      const repo = markerAt >= 0 ? `.deps/${absolute.slice(markerAt + marker.length).split(path.sep).join('/')}` : '';
      assert(repo === '.deps/bend/bend2/base.bend' || repo.startsWith('.deps/bend/'),
        `Checked source escaped the copied baseline: ${absolute}`);
      return repo;
    };
    const inputs = [...new Set([...checked.files,source,layoutPath,scriptProgram,scriptBuild,
      ...support.map(p=>path.join(baseline,p))].map(relative))].sort();
    const inputsHash:Record<string,string> = {};
    for (const file of inputs) {
      assert.equal(sha(path.join(baseline,file)),preSource[file],`checked input absent or changed from pre-emission source: ${file}`);
      inputsHash[file] = preSource[file]!;
    }
    const bendBase = path.join(baseline,'.deps/bend/bend2/base.bend');
    inputsHash['.deps/bend/bend2/base.bend'] = sha(bendBase);
    const artifacts:Record<string,string> = {};
    for (const suffix of ['.c','.h','.schema.json','.interface.json','.wire.h']) artifacts[suffix] = sha(stem+suffix);
    const manifest = {version:1,source:'tests/collection-store.bend',root:'process',
      bendCommit:'7561656155a4285c1e4ccfcb3505ab59524de973',inputs:inputsHash,artifacts};
    fs.writeFileSync(stem+'.manifest.json',JSON.stringify(manifest,null,2)+'\n');
  } finally {
    process.chdir(cwd);
  }
}

await emitFromSnapshot();

const paths = {
  adapterPath:stem+'.c', headerPath:stem+'.h', wirePath:stem+'.wire.h',
  schemaPath:stem+'.schema.json', interfacePath:stem+'.interface.json', manifestPath:stem+'.manifest.json',
};
for (const [label,file] of Object.entries(paths)) assert(fs.existsSync(file),
  `Missing ${label}; provide the pinned Bend dependency under the copied snapshot or generate the collection-store artifact from that snapshot`);

// Resolve every quoted/system include from the written artifact using the
// build-directory then runtime-directory search used by the compiler driver.
const includeFiles:Record<string,string> = {};
const pending:[string,string][] = [['collection-store.c',paths.adapterPath]];
while (pending.length) {
  const [name,file] = pending.pop()!;
  const resolved = path.resolve(file);
  if (includeFiles[name]) {
    assert.equal(path.resolve(includeFiles[name]),resolved,`Ambiguous include binding: ${name}`);
    continue;
  }
  includeFiles[name] = resolved;
  const text = fs.readFileSync(resolved,'utf8');
  for (const m of text.matchAll(/^\s*#include\s*["<]([^">\n]+)[">]\s*$/gm)) {
    const include = m[1];
    const candidates = name === 'collection-store.c'
      ? [path.join(path.dirname(resolved),include),path.join(baseline,'runtime',include)]
      : name === 'collection-store.wire.h'
        ? [path.join(path.dirname(resolved),include)]
        : [path.join(path.dirname(resolved),include),path.join(baseline,'runtime',include)];
    const found = candidates.find(p=>fs.existsSync(p));
    assert(found,`${name}: unresolved include ${include}`);
    pending.push([include,found]);
  }
}

const manifest = JSON.parse(fs.readFileSync(paths.manifestPath,'utf8'));
const immutableSources:Record<string,string> = {};
const unavailableManifestInputs:string[] = [];
for (const [name,digest] of Object.entries(manifest.inputs) as [string,string][]) {
  const file = path.join(baseline,name);
  if (name.startsWith('.deps/') && !fs.existsSync(file)) {
    unavailableManifestInputs.push(name);
    continue;
  }
  assert(fs.existsSync(file),`Manifest source is missing from copied snapshot: ${name}`);
  immutableSources[name] = file;
  assert.equal(sha(file),digest,`Snapshot source hash differs from artifact manifest: ${name}`);
}
assert.equal(unavailableManifestInputs.length,0,
  `Cannot claim exact input hashes with unavailable manifest sources: ${unavailableManifestInputs.join(', ')}`);
const checkerFiles = {
  ...Object.fromEntries(['collection_adapter_contract.py','collection_caller_syntax.py','collection_caller_paths.py','collection_caller_cases.py','collection_contracts.py'].map(name=>[`verification/${name}`,path.resolve('verification',name)])),
  'verification/check-collection-adapter-contract.ts':path.resolve('verification/check-collection-adapter-contract.ts'),
};
assert.deepEqual(Object.fromEntries(Object.entries(checkerFiles).map(([name,file])=>[name,sha(file)])),checkerAtStart,
  'checker drift during source generation');
const initial = {
  artifact: Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,sha(v)])),
  closure: Object.fromEntries(Object.entries(includeFiles).map(([k,v])=>[k,sha(v)])),
  snapshot: Object.fromEntries(Object.entries(immutableSources).map(([k,v])=>[k,sha(v)])),
  checker: Object.fromEntries(Object.entries(checkerFiles).map(([k,v])=>[k,sha(v)])),
};
const payload = {
  version:1, baselineRoot:baseline, ...paths, includeFiles, immutableSources, unavailableManifestInputs, checkerFiles,
};
fs.writeFileSync(payloadPath,JSON.stringify(payload,null,2)+'\n');

const python = process.env.PYTHON ?? 'python3';
// The interpreter and installed Z3 remain trusted. Record the actual selected
// interpreter; execute our four bound modules directly from source so stale or
// substituted __pycache__ entries cannot silently replace a checked module.
const interpreterInfo = () => {
  const probe=spawnSync(python,['-I','-B','-c','import json,sys; print(json.dumps({"executable":sys.executable,"version":sys.version}))'],{encoding:'utf8',timeout:30_000});
  assert.equal(probe.status,0,'Python interpreter preflight failed');
  const metadata=JSON.parse(probe.stdout);
  const executable=fs.realpathSync(metadata.executable);
  const selected = python.includes(path.sep) ? path.resolve(python) : (() => {
    const found=spawnSync('which',[python],{encoding:'utf8'});
    assert.equal(found.status,0,'cannot resolve selected PYTHON command');
    return found.stdout.trim();
  })();
  const selectedRealPath=fs.realpathSync(selected);
  return {...metadata,executable,sha256:sha(executable),
    selectedCommand:python,selectedPath:selected,selectedRealPath,selectedSha256:sha(selectedRealPath),
    scope:'Selected command and self-reported interpreter are trusted; these hashes do not prove a wrapper delegated faithfully.'};
};
const interpreterAtStart=interpreterInfo();
const bootstrap = `import pathlib,sys,types
base=pathlib.Path(sys.argv[1])
sys.argv=[str(base/'collection_adapter_contract.py'),*sys.argv[2:]]
for name in ('collection_contracts','collection_caller_syntax','collection_caller_paths','collection_caller_cases','collection_adapter_contract'):
    file=base/(name+'.py')
    module=types.ModuleType(name if name!='collection_adapter_contract' else '__main__')
    module.__file__=str(file)
    sys.modules[name]=module
    exec(compile(file.read_bytes(),str(file),'exec'),module.__dict__)
`;
const callerChildTimeout = Number(process.env.COLLECTION_CALLER_CHILD_TIMEOUT_MS ?? 900_000);
assert(Number.isSafeInteger(callerChildTimeout) && callerChildTimeout > 0,'caller child timeout must be a positive integer');
const child = spawnSync(python,['-I','-B','-c',bootstrap,path.resolve('verification'),payloadPath,outputPath],
  {encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:callerChildTimeout,maxBuffer:16*1024*1024});
if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
assert.equal(child.error,undefined,`Could not start Python verifier: ${child.error?.message}`);
assert.equal(child.status,0,`Collection caller contract exited ${child.status ?? 'without a status'}`);
assert(fs.existsSync(outputPath),'Python verifier returned zero without writing a report');
const report = JSON.parse(fs.readFileSync(outputPath,'utf8'));
assert.equal(report.passed,true,'Python verifier did not issue passed:true');
assert.equal(report.format,'bend.collection-caller-paths/v3','caller receipt format mismatch');
assert.equal(report.compositionRunId,process.env.COLLECTION_COMPOSITION_RUN_ID ?? null,
  'caller report belongs to a different composition run');
assert.equal(report.contractInterface?.format,'bend.collection-helper-contracts/v1');
assert.match(report.contractInterfaceHash,/^[0-9a-f]{64}$/);
assert.equal(report.payloadSha256,sha(payloadPath),'child result must bind this invocation payload');
const expectedChildHashes = {
  ...Object.fromEntries(Object.entries(includeFiles).sort().map(([name,file])=>[name,sha(file)])),
  ...Object.fromEntries(Object.entries(paths).map(([name,file])=>[`artifact:${name}`,sha(file)])),
  ...Object.fromEntries(Object.entries(immutableSources).map(([name,file])=>[name,sha(file)])),
  ...Object.fromEntries(Object.entries(checkerFiles).map(([name,file])=>[name,sha(file)])),
};
assert.deepEqual(report.inputs.before,expectedChildHashes,'child input hash binding');
assert.deepEqual(report.inputs.before,report.inputs.after,'child input drift');
assert.deepEqual(report.inputs.manifest,manifest.inputs,'child manifest binding');
assert.deepEqual(Object.keys(report.proofs).sort(),['entry','run']);
for(const proofs of Object.values(report.proofs) as any[][]) {
  assert(proofs.length>0 && proofs.every(p=>typeof p.name==='string' && p.result==='unsat'),'missing proved obligations');
}
assert.equal(report.proofs.entry.length,23,'entry obligation inventory changed');
assert.equal(report.proofs.run.length,183,'run obligation inventory changed');
function labelInventory(proofs:any[]) {
  const counts:Record<string,number> = {};
  for(const claim of proofs) counts[claim.name]=(counts[claim.name]??0)+1;
  return Object.fromEntries(Object.entries(counts).sort(([a],[b])=>a.localeCompare(b)));
}
assert.deepEqual(labelInventory(report.proofs.run),expectedRunInventory,'caller run obligation inventory changed');
assert.deepEqual(labelInventory(report.proofs.entry),expectedEntryInventory,'caller entry obligation inventory changed');
assert.deepEqual(report.assumptions,expectedCallerAssumptions,'caller assumption inventory/text changed');
const expectedObservations = [
  {function:'bend_collection_open',arguments:['&accounts[2]','program','state->key','collection_header','4','initialize','&collection'],statusInput:'open_error',pointerResult:null},
  {function:'bend_collection_select',arguments:['&collection','selection.as.c1.f0.as.c0.f0','selection.as.c1.f0.as.c0.f1','2','&selected'],statusInput:'select_ok',pointerResult:null},
  {function:'bend_collection_record',arguments:['&collection','&selected','0'],statusInput:null,pointerResult:'record_pointer_0'},
  {function:'bend_collection_record',arguments:['&collection','&selected','1'],statusInput:null,pointerResult:'record_pointer_1'},
  {function:'bend_collection_plan',arguments:['&collection','&selected','written','next'],statusInput:'plan_ok',pointerResult:null},
  {function:'bend_collection_commit',arguments:['&collection','&selected','written','next','encoded_records','collection_header','state->key'],statusInput:null,pointerResult:null},
];
assert(Array.isArray(report.callObservations),'parsed helper observations missing');
assert.deepEqual(report.callObservations.map((row:any)=>({function:row.function,arguments:row.arguments,
  statusInput:row.statusInput??null,pointerResult:row.pointerResult??null})),expectedObservations,
  'parsed helper call observation inventory changed');
assert(report.callObservations.every((row:any,index:number)=>row.ordinal===index &&
  typeof row.pathCondition==='string' && row.pathCondition.length>0),
  'parsed observation must retain its path condition and call ordinal');
assert.deepEqual(Object.keys(report.artifactPaths).sort(),[
  'collection-store.c','collection-store.h','collection-store.interface.json',
  'collection-store.manifest.json','collection-store.schema.json','collection-store.wire.h',
].sort(),'generated artifact path inventory changed');
const expectedArtifactPaths = Object.fromEntries([
  ['collection-store.c',paths.adapterPath],['collection-store.h',paths.headerPath],
  ['collection-store.wire.h',paths.wirePath],['collection-store.schema.json',paths.schemaPath],
  ['collection-store.interface.json',paths.interfacePath],['collection-store.manifest.json',paths.manifestPath],
].map(([name,file])=>[name,path.resolve(file!)]));
assert.deepEqual(report.artifactPaths,expectedArtifactPaths,'caller artifact paths differ from this fresh emission');
assert.deepEqual(report.includePaths,Object.fromEntries(Object.entries(includeFiles)
  .map(([name,file])=>[name,path.resolve(file)])),'caller include paths differ from the resolved generated-C closure');
const expectedCases = [
  ...Array.from({length:6},(_,i)=>`dead nested guard ${i}`),
  'conditional commit','conditional state payload','conditional return data',
  'length assigned after root','signature arguments swapped','clock layout reordered',
  'entry nested dead count','entry nested dead loader','entry nested dead alias','entry nested dead instruction',
  'entry wrong program argument','plan arguments swapped','wrong output state buffer','narrowed next declaration','signed overflow guard','state writes reordered',
  'octal-size','truncated-size','truncated-count','truncated-length','left-association','post-write-read',
  'shadow-before','shadow-selected','scope-before','scope-collection','scope-instruction',
  'plan repeated after return data','plan repeated after commit','entry double dispatch',
  'header read out of bounds','alternate zero decoder input outside abstraction',
];
assert.deepEqual(report.mutations.map((m:any)=>m.name),expectedCases,'mutation inventory changed');
for(const mutation of report.mutations) {
  assert(['grammar','semantic'].includes(mutation.kind));
  if(mutation.kind==='semantic')assert(typeof mutation.claim==='string' && Object.keys(mutation.counterexample).length>0,'semantic rejection requires a derived model');
  else assert(typeof mutation.reason==='string' && mutation.reason.length>0);
}
assert.equal(report.equivalentVariants,7);
assert.equal(report.assumptions.length,6);
assert.deepEqual(report.generatedHeaderContractRevision,{
  'collection-store.h':'6712d216dac31c9e70ac1aca98b40b380895acc8196f870d56e464c705f532f6',
  'collection-store.wire.h':'a01209ca535642ed70f95133f8eead5ddc6915c17d31b5dba3608dda219acfa6',
});
assert.deepEqual(report.runtimeContractRevision,{
  'bend_collection_runtime.h':'e4e000b47f08426e4cb7353b5edaf2cfa1e8cda0beb29838b43726c69bee3f78',
  'solana_min.h':'103aa5bd910cf4f0b29dbe8d1b956a6bb7d6cb90e79f156a17857a05b18b8b06',
});

const final = {
  artifact:Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,sha(v)])),
  closure:Object.fromEntries(Object.entries(includeFiles).map(([k,v])=>[k,sha(v)])),
  snapshot:Object.fromEntries(Object.entries(immutableSources).map(([k,v])=>[k,sha(v)])),
  checker:Object.fromEntries(Object.entries(checkerFiles).map(([k,v])=>[k,sha(v)])),
};
assert.deepEqual(final,initial,'An artifact, include, source or checker input changed during verification');
assert.deepEqual(interpreterInfo(),interpreterAtStart,'Python interpreter drift');
const bendEnd=spawnSync('git',['-C',path.join(baseline,'.deps/bend'),'status','--porcelain'],{encoding:'utf8'});
const bendRevisionEnd=spawnSync('git',['-C',path.join(baseline,'.deps/bend'),'rev-parse','HEAD'],{encoding:'utf8'});
assert.equal(bendEnd.status,0,'final Bend cleanliness check failed');
assert.equal(bendEnd.stdout.trim(),'','Bend dependency changed during verification');
assert.equal(bendRevisionEnd.status,0,'final Bend revision check failed');
assert.equal(bendRevisionEnd.stdout.trim(),'7561656155a4285c1e4ccfcb3505ab59524de973','Bend revision drift');
report.trustedInterpreter=interpreterAtStart;
fs.writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n');
fs.renameSync(outputPath,reportPath);
console.log(`Passed report: ${reportPath}`);
