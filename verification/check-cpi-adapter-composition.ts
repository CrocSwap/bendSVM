import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const cwd = process.cwd();
const sourceRoot = path.resolve(process.env.BEND_CPI_ADAPTER_SOURCE_ROOT ?? cwd);
const directory = path.resolve('build/cpi-adapter-composition');
const reportPath = path.resolve('build/cpi-adapter-composition-refinement.json');
const archiveRoot = path.resolve('build/refinement-reports');
const quarantineRoot = path.join(directory, 'quarantined-prior-reports');
const hostTimeoutMs = 600_000;
const python = process.env.PYTHON ?? 'python3';
const sha = (data:Buffer|string) => crypto.createHash('sha256').update(data).digest('hex');
const readHash = (file:string) => sha(fs.readFileSync(file));

const inputRelatives = [
  'verification/multi_adapter_contract.py',
  'verification/adapter_contract_c.py',
  'verification/adapter_contract_sym.py',
  'verification/effect_extraction.py',
  'verification/cpi_composition.py',
  'verification/cpi_validate.py',
  'verification/check-multi-adapter-contract.ts',
  'verification/check-cpi-composition.ts',
  'compiler/backend.ts',
  'compiler/artifacts.ts',
  'compiler/multi-storage.ts',
  'compiler/storage.ts',
  'compiler/schema.ts',
  'compiler/effects.ts',
  'compiler/cpi-effects.ts',
  'compiler/collection-storage.ts',
  'compiler/codecs.ts',
  'compiler/dispatch.ts',
  'compiler/resources.ts',
  'compiler/diagnostics.ts',
  'compiler/primitives.ts',
  'compiler/native-arithmetic.ts',
  'compiler/tagged-sum-ir.ts',
  'runtime/bend_cpi.h',
  'runtime/cpi_abi.h',
  'runtime/solana_min.h',
];

function sourceHashes():Record<string,string> {
  return Object.fromEntries(inputRelatives.map(relative => {
    const file = path.resolve(sourceRoot, relative);
    assert(fs.existsSync(file), 'missing current source input ' + file);
    return [file, readHash(file)];
  }));
}

function requireZero(result:ReturnType<typeof spawnSync>, label:string):void {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(label + ' failed with status ' + String(result.status) + ': ' +
      (result.stderr || result.stdout));
  }
}

