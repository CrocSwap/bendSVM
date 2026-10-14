import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { checkedProgram } from '../compiler/backend.ts';
import { buildPureLibrary } from '../scripts/build-library.ts';
import { run, sbfTools } from '../scripts/build.ts';
import { publishAcceptedFinalSbfArtifact, verifyFinalSbfArtifactReceipt } from '../compiler/sbf-call-depth-artifact.ts';

const root = 'build/mixed-library';
const stem = `${root}/library`;
const source = 'tests/mixed-library/PROOF.bend';
const bendRoot = 'mixed.evaluate';
const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const runId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomBytes(5).toString('hex')}`;
const priorEvidenceArchive = `${root}-archive/${runId}`;
const mutationProbeDir = `build/mixed-library-receipt-probe-${runId}`;
const acceptanceTestInputs = [
  'tests/mixed-library.ts', 'tests/mixed-library-sbf.rs', 'tests/mixed-library/fixture.md',
  'tests/mixed-library/host.c', 'tests/mixed-library/program.rs', 'tests/mixed-library/PROOF.bend',
  'tests/mixed-library/LAWS.bend', 'tests/mixed-library/mixed.bend', 'Cargo.toml', 'Cargo.lock',
  'package.json', 'package-lock.json', 'compiler/native-arithmetic.ts', 'compiler/diagnostics.ts',
  'compiler/sbf-call-depth.ts', 'compiler/sbf-call-depth-artifact.ts',
];
const libraryBuildInputs = [
  'compiler/backend.ts', 'compiler/type-evaluation.ts', 'compiler/tagged-sum-ir.ts', 'compiler/native-arithmetic.ts', 'compiler/primitives.ts',
  'compiler/diagnostics.ts', 'compiler/library.ts', 'compiler/target-profile.ts', 'compiler/codecs.ts', 'compiler/schema.ts',
  'scripts/build-library.ts', 'scripts/build.ts', 'runtime/memory.c', 'package.json',
  'package-lock.json', 'Cargo.lock', '.deps/bend/bend2/bend.ts', '.deps/bend/bend2/base.bend',
];

function absoluteInput(file: string): string {
  return path.resolve(file);
}

function snapshotInputs(files: string[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const file of files) {
    const absolute = absoluteInput(file);
    if (!fs.existsSync(absolute)) throw new Error(`Missing acceptance input: ${file}`);
    snapshot.set(absolute, hash(absolute));
    const real = fs.realpathSync(absolute);
    snapshot.set(real, hash(real));
  }
  assertSnapshotUnchanged(snapshot, 'while capturing acceptance inputs');
  return snapshot;
}

function snapshotHash(snapshot: Map<string, string>, file: string): string {
  const absolute = absoluteInput(file);
  const captured = snapshot.get(absolute) ?? snapshot.get(fs.realpathSync(absolute));
  if (!captured) throw new Error(`Acceptance input was not captured before work: ${file}`);
  return captured;
}

function assertSnapshotUnchanged(snapshot: Map<string, string>, when: string): void {
  for (const [file, expected] of snapshot) {
    if (!fs.existsSync(file) || hash(file) !== expected) {
      throw new Error(`Acceptance input changed ${when}: ${file}`);
    }
  }
}

function mergeSnapshot(target: Map<string, string>, addition: Map<string, string>): void {
  for (const [file, expected] of addition) {
    const previous = target.get(file);
    if (previous !== undefined && previous !== expected) {
      throw new Error(`Acceptance input changed before its build snapshot: ${file}`);
    }
    target.set(file, expected);
  }
}

function observePinnedBend() {
  const expectedCommit = '7561656155a4285c1e4ccfcb3505ab59524de973';
  const observedCommit = run('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD'], true);
  const status = run('git', ['-C', '.deps/bend', 'status', '--porcelain'], true);
  const checkerPath = '.deps/bend/bend2/bend.ts';
  const checkerSha256 = hash(checkerPath);
  assert.equal(observedCommit, expectedCommit, 'Acceptance requires the observed pinned Bend revision');
  assert.equal(status, '', 'Acceptance requires a clean Bend dependency');
  return { expectedCommit, observedCommit, clean: status === '', checkerPath, checkerSha256 };
}

function assertBuildInputsBound(manifest: any, snapshot: Map<string, string>, bendBefore: ReturnType<typeof observePinnedBend>) {
  for (const [file, expected] of Object.entries(manifest.inputs as Record<string, string>)) {
    assert.equal(snapshotHash(snapshot, file), expected, `Build manifest input differs from its pre-build capture: ${file}`);
  }
  const dependency = manifest.dependencies.bendChecker;
  assert.equal(dependency.expectedCommit, bendBefore.expectedCommit);
  assert.equal(dependency.observedCommitBefore, bendBefore.observedCommit);
  assert.equal(dependency.observedCommitAfter, bendBefore.observedCommit);
  assert.equal(dependency.cleanBefore, true);
  assert.equal(dependency.cleanAfter, true);
  assert.equal(dependency.sha256Before, bendBefore.checkerSha256);
  assert.equal(dependency.sha256After, bendBefore.checkerSha256);
  assert.equal(manifest.inputs[dependency.path], bendBefore.checkerSha256,
    'Build manifest must hash the actual pinned Bend checker bytes');
}

function assertManifestArtifactsBound(manifest: any, stemPath: string): void {
  assert.equal(manifest.version, 1);
  assert.equal(manifest.kind, 'bend-library-v1');
  assert.equal(manifest.targetProfile, 'fogo-v0');
  assert.equal(manifest.toolchains.anzaClang.platformTools, 'v1.53');
  assert.equal(manifest.toolchains.anzaClang.cpu, 'generic');
  assert.equal(manifest.toolchains.anzaClang.sbpfVersion, 0);
  assert.equal(manifest.finalElfAuthorized, false);
  const base = path.basename(stemPath);
  assert.deepEqual(manifest.selection, {
    hostSource: `${base}.c`, hostObject: `${base}.host.o`,
    sbfSource: `${base}.c`, sbfObject: `${base}.sbf.o`,
    memoryObject: `${base}.sbf.memory.o`, header: `${base}.h`,
    bindings: `${base}.bindings.rs`, schema: `${base}.schema.json`,
  });
  for (const name of Object.values(manifest.selection) as string[]) {
    assert(manifest.artifacts[name], `Selected library artifact must have a hash: ${name}`);
  }
  for (const [basename, record] of Object.entries(manifest.artifacts as Record<string, { bytes: number; sha256: string }>)) {
    const file = path.join(path.dirname(stemPath), basename);
    assert.equal(fs.statSync(file).size, record.bytes, `Build manifest byte count mismatch: ${file}`);
    assert.equal(hash(file), record.sha256, `Build manifest hash mismatch: ${file}`);
  }
}

function assertManifestFileBound(file: string, expected: any, snapshot: Map<string, string>, bendBefore: ReturnType<typeof observePinnedBend>, stemPath: string): void {
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, expected, `Build manifest changed after it was produced: ${file}`);
  assertBuildInputsBound(onDisk, snapshot, bendBefore);
  assertManifestArtifactsBound(onDisk, stemPath);
}

function archiveEvidenceDirectory(sourceRoot: string, archiveRoot: string): void {
  if (!fs.existsSync(sourceRoot)) return;
  fs.mkdirSync(path.dirname(archiveRoot), { recursive: true });
  try {
    fs.renameSync(sourceRoot, archiveRoot);
  } catch (error) {
    fs.rmSync(path.join(sourceRoot, 'acceptance.json'), { force: true });
    throw new Error(`Could not archive prior mixed-library evidence: ${String(error)}`);
  }
}

function archivePriorEvidence(): void {
  archiveEvidenceDirectory(path.resolve(root), path.resolve(priorEvidenceArchive));
}

function quarantineRefusedMixedElf(): string | null {
  const elfPath = `${root}/mixed-library.so`;
  if (!fs.existsSync(elfPath)) return null;
  const directory = `build/mixed-library-sbf-call-depth-refused/${runId}`;
  fs.mkdirSync(directory, { recursive: true });
  const archivedPath = `${directory}/mixed-library.so`;
  try {
    fs.renameSync(elfPath, archivedPath);
  } catch (renameError) {
    try {
      fs.copyFileSync(elfPath, archivedPath, fs.constants.COPYFILE_EXCL);
      fs.rmSync(elfPath);
    } catch (copyError) {
      fs.rmSync(elfPath, { force: true });
      throw new Error(`Could not preserve refused mixed ELF at ${archivedPath}: ${String(renameError)}; ${String(copyError)}`);
    }
  }
  return archivedPath;
}

function commandPath(command: string): string {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    assert(fs.existsSync(command), `Cannot locate ${command}`);
    return path.resolve(command);
  }
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  assert.equal(result.status, 0, `Cannot locate ${command}`);
  return path.resolve(result.stdout.trim());
}

function binaryRecord(file: string) {
  const real = fs.realpathSync(file);
  const symbolic = fs.lstatSync(file).isSymbolicLink();
  return {
    path: path.resolve(file),
    resolvedPath: real,
    ...(symbolic ? { symlinkTarget: fs.readlinkSync(file) } : {}),
    bytes: fs.statSync(real).size,
    sha256: hash(real),
  };
}

function executableRecord(command: string, versionArgs: string[]) {
  const launcherPath = commandPath(command);
  let compilerBinaryPath = fs.realpathSync(launcherPath);
  const rustup = spawnSync('rustup', ['which', path.basename(command)], { encoding: 'utf8' });
  if (['cargo', 'rustc'].includes(path.basename(command)) && rustup.status === 0 && rustup.stdout.trim()) {
    compilerBinaryPath = fs.realpathSync(rustup.stdout.trim());
  }
  return {
    launcher: binaryRecord(launcherPath),
    compilerBinary: binaryRecord(compilerBinaryPath),
    version: run(launcherPath, versionArgs, true),
  };
}

function toolRecord(launcherPath: string, versionArgs: string[]) {
  const actualPath = fs.realpathSync(launcherPath);
  return {
    launcher: binaryRecord(launcherPath),
    compilerBinary: binaryRecord(actualPath),
    version: run(launcherPath, versionArgs, true),
  };
}

function manifestFile(file: string): string {
  const absolute = path.resolve(file);
  const relative = path.relative(process.cwd(), absolute);
  return relative === '..' || relative.startsWith(`..${path.sep}`) ? absolute : relative;
}

function fixtureCopy(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
  for (const file of ['PROOF.bend', 'LAWS.bend', 'mixed.bend']) {
    fs.copyFileSync(path.join('tests/mixed-library', file), path.join(directory, file));
  }
}

async function verifyMidRunBindingFailures(): Promise<{ reportPath: string; results: unknown[] }> {
  const privateRoot = path.resolve(mutationProbeDir, 'worktree');
  const privateDependency = path.join(privateRoot, '.deps', 'bend');
  const projectFiles = [
    'Cargo.lock', 'package.json', 'package-lock.json',
    'compiler/backend.ts', 'compiler/type-evaluation.ts', 'compiler/tagged-sum-ir.ts', 'compiler/codecs.ts', 'compiler/diagnostics.ts', 'compiler/library.ts', 'compiler/target-profile.ts',
    'compiler/native-arithmetic.ts', 'compiler/primitives.ts', 'compiler/schema.ts',
    'compiler/sbf-call-depth.ts', 'compiler/sbf-call-depth-artifact.ts',
    'scripts/build.ts', 'scripts/build-library.ts', 'runtime/memory.c',
    'tests/mixed-library/PROOF.bend', 'tests/mixed-library/LAWS.bend', 'tests/mixed-library/mixed.bend',
  ];
  for (const file of projectFiles) {
    const destination = path.join(privateRoot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
  fs.mkdirSync(path.dirname(privateDependency), { recursive: true });
  const clone = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', '--local',
    fs.realpathSync('.deps/bend'), privateDependency], { encoding: 'utf8' });
  assert.equal(clone.status, 0, `Could not create private Bend dependency clone: ${clone.stderr}`);

  const privateLibraryFile = path.join(privateRoot, 'compiler/library.ts');
  const originalLibrary = fs.readFileSync(privateLibraryFile, 'utf8');
  const captureAnchor = '  const bendBefore = observePinnedBend();';
  const pauseHook = `${captureAnchor}\n` +
    `  const pauseReady = process.env.MIXED_RECEIPT_PAUSE_READY;\n` +
    `  const pauseRelease = process.env.MIXED_RECEIPT_PAUSE_RELEASE;\n` +
    `  if (pauseReady && pauseRelease) {\n` +
    `    fs.writeFileSync(pauseReady, 'captured');\n` +
    `    const deadline = Date.now() + 30000;\n` +
    `    while (!fs.existsSync(pauseRelease) && Date.now() < deadline) {\n` +
    `      await new Promise(resolve => setTimeout(resolve, 10));\n` +
    `    }\n` +
    `    if (!fs.existsSync(pauseRelease)) throw new Error('Timed out waiting for private mutation probe');\n` +
    `  }`;
  assert(originalLibrary.includes(captureAnchor), 'Private mutation probe must instrument the post-capture boundary');
  fs.writeFileSync(privateLibraryFile, originalLibrary.replace(captureAnchor, pauseHook));

  const privateBendSource = path.join(privateRoot, 'tests/mixed-library/mixed.bend');
  const originalBendSource = fs.readFileSync(privateBendSource);
  const privateChecker = path.join(privateDependency, 'bend2/bend.ts');
  const originalChecker = fs.readFileSync(privateChecker);
  fs.mkdirSync(path.join(privateRoot, 'build'), { recursive: true });
  const results: Array<Record<string, unknown>> = [];

  const runOne = async (name: 'source' | 'checker') => {
    const ready = path.join(privateRoot, `build/${name}.captured`);
    const release = path.join(privateRoot, `build/${name}.release`);
    const manifest = path.join(privateRoot, 'build/probe/library.manifest.json');
    const child = spawn(process.execPath, [path.join(privateRoot, 'scripts/build-library.ts'),
      'tests/mixed-library/PROOF.bend', bendRoot, 'build/probe/library'], {
      cwd: privateRoot,
      env: { ...process.env, MIXED_RECEIPT_PAUSE_READY: ready, MIXED_RECEIPT_PAUSE_RELEASE: release },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    let finished = false;
    void completed.then(() => { finished = true; }, () => { finished = true; });
    const deadline = Date.now() + 30000;
    while (!fs.existsSync(ready) && !finished && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(fs.existsSync(ready), `${name} mutation probe did not reach the captured-input pause: ${output}`);
    let changedPath: string;
    let before: string;
    let after: string;
    if (name === 'source') {
      changedPath = privateBendSource;
      before = hash(privateBendSource);
      fs.appendFileSync(privateBendSource, '\n# changed after the library captured its source inputs\n');
      after = hash(privateBendSource);
    } else {
      changedPath = privateChecker;
      before = hash(privateChecker);
      fs.appendFileSync(privateChecker, '\n');
      after = hash(privateChecker);
    }
    assert.notEqual(after, before, `${name} mutation probe must change actual bytes`);
    fs.writeFileSync(release, 'continue');
    const exit = await completed;
    assert.notEqual(exit.code, 0, `${name} mutation must fail the private library build: ${output}`);
    assert.match(output, /changed|dirty|pinned Bend checker/i,
      `${name} mutation must fail because a captured input/checker changed: ${output}`);
    assert.equal(fs.existsSync(manifest), false, `${name} mutation must not produce a success build manifest`);
    results.push({ name, changedPath: path.relative(privateRoot, changedPath), sha256Before: before,
      sha256After: after, exitCode: exit.code, output });
    if (name === 'source') fs.writeFileSync(privateBendSource, originalBendSource);
  };

  await runOne('source');
  await runOne('checker');
  fs.writeFileSync(privateChecker, originalChecker);

  const targetTools = path.join(privateRoot, 'target-tools');
  fs.mkdirSync(targetTools);
  const realTools = path.resolve(sbfTools());
  const compilerShim = path.join(targetTools, 'clang');
  fs.writeFileSync(compilerShim, `#!${process.execPath}\n` +
    `import fs from 'node:fs';\nimport {spawnSync} from 'node:child_process';\n` +
    `const args = process.argv.slice(2);\n` +
    `const child = spawnSync(${JSON.stringify(path.join(realTools, 'clang'))}, args, {stdio:'inherit'});\n` +
    `if (child.status !== 0) process.exit(child.status ?? 1);\n` +
    `const output = args[args.indexOf('-o') + 1];\n` +
    `const suffix = process.env.MIXED_OBJECT_TARGET_FAULT === 'memory' ? '.sbf.memory.o' : '.sbf.o';\n` +
    `if (args.includes('-c') && output?.endsWith(suffix)) {\n` +
    `  const bytes = fs.readFileSync(output);\n` +
    `  bytes.writeUInt32LE(3, 48);\nfs.writeFileSync(output, bytes);\n}\n`, { mode: 0o755 });
  fs.symlinkSync(path.join(realTools, 'llvm-readelf'), path.join(targetTools, 'llvm-readelf'));
  for (const fault of ['library', 'memory']) {
    const targetStem = `build/target-${fault}/library`;
    const child = spawnSync(process.execPath, [path.join(privateRoot, 'scripts/build-library.ts'),
      'tests/mixed-library/PROOF.bend', bendRoot, targetStem], {
      cwd: privateRoot, encoding: 'utf8',
      env: { ...process.env, SBF_TOOLS: targetTools, MIXED_OBJECT_TARGET_FAULT: fault },
    });
    const output = child.stdout + child.stderr;
    assert.notEqual(child.status, 0, `Changed ${fault} object target must reject`);
    assert.match(output, /fogo-v0 requires an ELF64 little-endian SBPFv0 relocatable object/);
    assert.equal(fs.existsSync(path.join(privateRoot, targetStem + '.manifest.json')), false,
      'An incompatible SBF object must not publish a library manifest');
    const file = path.join(privateRoot, targetStem + (fault === 'memory' ? '.sbf.memory.o' : '.sbf.o'));
    assert.equal(fs.readFileSync(file).readUInt32LE(48), 3);
    results.push({ name: `target-${fault}`, exitCode: child.status, output,
      objectPath: path.relative(privateRoot, file), objectSha256: hash(file),
      compilerShimSha256: hash(compilerShim), sbpfFlags: 3 });
  }

  const acceptanceProbe = path.join(mutationProbeDir, 'acceptance-driver');
  const trackedSource = path.join(acceptanceProbe, 'source.bend');
  fs.mkdirSync(acceptanceProbe, { recursive: true });
  fs.writeFileSync(trackedSource, 'source captured before acceptance work\n');
  const acceptanceSnapshot = snapshotInputs([trackedSource]);
  const priorOutput = path.join(acceptanceProbe, 'prior-output');
  const priorArchive = path.join(acceptanceProbe, 'archived-output');
  fs.mkdirSync(priorOutput, { recursive: true });
  fs.writeFileSync(path.join(priorOutput, 'acceptance.json'), '{"stale":true}\n');
  archiveEvidenceDirectory(priorOutput, priorArchive);
  assert.equal(fs.existsSync(path.join(priorOutput, 'acceptance.json')), false,
    'Archiving prior evidence must remove a stale receipt from the active output path');
  fs.appendFileSync(trackedSource, '# changed after the acceptance driver captured it\n');
  assert.throws(() => assertSnapshotUnchanged(acceptanceSnapshot, 'during private acceptance probe'),
    /Acceptance input changed/);
  results.push({ name: 'acceptance-driver-source', changedPath: path.relative(process.cwd(), trackedSource),
    sha256Before: acceptanceSnapshot.get(trackedSource), sha256After: hash(trackedSource),
    staleReceiptArchived: fs.existsSync(path.join(priorArchive, 'acceptance.json')) });

  const reportPath = path.join(mutationProbeDir, 'report.json');
  const report = {
    isolatedWorktree: path.relative(process.cwd(), privateRoot),
    bendDependencyClone: {
      path: path.relative(process.cwd(), privateDependency),
      observedRevision: run('git', ['-C', privateDependency, 'rev-parse', 'HEAD'], true),
      cleanBeforeProbe: true,
      checkerPath: path.relative(privateRoot, privateChecker),
      checkerBytesChangedOnlyInsidePrivateClone: true,
    },
    results,
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { reportPath, results };
}

archivePriorEvidence();
const acceptanceInputs = snapshotInputs([...acceptanceTestInputs, ...libraryBuildInputs]);
const bendBefore = observePinnedBend();
fs.mkdirSync('build', { recursive: true });
fs.mkdirSync(root, { recursive: true });
const negativeRoot = fs.mkdtempSync(path.resolve('build/mixed-library-negative-'));
try {
  const fixtureDir = path.resolve('tests/mixed-library');
  const missingLaws = path.join(negativeRoot, 'missing-laws');
  fixtureCopy(missingLaws);
  fs.writeFileSync(path.join(missingLaws, 'PROOF.bend'), 'import ./mixed.bend as Mixed\n');
  await assert.rejects(() => checkedProgram(path.join(missingLaws, 'PROOF.bend')), /must import the adjacent LAWS/);

  const noAdjacentLaws = path.join(negativeRoot, 'no-adjacent-laws');
  fs.mkdirSync(noAdjacentLaws, { recursive: true });
  fs.copyFileSync(path.join(fixtureDir, 'mixed.bend'), path.join(noAdjacentLaws, 'mixed.bend'));
  fs.writeFileSync(path.join(noAdjacentLaws, 'PROOF.bend'), 'import ./mixed.bend as Mixed\n');
  await assert.rejects(
    () => buildPureLibrary(path.join(noAdjacentLaws, 'PROOF.bend'), bendRoot, `${root}/should-not-build`),
    /requires adjacent LAWS/,
  );

  const unsafe = path.join(negativeRoot, 'unsafe');
  fixtureCopy(unsafe);
  const unsafeSource = fs.readFileSync(path.join(unsafe, 'mixed.bend'), 'utf8')
    .replace('def evaluate(+request:', '@unsafe def evaluate(+request:');
  fs.writeFileSync(path.join(unsafe, 'mixed.bend'), unsafeSource);
  await assert.rejects(() => checkedProgram(path.join(unsafe, 'PROOF.bend')), /Unsafe\/foreign dependency/);

  const openLaw = path.join(negativeRoot, 'open-law');
  fixtureCopy(openLaw);
  fs.appendFileSync(path.join(openLaw, 'LAWS.bend'), `\nlaw unproved_case:\n  {Mixed.evaluate(Mixed.Stop{}) == Mixed.Refused{0} : Mixed.Decision}\n`);
  await assert.rejects(() => checkedProgram(path.join(openLaw, 'PROOF.bend')), /Unresolved proof holes or open laws/);

  const wrongProof = path.join(negativeRoot, 'wrong-proof');
  fixtureCopy(wrongProof);
  const originalProof = fs.readFileSync(path.join(wrongProof, 'PROOF.bend'), 'utf8');
  const wrongProofSource = originalProof.replace('def Laws.disabled_requests_are_refused(value):\n  {==}',
    'def Laws.disabled_requests_are_refused(value):\n  False{}');
  assert.notEqual(wrongProofSource, originalProof);
  fs.writeFileSync(path.join(wrongProof, 'PROOF.bend'), wrongProofSource);
  await assert.rejects(() => checkedProgram(path.join(wrongProof, 'PROOF.bend')));

  const wrongCutoff = path.join(negativeRoot, 'wrong-cutoff');
  fixtureCopy(wrongCutoff);
  const cutoffSource = fs.readFileSync(path.join(wrongCutoff, 'mixed.bend'), 'utf8');
  const changedCutoff = cutoffSource.replace('U32.is_lt(value, 41)', 'U32.is_lt(value, 42)');
  assert.notEqual(changedCutoff, cutoffSource, 'Cutoff mutation must alter the Bend source');
  fs.writeFileSync(path.join(wrongCutoff, 'mixed.bend'), changedCutoff);
  await assert.rejects(() => checkedProgram(path.join(wrongCutoff, 'PROOF.bend')),
    /expected|Unresolved proof holes or open laws/i);

  const proofRoot = path.join(negativeRoot, 'proof-root');
  fixtureCopy(proofRoot);
  fs.appendFileSync(path.join(proofRoot, 'PROOF.bend'), `\ndef proof_runtime(+request: Mixed.Request) -> Mixed.Decision:\n  Mixed.evaluate(request)\n`);
  await assert.rejects(
    () => buildPureLibrary(path.join(proofRoot, 'PROOF.bend'), 'proof_runtime', `${root}/proof-root`),
    /cannot originate in PROOF.bend or LAWS.bend/,
  );
  await assert.rejects(
    () => buildPureLibrary(source, 'LAWS.disabled_requests_are_refused', `${root}/law-root`),
    /cannot originate in PROOF.bend or LAWS.bend/,
  );
} finally {
  fs.rmSync(negativeRoot, { recursive: true, force: true });
}
console.log('Mixed library proof gate rejects missing laws, unsafe dependencies, open/wrong proofs, cutoff drift and proof-file exports');