function assertReceipt(report:any, payload:any, payloadDigest:string,
                       hashesAtStart:Record<string,string>):void {
  assert.equal(report.passed, true, 'child receipt must be complete');
  assert.equal(report.z3, '5.1.0', 'Z3 version');
  assert.equal(report.inputs.runNonce, payload.runNonce, 'per-run nonce');
  assert.equal(report.inputs.payloadSha256, payloadDigest, 'exact generated fixture payload');
  assert.equal(report.inputs.sourceRoot, sourceRoot);
  assert.deepEqual(report.inputs.immutableSourceAndArtifactInputs, payload.immutableInputs);
  assert.deepEqual(report.inputs.reusedSourceHashes, hashesAtStart);
  assert.deepEqual(report.inputs.checkerHashes, {
    [path.resolve('verification/cpi_adapter_composition.py')]:
      readHash(path.resolve('verification/cpi_adapter_composition.py')),
    [path.resolve('verification/check-cpi-adapter-composition.ts')]:
      readHash(path.resolve('verification/check-cpi-adapter-composition.ts')),
  });
  assert.equal(report.coverage.length, 3);
  assert.deepEqual(report.coverage.map((fixture:any) => fixture.fixture), ['cpi-2','cpi-3','cpi-4']);
  assert.deepEqual(report.coverage.map((fixture:any) => fixture.managedStates), [2,3,4]);
  assert(report.coverage.every((fixture:any) => fixture.effectSlots === 2));
  assert.equal(report.conditionalConnection.fixtures.length, 3);
  for (const fixture of report.conditionalConnection.fixtures) {
    assert(fixture.managedStatePreflightAndAliases.witnessedStages.includes('distinct-accounts'));
    assert.equal(fixture.callBridge.result, 'proved on parsed emitted entrypoint paths');
    assert.deepEqual(fixture.callBridge.validatedSlots, [0,1]);
    assert.equal(fixture.callBridge.allReachedValidationCallsChecked,true);
    assert(fixture.callBridge.accountCountPrecondition.includes(
      'every reached validator event, including a nonzero-return early-exit path'));
    assert.equal(fixture.metaLoopBridge.result,
      'UNSAT for each emitted CPI slot with the legacy assumptions removed');
    assert.equal(fixture.metaLoopBridge.slots.length, 2);
    assert(fixture.effectStability.result.includes('no assignment'));
    assert.equal(fixture.cpiAssumptionAudit.result,
      'exact complete axiom inventories; no built-in CPI assumptions in composition');
    const expectedQueries = [
      'bridge: execution reachable before every validation returned zero',
      'bridge: validator/executor arguments differ from each other or the parsed loader count',
      'bridge: executor bump differs from the successful custody output',
      'bridge: a reached validator call is outside caller account_count 4..12',
      ...[0,1].flatMap(slot => [
        `bridge: slot ${slot} helper return instantiation`,
        `bridge: slot ${slot} meta loop bound is not its own extracted effect count`,
        `bridge: slot ${slot} meta reads lack the validated active count bound`,
      ]),
    ];
    assert.deepEqual(fixture.bridgeSolverQueries.map((query:any) => query.name),expectedQueries);
    for (const query of fixture.bridgeSolverQueries) {
      assert.equal(query.result,'unsat');
      assert.match(query.querySha256,/^[0-9a-f]{64}$/);
    }
    assert.equal(fixture.cpiPremiseProofs.length,2);
    assert(fixture.cpiPremiseProofs.every((proof:any) => proof.result === 'unsat'));
    assert.equal(fixture.accountArraySizeRefresh.postExecutionSizeReadCount,0);
    assert(fixture.accountArraySizeRefresh.result.includes('no post-execution Account.size reads'));
  }
  assert(report.conditionalConnection.validatorComponent.conditionalFacts.some(
    (fact:any) => fact.name === 'active success bounds meta count to 8' && fact.result === 'unsat'));
  assert.equal(
    report.conditionalConnection.executorComponent.actualRuntimeBody.result,
    'accepted restricted live-body grammar',
  );
  assert(report.conditionalConnection.executorComponent.inactiveEffect.includes('before reading'));
  assert.equal(report.mutations.semanticCounterexamples.length, 9);
  assert(report.mutations.semanticCounterexamples.every((mutation:any) =>
    mutation.kind === 'semantic' && mutation.counterexample && mutation.reason));
  const requiredMutants = [
    'wrong validation effect slot',
    'wrong validation count',
    'constant custody bump',
    'dropped CPI validation',
    'truncated validation status width',
    'validation status checked after managed-state scan',
    'meta loop takes count from a different effect slot',
    'execute before every validation succeeds',
    'managed account alias preflight removed',
  ].sort();
  assert.deepEqual(
    report.mutations.semanticCounterexamples.map((mutation:any) => mutation.name).sort(),
    requiredMutants,
  );
  const negatives = report.mutations.bridgeNegatives;
  assert.equal(negatives.scope,'local sensitivity checks; observation faults are not emitted-C mutants');
  const requiredQueries = new Map([
    ['status','bridge: execution reachable before every validation returned zero'],
    ['count','bridge: validator/executor arguments differ from each other or the parsed loader count'],
    ['bump','bridge: executor bump differs from the successful custody output'],
    ['range','bridge: a reached validator call is outside caller account_count 4..12'],
    ['loop','bridge: slot 0 meta loop bound is not its own extracted effect count'],
    ['meta','bridge: slot 0 meta reads lack the validated active count bound'],
  ]);
  assert.deepEqual(negatives.observationFaults.map((item:any) => item.kind).sort(),
    [...requiredQueries.keys()].sort());
  for (const item of negatives.observationFaults) {
    assert.equal(item.query,requiredQueries.get(item.kind));
    assert.equal(item.survivesWithSpecificQueryDisabled,true);
    assert(item.counterexample.completeModel.length > 0);
  }
  assert.equal(negatives.accountArrayCMutation.legacyInterpreterAccepted,true);
  assert.equal(negatives.accountArrayCMutation.reason,
    'bridge: validator does not receive the parsed accounts array and its extracted transfers[slot]');
  assert(negatives.accountArrayCMutation.counterexample.completeModel.length > 0);
  assert.equal(negatives.unconditionalAssumptionMutation.legacyInterpreterAccepted,true);
  assert(negatives.unconditionalAssumptionMutation.reason.includes(
    'exposed assumptions differ from the exact active-success/count implication'));
  assert(negatives.removedHelperLink.reason.includes(
    'active validator success did not bound the exact adapter count'));
  assert(negatives.removedHelperLink.counterexample.completeModel.length > 0);
  assert(report.mutations.grammarRejections.length >= 1);
  assert(report.mutations.grammarRejections.every((mutation:any) =>
    mutation.kind === 'grammar' && mutation.reason && !mutation.counterexample));
  assert(report.equivalents.length >= 4);
  assert(report.equivalents.every((variant:any) => variant.result === 'accepted'));
  assert(report.equivalents.some((variant:any) => variant.name === 'hoisted local meta count'));
  assert(report.equivalents.some((variant:any) => variant.name === 'scalar count hoisted before validation'));
  assert.equal(report.solverFailureBehavior.parentNonzeroProbeRejected, true);
  assert.equal(report.solverFailureBehavior.partialReceiptProbeRejected, true);
  assert.equal(report.solverFailureBehavior.forcedUnknownRejected, true);
  for (const probe of [
    'archivedReportReplayRejected','archiveFailureQuarantinesOldReport',
    'fullChildReportThenNonzeroRejected','fullChildReportThenSignalRejected',
    'malformedMinimalChildRejected',
  ]) assert.equal(report.solverFailureBehavior[probe],true,probe);
  assert(report.outcomeScope.runtimeOrCpiAbort.includes('outside'));
  assert(report.outcomeScope.externalAccountContents.includes('may have changed'));

  const fixtureNames = new Set(['cpi-2','cpi-3','cpi-4']);
  assert.deepEqual(new Set(payload.fixtures.map((fixture:any) => fixture.name)), fixtureNames);
  for (const fixture of payload.fixtures) {
    assert.equal(fixture.helperRuntimeRoot,path.resolve(sourceRoot,'runtime'));
    assert.deepEqual(report.inputs.helperRuntimeIncludeClosureByFixture.find(
      (item:any) => item.fixture === fixture.name), {
        fixture:fixture.name,
        selectedSourceRoot:fixture.helperRuntimeRoot,
        files:fixture.helperRuntimeFiles,
      },fixture.name + ': selected helper include closure');
    for (const [name,item] of Object.entries(fixture.helperRuntimeFiles) as [string,any][]) {
      assert.equal(item.path,path.resolve(sourceRoot,'runtime',name));
      assert.equal(readHash(item.path),item.sha256);
    }
    for (const [file, digest] of Object.entries(fixture.artifactHashes) as [string,string][]) {
      assert.equal(readHash(file), digest, fixture.name + ': artifact ' + file);
    }
    for (const [name, file] of Object.entries(fixture.artifactPaths) as [string,string][]) {
      assert(fs.existsSync(file), fixture.name + ': artifact path ' + name);
    }
  }
  for (const [file, digest] of Object.entries(payload.immutableInputs) as [string,string][]) {
    assert.equal(readHash(file), digest, 'immutable input ' + file);
  }
}