const bindingMutationProbe = await verifyMidRunBindingFailures();
console.log('Isolated private-copy probes rejected mid-run Bend source and checker changes');

const primaryManifest = await buildPureLibrary(source, bendRoot, stem);
assertBuildInputsBound(primaryManifest, acceptanceInputs, bendBefore);
const alternateManifest = await buildPureLibrary(source, 'mixed.evaluate_alt', `${root}/alternate`);
assertBuildInputsBound(alternateManifest, acceptanceInputs, bendBefore);
const pinnedStatuses = {
  OK: 0,
  NULL: 1,
  RANGE: 2,
  ALIAS: 3,
  MALFORMED_INPUT: 4,
  SHORT_OUTPUT: 5,
  MISALIGNED_OUTPUT_LEN: 6,
  OUTPUT_ENCODING: 7,
} as const;
const generatedHeader = fs.readFileSync(`${stem}.h`, 'utf8');
const generatedBindings = fs.readFileSync(`${stem}.bindings.rs`, 'utf8');
for (const [name, value] of Object.entries(pinnedStatuses)) {
  assert.match(generatedHeader, new RegExp(`#define BEND_LIBRARY_ABI_${name} ${value}u\\b`),
    `ABI v1 status ${name} must remain independently pinned to ${value}`);
  assert.match(generatedBindings, new RegExp(`pub const BEND_LIBRARY_ABI_${name}: u32 = ${value};`),
    `Generated Rust ABI v1 status ${name} must remain ${value}`);
}
assert.equal(primaryManifest.canonicalInputBytes, alternateManifest.canonicalInputBytes,
  'Same-width roots must use identical input byte counts');
assert.equal(primaryManifest.canonicalOutputBytes, alternateManifest.canonicalOutputBytes,
  'Same-width roots must use identical output byte counts');
assert.notEqual(primaryManifest.symbol, alternateManifest.symbol,
  'A same-width different root must not share the C/Rust link symbol');
assert.notEqual(primaryManifest.schemaFingerprint, alternateManifest.schemaFingerprint,
  'A same-width different root must have a different root/schema fingerprint');

const schemaVariantSourceDir = `${root}/schema-variant-source`;
assertSnapshotUnchanged(acceptanceInputs, 'before schema variant generation');
fixtureCopy(schemaVariantSourceDir);
const variantMixed = fs.readFileSync(`${schemaVariantSourceDir}/mixed.bend`, 'utf8')
  .replaceAll('Decision', 'Outcome').replaceAll('Accepted', 'Approved').replaceAll('Refused', 'Declined');
const variantLaws = fs.readFileSync(`${schemaVariantSourceDir}/LAWS.bend`, 'utf8')
  .replaceAll('Decision', 'Outcome').replaceAll('Accepted', 'Approved').replaceAll('Refused', 'Declined');
fs.writeFileSync(`${schemaVariantSourceDir}/mixed.bend`, variantMixed);
fs.writeFileSync(`${schemaVariantSourceDir}/LAWS.bend`, variantLaws);
mergeSnapshot(acceptanceInputs, snapshotInputs([
  `${schemaVariantSourceDir}/PROOF.bend`, `${schemaVariantSourceDir}/LAWS.bend`, `${schemaVariantSourceDir}/mixed.bend`,
]));
const schemaVariantManifest = await buildPureLibrary(
  `${schemaVariantSourceDir}/PROOF.bend`, bendRoot, `${root}/schema-variant/library`);