async function buildPayload(runNonce:string) {
  const bendPath = path.resolve(sourceRoot, '.deps/bend');
  const revision = spawnSync('git', ['-C', bendPath, 'rev-parse', 'HEAD'], {encoding:'utf8'});
  requireZero(revision, 'pinned Bend revision query');
  assert.equal(revision.stdout.trim(), '7561656155a4285c1e4ccfcb3505ab59524de973');
  const dirty = spawnSync('git', ['-C', bendPath, 'status', '--porcelain', '--untracked-files=all'],
    {encoding:'utf8'});
  requireZero(dirty, 'pinned Bend status query');
  assert.equal(dirty.stdout.trim(), '', 'Bend dependency must be clean');

  const backendPath = pathToFileURL(path.resolve(sourceRoot, 'compiler/backend.ts')).href;
  const artifactsPath = pathToFileURL(path.resolve(sourceRoot, 'compiler/artifacts.ts')).href;
  const {Backend, checkedProgram} = await import(backendPath);
  const {writeArtifacts} = await import(artifactsPath);
  const selected = [
    ['cpi-2','tests/cpi-multi.bend','process','tests/cpi-multi.layout.json'],
    ['cpi-3','tests/cpi-multi-3.bend','process','tests/cpi-multi-3.layout.json'],
    ['cpi-4','tests/cpi-multi-4.bend','process','tests/cpi-multi-4.layout.json'],
  ] as const;
  const fixtures:any[] = [];
  const immutableInputs:Record<string,string> = {};
  fs.mkdirSync(directory, {recursive:true});

  for (const [name, sourceRelative, root, layoutRelative] of selected) {
    const source = path.resolve(sourceRoot, sourceRelative);
    const layoutPath = path.resolve(sourceRoot, layoutRelative);
    const checked = await checkedProgram(source);
    const emitted = new Backend(checked.book).emit([root]);
    const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
    const stem = path.join(directory, name);
    writeArtifacts(stem, emitted, root, {stateAccounts:layout.stateAccounts});
    const directNames = [
      name + '.c', name + '.h', name + '.wire.h', name + '.dispatch.h',
      name + '.schema.json', name + '.interface.json', name + '.resources.json',
    ];
    const artifactPaths:Record<string,string> = {};
    for (const artifact of directNames) {
      const file = stem + artifact.slice(name.length);
      assert(fs.existsSync(file), name + ': missing compiler artifact ' + file);
      artifactPaths[artifact] = path.resolve(file);
    }
    const files:Record<string,string> = {};
    const pending = [{name:name + '.c', file:artifactPaths[name + '.c']}];
    while (pending.length) {
      const item = pending.pop()!;
      const resolved = path.resolve(item.file);
      if (item.name in files) {
        assert.equal(path.resolve(artifactPaths[item.name]), resolved,
          name + ': ambiguous include binding ' + item.name);
        continue;
      }
      artifactPaths[item.name] = resolved;
      files[item.name] = fs.readFileSync(resolved, 'utf8');
      for (const match of files[item.name].matchAll(/^[ \t]*#[ \t]*include[ \t]*(["<])([^">\n]+)[">]/gm)) {
        const candidates = match[1] === '"'
          ? [path.dirname(resolved), path.resolve('build'), path.resolve(sourceRoot, 'runtime')]
          : [path.resolve('build'), path.resolve(sourceRoot, 'runtime')];
        const found = candidates.map(dir => path.join(dir, match[2])).find(file => fs.existsSync(file));
        assert(found, name + ': unresolved emitted include ' + match[2]);
        pending.push({name:match[2], file:found});
      }
    }
    const schema = JSON.parse(fs.readFileSync(artifactPaths[name + '.schema.json'], 'utf8'));
    const iface = JSON.parse(fs.readFileSync(artifactPaths[name + '.interface.json'], 'utf8'));
    assert.equal(iface.version, 2, name + ': compiler did not emit ABI2');
    assert.equal(iface.effects, 'cpi-v1', name + ': not a pure-CPI fixture');
    assert.equal(iface.stateAccounts.length, Number(name.at(-1)), name + ': state account count');
    assert.equal(iface.minimumAccounts, Number(name.at(-1)) + 3, name + ': minimum account count');
    assert.equal(iface.maximumAccounts, 12, name + ': maximum account count');
    const helperRuntimeNames = ['bend_cpi.h','cpi_abi.h','solana_min.h'];
    for (const helper of helperRuntimeNames) {
      assert(files[helper], name + ': missing helper runtime include ' + helper);
      assert.equal(path.resolve(artifactPaths[helper]),
        path.resolve(sourceRoot,'runtime',helper),
        name + ': helper runtime include did not come from selected sourceRoot: ' + helper);
    }
    for (const file of [...checked.files, source, layoutPath, ...Object.values(artifactPaths)]) {
      const absolute = path.resolve(file);
      immutableInputs[absolute] = readHash(absolute);
    }
    fixtures.push({
      name, source, root, layoutPath, adapter:name + '.c',
      files, schema, interface:iface, artifactPaths,
      helperRuntimeRoot:path.resolve(sourceRoot,'runtime'),
      helperRuntimeFiles:Object.fromEntries(helperRuntimeNames.map(helper => [
        helper,{path:path.resolve(artifactPaths[helper]),sha256:readHash(artifactPaths[helper])},
      ])),
      artifactHashes:Object.fromEntries(Object.values(artifactPaths)
        .map(file => [path.resolve(file), readHash(file)])),
      schemaSha256:readHash(artifactPaths[name + '.schema.json']),
      interfaceSha256:readHash(artifactPaths[name + '.interface.json']),
      sourceDependencies:Object.fromEntries([...new Set([...checked.files,source,layoutPath])]
        .map(file => [path.resolve(file), readHash(path.resolve(file))])),
    });
  }

  const currentSources = sourceHashes();
  for (const [file, digest] of Object.entries(currentSources)) immutableInputs[file] = digest;
  for (const file of [
    path.resolve('verification/cpi_adapter_composition.py'),
    path.resolve('verification/check-cpi-adapter-composition.ts'),
  ]) {
    assert(fs.existsSync(file), 'missing checker input ' + file);
    immutableInputs[file] = readHash(file);
  }
  return {
    fixtures, immutableInputs, currentSources, runNonce,
    bend:{revision:revision.stdout.trim(), status:dirty.stdout.trim()},
  };
}

function archivePriorReport(priorPath:string, archiveDirectory:string,
                            quarantineDirectory:string, runNonce:string):any {
  if (!fs.existsSync(priorPath)) return null;
  fs.mkdirSync(quarantineDirectory, {recursive:true});
  const quarantined = path.join(quarantineDirectory, runNonce + '.json');
  assert.equal(fs.existsSync(quarantined), false, 'run quarantine path must be unique');
  // Move the canonical bytes out of the success location before attempting the
  // content-addressed archive. If archiving fails, the quarantine is retained.
  fs.renameSync(priorPath, quarantined);
  const digest = readHash(quarantined);
  fs.mkdirSync(archiveDirectory, {recursive:true});
  const archive = path.join(archiveDirectory, digest + '.json');
  if (fs.existsSync(archive)) {
    assert.equal(readHash(archive), digest, 'existing report archive digest');
  } else {
    fs.copyFileSync(quarantined, archive, fs.constants.COPYFILE_EXCL);
  }
  assert.equal(readHash(archive), digest, 'new report archive digest');
  assert.equal(fs.existsSync(priorPath), false, 'old canonical report remains quarantined');
  return {quarantined, archive, sha256:digest};
}

function acceptChildReceipt(child:ReturnType<typeof spawnSync>, childPath:string,
                            payload:any, payloadDigest:string,
                            hashesAtStart:Record<string,string>):any {
  requireZero(child, 'ABI2 CPI composition child');
  const receipt = JSON.parse(fs.readFileSync(childPath, 'utf8'));
  assertReceipt(receipt, payload, payloadDigest, hashesAtStart);
  return receipt;
}

function checkerHashes():Record<string,string> {
  return {
    [path.resolve('verification/cpi_adapter_composition.py')]:
      readHash(path.resolve('verification/cpi_adapter_composition.py')),
    [path.resolve('verification/check-cpi-adapter-composition.ts')]:
      readHash(path.resolve('verification/check-cpi-adapter-composition.ts')),
  };
}

function makeProbeReceipt(payload:any, payloadDigest:string,
                          hashesAtStart:Record<string,string>):any {
  const semanticNames = [
    'wrong validation effect slot', 'wrong validation count',
    'validator receives a separately parsed account array', 'constant custody bump',
    'dropped CPI validation', 'truncated validation status width',
    'validation status checked after managed-state scan',
    'meta loop takes count from a different effect slot',
    'execute before every validation succeeds', 'managed account alias preflight removed',
  ];
  const fixtures = payload.fixtures.map((fixture:any) => ({
    name:fixture.name,
    managedStates:Number(fixture.name.at(-1)),
    effectSlots:2,
    managedStatePreflightAndAliases:{witnessedStages:['distinct-accounts']},
    callBridge:{result:'proved on parsed emitted entrypoint paths',validatedSlots:[0,1]},
    metaLoopBridge:{result:'UNSAT for each emitted CPI slot with the legacy assumptions removed',slots:[{},{}]},
    effectStability:{result:'adapter has no assignment to the extracted effect array'},
    cpiAssumptionAudit:{result:'exact complete axiom inventories; no built-in CPI assumptions in composition'},
    cpiPremiseProofs:[{result:'unsat'},{result:'unsat'}],
    helperRuntimeIncludeClosure:{
      selectedSourceRoot:fixture.helperRuntimeRoot,
      files:fixture.helperRuntimeFiles,
      allBytesMatchParsedHelper:true,
    },
    accountArraySizeRefresh:{
      result:'no post-execution Account.size reads in the parsed adapter',
      postExecutionSizeReadCount:0,
    },
  }));
  return {
    passed:true,
    z3:'5.1.0',
    solverFailureBehavior:{
      forcedUnknownRejected:true,
      parentNonzeroProbeRejected:true,
      partialReceiptProbeRejected:true,
      archivedReportReplayRejected:true,
      archiveFailureQuarantinesOldReport:true,
      fullChildReportThenNonzeroRejected:true,
      fullChildReportThenSignalRejected:true,
      malformedMinimalChildRejected:true,
    },
    coverage:payload.fixtures.map((fixture:any) => ({
      fixture:fixture.name,managedStates:Number(fixture.name.at(-1)),effectSlots:2,
    })),
    conditionalConnection:{
      fixtures,
      validatorComponent:{conditionalFacts:[{
        name:'active success bounds meta count to 8',result:'unsat',
      }]},
      executorComponent:{
        actualRuntimeBody:{result:'accepted restricted live-body grammar'},
        inactiveEffect:'inactive effects return before reading an unbounded count',
      },
    },
    mutations:{
      semanticCounterexamples:semanticNames.map(name => ({
        name,kind:'semantic',reason:'probe',counterexample:{model:{}} ,
      })),
      bridgeNegatives:{scope:'synthetic malformed receipt probe',observationFaults:[]},
      grammarRejections:[{kind:'grammar',reason:'probe'}],
    },
    equivalents:[{result:'accepted'},{result:'accepted'}],
    outcomeScope:{
      runtimeOrCpiAbort:'outside the ordinary return model',
      externalAccountContents:'may have changed during CPI',
    },
    inputs:{
      runNonce:payload.runNonce,
      payloadSha256:payloadDigest,
      sourceRoot,
      immutableSourceAndArtifactInputs:payload.immutableInputs,
      reusedSourceHashes:hashesAtStart,
      checkerHashes:checkerHashes(),
      helperRuntimeIncludeClosureByFixture:payload.fixtures.map((fixture:any) => ({
        fixture:fixture.name,
        selectedSourceRoot:fixture.helperRuntimeRoot,
        files:fixture.helperRuntimeFiles,
      })),
    },
  };
}

function runParentProbes(probeDir:string, payload:any,
                         hashesAtStart:Record<string,string>):Record<string,boolean> {
  const probes:Record<string,boolean> = {};
  const probePayloadBytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n');
  const probePayloadPath = path.join(probeDir, 'parent-probe-payload.json');
  fs.writeFileSync(probePayloadPath, probePayloadBytes, {flag:'wx'});
  const digest = sha(probePayloadBytes);
  const goodReceipt = makeProbeReceipt(payload, digest, hashesAtStart);
  const fullReceiptBytes = Buffer.from(JSON.stringify(goodReceipt, null, 2) + '\n');
  const fullReceiptPath = path.join(probeDir,'full-child-report-template.json');
  fs.writeFileSync(fullReceiptPath,fullReceiptBytes,{flag:'wx'});

  // A complete archived receipt with an older run nonce and payload digest is
  // rejected even though its previous pass bit and proof contents are valid.
  const archivePath = path.join(probeDir, 'archived-prior-child.json');
  const archived = structuredClone(goodReceipt);
  archived.inputs.runNonce = 'prior-run-nonce';
  archived.inputs.payloadSha256 = 'prior-payload-digest';
  fs.writeFileSync(archivePath, JSON.stringify(archived), {flag:'wx'});
  assert.throws(() => assertReceipt(JSON.parse(fs.readFileSync(archivePath, 'utf8')),
    payload, digest, hashesAtStart), /per-run nonce/);
  probes.archivedReportReplayRejected = true;
  const digestOnlyReplay = structuredClone(goodReceipt);
  digestOnlyReplay.inputs.payloadSha256 = 'prior-payload-digest';
  assert.throws(() => assertReceipt(digestOnlyReplay,payload,digest,hashesAtStart),
    /exact generated fixture payload/);

  // Exercise the real quarantine-then-archive filesystem sequence with a
  // deliberately unarchivable report directory.
  const archiveProbe = path.join(probeDir, 'archive-failure');
  const oldCanonical = path.join(archiveProbe, 'report.json');
  const blockedArchiveDirectory = path.join(archiveProbe, 'refinement-reports');
  const quarantineDirectory = path.join(archiveProbe, 'quarantine');
  fs.mkdirSync(archiveProbe, {recursive:true});
  const oldBytes = Buffer.from('{"passed":true,"old":"preserve-me"}\n');
  fs.writeFileSync(oldCanonical, oldBytes, {flag:'wx'});
  fs.writeFileSync(blockedArchiveDirectory, 'blocking regular file');
  assert.throws(() => archivePriorReport(oldCanonical, blockedArchiveDirectory,
    quarantineDirectory, payload.runNonce), /EEXIST|ENOTDIR/);
  assert.equal(fs.existsSync(oldCanonical), false, 'failed archive left a canonical success');
  assert.deepEqual(fs.readFileSync(path.join(quarantineDirectory,payload.runNonce + '.json')),
    oldBytes, 'old canonical bytes were not preserved in quarantine');
  probes.archiveFailureQuarantinesOldReport = true;

  const childSource = path.join(probeDir, 'write-child-probe.py');
  fs.writeFileSync(childSource, [
    'import os, signal, sys',
    'mode, payload, receipt, pending = sys.argv[1:]',
    'data = open(payload, "rb").read()',
    'open(receipt, "wb").write(data)',
    'open(pending, "wb").write(data)',
    'if mode == "nonzero": sys.exit(29)',
    'if mode == "signal": os.kill(os.getpid(), signal.SIGTERM)',
    'if mode == "minimal": open(receipt, "wb").write(b"{\\"passed\\":true}")',
  ].join('\n') + '\n', {flag:'wx'});
  for (const mode of ['nonzero','signal','minimal']) {
    const childPath = path.join(probeDir, mode + '-child.json');
    const pendingPath = childPath + '.pending';
    const canonicalPath = path.join(probeDir, mode + '-canonical.json');
    const child = spawnSync(python, [childSource, mode, fullReceiptPath, childPath, pendingPath], {
      encoding:'utf8',timeout:30_000,
    });
    if (mode === 'nonzero') {
      assert.equal(child.status, 29, 'full child report then nonzero exit');
      assert.throws(() => acceptChildReceipt(child,childPath,payload,digest,hashesAtStart),
        /status 29/);
      assert.deepEqual(fs.readFileSync(childPath),fullReceiptBytes);
      assert.deepEqual(fs.readFileSync(pendingPath),fullReceiptBytes);
      assert.equal(fs.existsSync(canonicalPath),false);
      probes.fullChildReportThenNonzeroRejected = true;
    } else if (mode === 'signal') {
      assert.equal(child.status,null,'full child report then signal has no status');
      assert.equal(child.signal,'SIGTERM');
      assert.throws(() => acceptChildReceipt(child,childPath,payload,digest,hashesAtStart),
        /status null/);
      assert.deepEqual(fs.readFileSync(childPath),fullReceiptBytes);
      assert.deepEqual(fs.readFileSync(pendingPath),fullReceiptBytes);
      assert.equal(fs.existsSync(canonicalPath),false);
      probes.fullChildReportThenSignalRejected = true;
    } else {
      assert.equal(child.status,0,'malformed minimal child exits normally');
      assert.throws(() => acceptChildReceipt(child,childPath,payload,digest,hashesAtStart),
        /Z3 version/);
      assert.deepEqual(fs.readFileSync(pendingPath),fullReceiptBytes);
      assert.equal(fs.readFileSync(childPath,'utf8'),'{"passed":true}');
      assert.equal(fs.existsSync(canonicalPath),false);
      probes.malformedMinimalChildRejected = true;
    }
  }
  probes.nonzeroRejected = probes.fullChildReportThenNonzeroRejected;
  probes.partialReceiptRejected = probes.malformedMinimalChildRejected;
  return probes;
}

async function main() {
  const runNonce = crypto.randomUUID();
  fs.mkdirSync(path.dirname(reportPath), {recursive:true});
  fs.mkdirSync(directory, {recursive:true});
  const priorReport = archivePriorReport(reportPath, archiveRoot, quarantineRoot, runNonce);
  const runDir = path.join(directory, 'runs', runNonce);
  fs.mkdirSync(path.dirname(runDir), {recursive:true});
  fs.mkdirSync(runDir, {recursive:false});
  const payloadPath = path.join(runDir, 'payload.json');
  const childReceiptPath = path.join(runDir, 'child-receipt.json');
  const childPendingPath = childReceiptPath + '.pending';
  const reportPendingPath = path.join(runDir, 'report.pending');

  const sourcesAtStart = sourceHashes();
  const generated = await buildPayload(runNonce);
  assert.deepEqual(generated.currentSources, sourcesAtStart,
    'sourceRoot changed during fixture generation');
  const baselineManifest = path.join(runDir, 'source-snapshot.json');
  fs.writeFileSync(baselineManifest, JSON.stringify(sourcesAtStart, null, 2) + '\n', {flag:'wx'});
  const baseline = {path:baselineManifest, sha256:readHash(baselineManifest)};
  generated.immutableInputs[baselineManifest] = baseline.sha256;
  const probePayload:any = {
    expectedZ3:'5.1.0',runNonce,sourceRoot,
    coverage:['cpi-2','cpi-3','cpi-4'],fixtures:generated.fixtures,
    immutableInputs:generated.immutableInputs,
  };
  const sourceInputsAtProof = sourceHashes();
  assert.deepEqual(sourceInputsAtProof, generated.currentSources,
    'current source inputs differ before proof');
  const parentProbes = runParentProbes(runDir,probePayload,sourceInputsAtProof);
  const payload:any = {
    expectedZ3:'5.1.0',
    runNonce,
    sourceRoot,
    compiler:{
      backend:'compiler/backend.ts',
      artifactWriter:'compiler/artifacts.ts',
      multiStorage:'compiler/multi-storage.ts',
      bendRevision:generated.bend.revision,
      bunVersion:Bun.version,
      sourceHashes:generated.currentSources,
      baselineSnapshot:baseline,
    },
    coverage:['cpi-2','cpi-3','cpi-4'],
    hostChildTimeoutMs:hostTimeoutMs,
    parentProbes,
    priorReport,
    fixtures:generated.fixtures,
    immutableInputs:generated.immutableInputs,
  };
  const payloadBytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(payloadPath, payloadBytes, {flag:'wx'});
  const payloadDigest = sha(payloadBytes);
  assert.equal(fs.existsSync(childReceiptPath),false,'run child receipt path already exists');
  assert.equal(fs.existsSync(childPendingPath),false,'run child pending path already exists');
  assert.equal(fs.existsSync(reportPendingPath),false,'run parent pending path already exists');

  const child = spawnSync(python, [
    '-B', 'verification/cpi_adapter_composition.py',
    payloadPath, childReceiptPath,
  ], {
    encoding:'utf8',
    timeout:hostTimeoutMs,
    maxBuffer:1 << 24,
    env:{...process.env, BEND_CPI_ADAPTER_SOURCE_ROOT:sourceRoot},
  });
  acceptChildReceipt(child,childReceiptPath,payload,payloadDigest,sourceInputsAtProof);
  assert.deepEqual(sourceHashes(), sourceInputsAtProof,
    'sourceRoot changed while composition proof ran');
  assert.equal(readHash(payloadPath), payloadDigest, 'fixture payload changed during proof');
  for (const [file, digest] of Object.entries(generated.immutableInputs) as [string,string][]) {
    assert.equal(readHash(file), digest, 'immutable input changed during proof: ' + file);
  }
  for (const fixture of generated.fixtures) {
    for (const [file, digest] of Object.entries(fixture.artifactHashes) as [string,string][]) {
      assert.equal(readHash(file), digest, fixture.name + ': artifact changed during proof: ' + file);
    }
  }
  assert.equal(fs.existsSync(reportPath),false,'canonical report was not quarantined before the run');
  fs.copyFileSync(childReceiptPath,reportPendingPath,fs.constants.COPYFILE_EXCL);
  const pending = JSON.parse(fs.readFileSync(reportPendingPath,'utf8'));
  assertReceipt(pending,payload,payloadDigest,sourceInputsAtProof);
  assert.equal(readHash(reportPendingPath),readHash(childReceiptPath));
  fs.renameSync(reportPendingPath,reportPath);
  process.stdout.write(child.stdout);
  process.stdout.write(
    'Parent receipt accepted; prior canonical report quarantined before archive; run ' +
    runNonce + '; report ' + reportPath + '\n',
  );
}

if (import.meta.main) await main();