assertBuildInputsBound(schemaVariantManifest, acceptanceInputs, bendBefore);
assertManifestArtifactsBound(primaryManifest, stem);
assertManifestArtifactsBound(alternateManifest, `${root}/alternate`);
assertManifestArtifactsBound(schemaVariantManifest, `${root}/schema-variant/library`);
assert.equal(primaryManifest.canonicalInputBytes, schemaVariantManifest.canonicalInputBytes,
  'Same-root schema variants must have identical input byte counts');
assert.equal(primaryManifest.canonicalOutputBytes, schemaVariantManifest.canonicalOutputBytes,
  'Same-root schema variants must have identical output byte counts');
assert.equal(primaryManifest.root, schemaVariantManifest.root,
  'Schema identity test must retain the same exported root name');
assert.notEqual(primaryManifest.symbol, schemaVariantManifest.symbol,
  'A same-root, same-width different schema must not share the C/Rust link symbol');
assert.notEqual(primaryManifest.schemaFingerprint, schemaVariantManifest.schemaFingerprint,
  'A same-root, same-width different schema must have a different fingerprint');

const hostCompiler = process.env.CC ?? 'clang';
run(hostCompiler, ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror',
  `-I${root}`, 'tests/mixed-library/host.c', `${stem}.host.o`, '-o', `${root}/host-test`]);
run(path.resolve(`${root}/host-test`), []);

const generatedC = fs.readFileSync(`${stem}.c`, 'utf8');
const encodeGuard = /if \(!([A-Za-z_][A-Za-z0-9_]*_encode)\(encoded, (\d+)u, &result\)\)/;
const encodeMatch = generatedC.match(encodeGuard);
assert(encodeMatch, 'Generated pure root must have a guarded output encoder');
const forcedEncodeFailure = generatedC.replace(encodeGuard,
  `result.tag = UINT32_MAX;\n  if (!$1(encoded, $2u, &result))`);
assert.notEqual(forcedEncodeFailure, generatedC, 'Output-encoding mutation must alter the generated C');
const mutatedC = `${root}/forced-output-encoding.c`;
const encodeHarness = `${root}/output-encoding-harness.c`;
const encodeObject = `${root}/forced-output-encoding.host.o`;
const encodeExecutable = `${root}/output-encoding-test`;
fs.writeFileSync(mutatedC, forcedEncodeFailure);
fs.writeFileSync(encodeHarness, `#include "library.h"\n#include <stdint.h>\n\n` +
  `int main(void) {\n` +
  `  const uint8_t input[BEND_LIBRARY_INPUT_BYTES] = {0, 1, 0, 0, 0, 0};\n` +
  `  uint8_t output[BEND_LIBRARY_OUTPUT_BYTES];\n` +
  `  uint64_t output_len = UINT64_C(0x1122334455667788);\n` +
  `  for (uint64_t i = 0; i < BEND_LIBRARY_OUTPUT_BYTES; ++i) output[i] = 0xa5;\n` +
  `  if (BEND_LIBRARY_CALL(input, sizeof(input), output, sizeof(output), &output_len) != BEND_LIBRARY_ABI_OUTPUT_ENCODING) return 1;\n` +
  `  if (output_len != UINT64_C(0x1122334455667788)) return 2;\n` +
  `  for (uint64_t i = 0; i < BEND_LIBRARY_OUTPUT_BYTES; ++i) if (output[i] != 0xa5) return 3;\n` +
  `  return 0;\n}\n`);
run(hostCompiler, ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', `-I${root}`,
  '-c', mutatedC, '-o', encodeObject]);
run(hostCompiler, ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', `-I${root}`,
  encodeHarness, encodeObject, '-o', encodeExecutable]);
run(path.resolve(encodeExecutable), []);
console.log('Host object verified canonical values, precedence, pointer safety and output-encoding failure');

const tools = sbfTools();
const rustcLauncher = path.resolve(tools, '../../rust/bin/rustc');
const rustc = fs.realpathSync(rustcLauncher);
const rustVersion = run(rustcLauncher, ['--version', '--verbose'], true);
assert(rustVersion.includes('1.89.0-dev') && rustVersion.includes('LLVM version: 20.1.7'),
  'Expected the Rust compiler shipped with Anza platform-tools v1.53');
const rustLinkFlags = ['--edition=2021', '--crate-type=cdylib', '--target', 'sbpf-solana-solana',
  '-C', 'target-cpu=generic', '-C', 'opt-level=2', '-C', 'panic=abort',
  '-Z', 'emit-stack-sizes=yes',
  '-C', `link-arg=${path.resolve(`${stem}.sbf.o`)}`];
const readelfLauncher = path.join(tools, 'llvm-readelf');
const mismatchProgram = `${root}/schema-mismatch-program.rs`;
const mismatchSource = fs.readFileSync('tests/mixed-library/program.rs', 'utf8')
  .replace('../../build/mixed-library/library.bindings.rs', 'schema-variant/library.bindings.rs');
assert.notEqual(mismatchSource, fs.readFileSync('tests/mixed-library/program.rs', 'utf8'));
fs.writeFileSync(mismatchProgram, mismatchSource);
const mismatchElf = `${root}/schema-mismatch.so`;
fs.rmSync(mismatchElf, { force: true });
const mismatchLink = spawnSync(rustcLauncher,
  [...rustLinkFlags, mismatchProgram, '-o', mismatchElf], { encoding: 'utf8' });
const mismatchLinkOutput = `${mismatchLink.stdout ?? ''}${mismatchLink.stderr ?? ''}`;
assert.equal(mismatchLink.status, 0, `SBF linker should preserve unresolved imports for loader validation: ${mismatchLinkOutput}`);
assert(fs.existsSync(mismatchElf), 'Wrong-schema binding probe must produce an ELF for loader validation');
const mismatchSymbols = run(readelfLauncher, ['-s', mismatchElf], true);
const mismatchSymbolLine = mismatchSymbols.split('\n').find(line => line.includes(schemaVariantManifest.symbol));
assert(mismatchSymbolLine && /\bUND\b/.test(mismatchSymbolLine),
  `Wrong-schema binding must remain an unresolved ELF import: ${mismatchSymbols}`);
const mismatchLinkReceipt = `${root}/schema-mismatch-elf.txt`;
fs.writeFileSync(mismatchLinkReceipt, mismatchLinkOutput + mismatchSymbols);
console.log('Same-root, same-width wrong-schema Rust binding remains an unresolved ELF import');
const rustFlags = [...rustLinkFlags, 'tests/mixed-library/program.rs', '-o', `${root}/mixed-library.so`];
run(rustcLauncher, rustFlags);
const readelf = fs.realpathSync(readelfLauncher);
const elfHeader = run(readelfLauncher, ['-h', `${root}/mixed-library.so`], true);
assert.match(elfHeader, /Flags:\s+0x0\b/, 'Expected pinned SBF v0 ELF flags');
const symbols = run(readelfLauncher, ['-s', `${root}/mixed-library.so`], true);
assert(symbols.includes(primaryManifest.symbol), 'Mixed ELF must contain the root/schema-specific Bend export');
const allowedImports = new Set(['abort', 'sol_set_return_data', 'sol_memcpy_', 'sol_memmove_', 'sol_memset_', 'sol_memcmp_']);
for (const line of symbols.split('\n').filter(line => /\bUND\b/.test(line))) {
  const symbol = line.trim().split(/\s+/).at(-1)!;
  assert(symbol === 'UND' || allowedImports.has(symbol), `Unexpected mixed SBF import: ${symbol}`);
}
const stackSizes = run(readelfLauncher, ['--stack-sizes', `${root}/mixed-library.so`], true);
const rustFrames = [...stackSizes.matchAll(/^\s+(\d+)\s+\S+/gm)].map(match => Number(match[1]));
assert(rustFrames.length > 0, `Pinned Rust stack-size metadata missing: ${stackSizes}`);
const rustMaxFrameBytes = Math.max(...rustFrames);
assert(rustMaxFrameBytes <= 4096, `Rust SBF frame exceeds 4096 bytes: ${rustMaxFrameBytes}`);
fs.writeFileSync(`${root}/rust-stack-sizes.txt`, stackSizes);
console.log('Pinned Anza Rust/Clang linked the root/schema-specific Bend object into one SBF v0 ELF');

const priorTarget = process.env.CARGO_TARGET_DIR;
const cargoTarget = path.resolve('target/mixed-library-cargo');
const cargo = executableRecord('cargo', ['--version']);
const hostRustc = executableRecord(process.env.RUSTC ?? 'rustc', ['--version', '--verbose']);
process.env.CARGO_TARGET_DIR = cargoTarget;
try {
  run('cargo', ['test', '--locked', '--test', 'mixed-library-sbf', '--', '--nocapture']);
} finally {
  if (priorTarget === undefined) delete process.env.CARGO_TARGET_DIR;
  else process.env.CARGO_TARGET_DIR = priorTarget;
}

const cargoTestDirectory = path.join(cargoTarget, 'debug', 'deps');
const cargoTestBinaries = fs.readdirSync(cargoTestDirectory)
  .filter(file => /^mixed_library_sbf-[0-9a-f]+$/.test(file))
  .map(file => path.join(cargoTestDirectory, file))
  .filter(file => (fs.statSync(file).mode & 0o111) !== 0);
assert(cargoTestBinaries.length > 0, `Cargo did not leave a mixed-library LiteSVM test binary in ${cargoTestDirectory}`);
const cargoTestBinary = cargoTestBinaries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

const anzaRustSysroot = run(rustcLauncher, ['--print', 'sysroot'], true);
const anzaTargetLibdir = run(rustcLauncher, ['--print', 'target-libdir', '--target', 'sbpf-solana-solana'], true);
const anzaTargetArtifacts = fs.readdirSync(anzaTargetLibdir).sort().map(file => path.join(anzaTargetLibdir, file))
  .filter(file => fs.statSync(file).isFile()).map(binaryRecord);
assert(anzaTargetArtifacts.some(file => path.basename(file.path).startsWith('libcompiler_builtins-')),
  'Receipt must include the Anza compiler_builtins artifact used by the Rust SBF link');
const targetSpec = JSON.parse(run(rustcLauncher,
  ['--print', 'target-spec-json', '-Z', 'unstable-options', '--target', 'sbpf-solana-solana'], true)) as { linker?: string };
const rustLinker = path.join(anzaRustSysroot, 'lib', 'rustlib', 'aarch64-apple-darwin', 'bin', targetSpec.linker ?? 'rust-lld');
assert(fs.existsSync(rustLinker), `Pinned Rust target linker missing: ${rustLinker}`);

const bunLauncher = commandPath('bun');
const bunBinary = fs.realpathSync(process.execPath);
const readelfInfo = toolRecord(readelfLauncher, ['--version']);
const anzaClangInfo = JSON.parse(fs.readFileSync(`${stem}.manifest.json`, 'utf8')).toolchains.anzaClang;
const anzaRustcInfo = toolRecord(rustcLauncher, ['--version', '--verbose']);
const rustLinkerInfo = toolRecord(rustLinker, ['-flavor', 'gnu', '--version']);
const libraryManifest = JSON.parse(fs.readFileSync(`${stem}.manifest.json`, 'utf8')) as {
  inputs: Record<string, string>; artifacts: Record<string, unknown>; dependencies: Record<string, string>;
  toolchains: Record<string, any>;
};
const alternateLibraryManifest = JSON.parse(fs.readFileSync(`${root}/alternate.manifest.json`, 'utf8')) as {
  inputs: Record<string, string>; artifacts: Record<string, unknown>;
};
const schemaVariantLibraryManifest = JSON.parse(
  fs.readFileSync(`${root}/schema-variant/library.manifest.json`, 'utf8')) as {
  inputs: Record<string, string>; artifacts: Record<string, unknown>;
};
assertManifestFileBound(`${stem}.manifest.json`, primaryManifest, acceptanceInputs, bendBefore, stem);
assertManifestFileBound(`${root}/alternate.manifest.json`, alternateManifest, acceptanceInputs, bendBefore,
  `${root}/alternate`);
assertManifestFileBound(`${root}/schema-variant/library.manifest.json`, schemaVariantManifest,
  acceptanceInputs, bendBefore, `${root}/schema-variant/library`);
const inputFiles = [...new Set([
  ...Object.keys(libraryManifest.inputs), ...Object.keys(alternateLibraryManifest.inputs),
  ...Object.keys(schemaVariantLibraryManifest.inputs), ...acceptanceTestInputs, ...libraryBuildInputs,
])].sort();
const sourceHashes = Object.fromEntries(inputFiles.map(file => {
  return [manifestFile(file), snapshotHash(acceptanceInputs, file)];
}));
assert(Object.keys(sourceHashes).some(file => file.endsWith('/compiler/native-arithmetic.ts') || file === 'compiler/native-arithmetic.ts'));
assert(Object.keys(sourceHashes).some(file => file.endsWith('/compiler/tagged-sum-ir.ts') || file === 'compiler/tagged-sum-ir.ts'));
assert(Object.keys(sourceHashes).some(file => file.endsWith('/compiler/diagnostics.ts') || file === 'compiler/diagnostics.ts'));
assert.equal(sourceHashes[manifestFile(bendBefore.checkerPath)], bendBefore.checkerSha256,
  'Acceptance receipt must bind the actual Bend checker bytes captured before work');

const generatedInputs = [
  `${stem}.h`, `${stem}.bindings.rs`, `${stem}.c`, `${stem}.schema.json`, `${stem}.sbf.o`,
  `${stem}.manifest.json`, `${root}/alternate.h`, `${root}/alternate.bindings.rs`,
  `${root}/alternate.c`, `${root}/alternate.sbf.o`, `${root}/alternate.host.o`,
  `${root}/alternate.sbf.memory.o`, `${root}/alternate.sbf.su`, `${root}/alternate.host.su`,
  `${root}/alternate.sbf.memory.su`, `${root}/alternate.schema.json`, `${root}/alternate.manifest.json`,
  `${root}/schema-variant/library.h`, `${root}/schema-variant/library.bindings.rs`,
  `${root}/schema-variant/library.c`, `${root}/schema-variant/library.sbf.o`,
  `${root}/schema-variant/library.host.o`, `${root}/schema-variant/library.sbf.memory.o`,
  `${root}/schema-variant/library.sbf.su`, `${root}/schema-variant/library.host.su`,
  `${root}/schema-variant/library.sbf.memory.su`, `${root}/schema-variant/library.schema.json`,
  `${root}/schema-variant/library.manifest.json`,
];
const artifacts = [
  ...generatedInputs,
  `${stem}.host.o`, `${stem}.sbf.memory.o`, `${stem}.sbf.su`, `${stem}.host.su`, `${stem}.sbf.memory.su`,
  `${root}/host-test`, mutatedC, encodeHarness, encodeObject, encodeExecutable,
  mismatchProgram, mismatchElf, mismatchLinkReceipt,
  `${schemaVariantSourceDir}/PROOF.bend`, `${schemaVariantSourceDir}/LAWS.bend`, `${schemaVariantSourceDir}/mixed.bend`,
  `${root}/mixed-library.so`, `${root}/rust-stack-sizes.txt`, `${root}/litesvm-metrics.json`,
  bindingMutationProbe.reportPath,
].map(file => [file, { bytes: fs.statSync(file).size, sha256: hash(file) }]);

const bendAfter = observePinnedBend();
assert.equal(bendAfter.observedCommit, bendBefore.observedCommit, 'Bend revision changed during acceptance');
assert.equal(bendAfter.clean, true, 'Bend dependency became dirty during acceptance');
assert.equal(bendAfter.checkerSha256, bendBefore.checkerSha256, 'Bend checker bytes changed during acceptance');
assertSnapshotUnchanged(acceptanceInputs, 'during mixed-library acceptance');
for (const [file, expected] of Object.entries(sourceHashes)) {
  assert.equal(hash(file), expected, `Acceptance end hash differs from its start capture: ${file}`);
}
const buildManifestHashes = Object.fromEntries([
  `${stem}.manifest.json`, `${root}/alternate.manifest.json`, `${root}/schema-variant/library.manifest.json`,
].map(file => [manifestFile(file), { bytes: fs.statSync(file).size, sha256: hash(file) }]));

const acceptance = {
  version: 3,
  priorEvidenceArchive: fs.existsSync(path.resolve(priorEvidenceArchive)) ? priorEvidenceArchive : null,
  bindingMutationProbe: {
    reportPath: manifestFile(bindingMutationProbe.reportPath),
    results: bindingMutationProbe.results,
  },
  sourceHashes,
  buildManifestHashes,
  generatedInputs: Object.fromEntries(generatedInputs.map(file => [file, { bytes: fs.statSync(file).size, sha256: hash(file) }])),
  dependencies: {
    ...libraryManifest.dependencies,
    rustManifest: snapshotHash(acceptanceInputs, 'Cargo.toml'),
    bendChecker: {
      expectedCommit: bendBefore.expectedCommit,
      observedCommitBefore: bendBefore.observedCommit,
      observedCommitAfter: bendAfter.observedCommit,
      cleanBefore: bendBefore.clean,
      cleanAfter: bendAfter.clean,
      path: manifestFile(bendBefore.checkerPath),
      sha256Before: bendBefore.checkerSha256,
      sha256After: bendAfter.checkerSha256,
    },
  },
  rootIdentities: [
    { root: bendRoot, symbol: primaryManifest.symbol, fingerprint: primaryManifest.schemaFingerprint,
      inputBytes: primaryManifest.canonicalInputBytes, outputBytes: primaryManifest.canonicalOutputBytes },
    { root: 'mixed.evaluate_alt', symbol: alternateManifest.symbol, fingerprint: alternateManifest.schemaFingerprint,
      inputBytes: alternateManifest.canonicalInputBytes, outputBytes: alternateManifest.canonicalOutputBytes },
    { root: bendRoot, symbol: schemaVariantManifest.symbol, fingerprint: schemaVariantManifest.schemaFingerprint,
      inputBytes: schemaVariantManifest.canonicalInputBytes, outputBytes: schemaVariantManifest.canonicalOutputBytes,
      schemaVariant: true },
  ],
  toolchains: {
    bun: {
      launcher: binaryRecord(bunLauncher),
      runtimeBinary: binaryRecord(bunBinary),
      version: process.versions.bun,
    },
    hostC: libraryManifest.toolchains.hostC,
    cargo,
    hostRustc,
    anzaClang: anzaClangInfo,
    anzaReadelf: readelfInfo,
    anzaRustc: anzaRustcInfo,
    anzaRustLinker: { ...rustLinkerInfo, targetSpecLinker: targetSpec.linker, target: 'sbpf-solana-solana' },
    anzaTargetLibraryDirectory: anzaTargetLibdir,
  },
  rustArtifacts: {
    anzaTargetLibraries: anzaTargetArtifacts,
    cargoTestBinary: binaryRecord(cargoTestBinary),
  },
  artifacts: Object.fromEntries(artifacts),
  sbpfVersion: 0,
  maxStackBytes: Math.max(primaryManifest.maxFrameBytes, rustMaxFrameBytes),
  litesvmMetrics: JSON.parse(fs.readFileSync(`${root}/litesvm-metrics.json`, 'utf8')),
};
assertSnapshotUnchanged(acceptanceInputs, 'before receipt publication');
try {
  publishAcceptedFinalSbfArtifact(`${root}/mixed-library.so`, `${root}/sbf-call-depth`, sbfCallDepth => {
    if (sbfCallDepth.checker.sha256 !== snapshotHash(acceptanceInputs, 'compiler/sbf-call-depth.ts')) {
      throw new Error('SBF_CALL_DEPTH_CHECKER_HASH_MISMATCH: checker receipt differs from captured acceptance source');
    }
    verifyFinalSbfArtifactReceipt(sbfCallDepth, `${root}/mixed-library.so`);
    if (sbfCallDepth.artifact.sha256 !== hash(`${root}/mixed-library.so`) ||
        sbfCallDepth.artifact.byteLength !== fs.statSync(`${root}/mixed-library.so`).size) {
      throw new Error('SBF_CALL_DEPTH_ELF_HASH_MISMATCH: call-depth receipt differs from the linked mixed ELF');
    }
    assertSnapshotUnchanged(acceptanceInputs, 'before receipt publication');
    const report = path.resolve(sbfCallDepth.report.path);
    const acceptanceWithCallDepth = {
      ...acceptance,
      sbfCallDepth,
      artifacts: {
        ...acceptance.artifacts,
        [manifestFile(report)]: { bytes: fs.statSync(report).size, sha256: hash(report) },
      },
    };
    const receiptTemporary = `${root}/acceptance.${runId}.tmp`;
    fs.writeFileSync(receiptTemporary, JSON.stringify(acceptanceWithCallDepth, null, 2) + '\n');
    fs.renameSync(receiptTemporary, `${root}/acceptance.json`);
  }, { buildRunId: runId });
} catch (error) {
  const archivedElf = quarantineRefusedMixedElf();
  throw new Error(`${error instanceof Error ? error.message : String(error)}${archivedElf ? `; refused ELF archived at ${archivedElf}` : ''}`);
}
console.log(`Mixed library acceptance recorded in ${root}/acceptance.json`);
