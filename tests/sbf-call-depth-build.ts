import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { build } from '../scripts/build.ts';
import { buildProgram } from '../scripts/program.ts';
import {
  checkFinalSbfArtifact,
  verifyFinalSbfArtifactReceipt,
  type SbfCallDepthArtifactReceipt,
} from '../compiler/sbf-call-depth-artifact.ts';
import { assertReproducibleProgramBuilds, programBuildSnapshot } from './program-build-reproducibility.ts';

type Manifest = {
  inputs: Record<string, string>;
  sbfCallDepth?: SbfCallDepthArtifactReceipt;
  buildRunId?: string;
  elfSha256?: string;
  elfBytes?: number;
  artifacts?: Record<string, string | { sha256: string; bytes?: number }>;
};

const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const uniqueId = () => new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + crypto.randomUUID();

function rootPath(root: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(root, file);
}

function readJson<T>(file: string): T {
  assert(fs.existsSync(file), 'Missing evidence file: ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function assertAcceptedReceipt(root: string, manifest: Manifest, elfPath: string): SbfCallDepthArtifactReceipt {
  const receipt = manifest.sbfCallDepth;
  assert(receipt, 'Success manifest must include a final-ELF call-depth receipt');
  assert.equal(receipt.status, 'accepted');
  const elf = path.resolve(elfPath);
  assert.equal(path.resolve(rootPath(root, receipt.artifact.path)), elf);
  assert.equal(hash(elf), receipt.artifact.sha256);
  assert.equal(fs.statSync(elf).size, receipt.artifact.byteLength);
  assert.equal(receipt.checker.sha256, hash(rootPath(root, receipt.checker.path)));
  assert.equal(manifest.inputs[receipt.checker.path], receipt.checker.sha256,
    'success manifest must bind the checker source used by the receipt');
  assert.equal(receipt.configuration.profile, 'solana-sbpf-v0');
  assert.equal(receipt.configuration.sbpfVersion, 0);
  assert.equal(receipt.configuration.maxActiveFramesIncludingEntry, 64);
  assert.equal(receipt.configuration.frameSizeBytes, 4096);
  assert(receipt.analysis.longestFrameCount > 0);
  assert(receipt.analysis.longestFramePath.length > 0);

  const reportPath = rootPath(root, receipt.report.path);
  assert.equal(hash(reportPath), receipt.report.sha256);
  assert.equal(fs.statSync(reportPath).size, receipt.report.byteLength);
  const report = readJson<any>(reportPath);
  assert.equal(report.status, 'accepted');
  assert.equal(report.runId, receipt.runId);
  assert.deepEqual(report.configuration, receipt.configuration);
  assert.deepEqual(report.assumptions, receipt.assumptions);
  assert.equal(report.artifact.sha256, receipt.artifact.sha256);
  assert.equal(report.checker.sha256, receipt.checker.sha256);
  assert.equal(report.checkerReport.analysis.longestFrameCount, receipt.analysis.longestFrameCount);

  if (manifest.buildRunId !== undefined) {
    assert.equal(typeof manifest.buildRunId, 'string');
    assert.notEqual(manifest.buildRunId, receipt.runId, 'build and gate run IDs identify separate stages');
  }
  if (manifest.elfSha256 !== undefined) assert.equal(manifest.elfSha256, receipt.artifact.sha256);
  if (manifest.elfBytes !== undefined) assert.equal(manifest.elfBytes, receipt.artifact.byteLength);
  const elfArtifact = manifest.artifacts?.['.so'];
  if (typeof elfArtifact === 'string') assert.equal(elfArtifact, receipt.artifact.sha256);
  else if (elfArtifact) assert.equal(elfArtifact.sha256, receipt.artifact.sha256);
  return receipt;
}

function copyTree(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, dereference: true });
}

function linkDirectory(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(path.resolve(source), destination, 'dir');
}

function makeProgramPipelineCopy(stage: string): void {
  fs.mkdirSync(stage, { recursive: true });
  for (const directory of ['compiler', 'runtime', 'sdk']) copyTree(directory, path.join(stage, directory));
  for (const file of ['scripts/build.ts', 'scripts/program.ts']) {
    const destination = path.join(stage, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
  for (const directory of ['vault', 'escrow']) copyTree(path.join('examples', directory), path.join(stage, 'examples', directory));
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(file, path.join(stage, file));
  linkDirectory('.deps', path.join(stage, '.deps'));
  linkDirectory('node_modules', path.join(stage, 'node_modules'));
}

function runBun(stage: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(process.execPath, args, { cwd: stage, encoding: 'utf8', env: process.env });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function collectJson(directory: string, result: string[] = []): string[] {
  if (!fs.existsSync(directory)) return result;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJson(file, result);
    else if (entry.isFile() && entry.name.endsWith('.json')) result.push(file);
  }
  return result;
}

function findRefusalReport(stage: string, artifactSha256: string): { path: string; report: any } {
  const matches = collectJson(path.join(stage, 'build')).flatMap(file => {
    let report: any;
    try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
    return report?.status === 'refused' && report?.artifact?.sha256 === artifactSha256 ? [{ path: file, report }] : [];
  });
  assert.equal(matches.length, 1, 'Expected exactly one refusal report bound to the quarantined ELF');
  return matches[0];
}

function assertRefusalReport(stage: string, elfPath: string, expectedCode: string, diagnosticCode: string): void {
  const { path: reportPath, report } = findRefusalReport(stage, hash(elfPath));
  assert.equal(report.refusal.code, expectedCode);
  assert.equal(report.checkerReport.status, 'refused');
  assert(report.checkerReport.diagnostics.some((diagnostic: { code: string }) => diagnostic.code === diagnosticCode),
    'refusal report must contain ' + diagnosticCode);
  assert.equal(report.checker.sha256, hash(rootPath(stage, report.checker.path)));
  assert.equal(report.artifact.sha256, hash(elfPath));
  assert.equal(fs.statSync(elfPath).size, report.artifact.byteLength);
  assert(fs.statSync(reportPath).size > 0);
}

function injectGeneratedCRecursion(programScript: string): void {
  const original = fs.readFileSync(programScript, 'utf8');
  const marker = '  writeArtifacts(stem,emitted,root,layout);\n';
  assert.equal(original.split(marker).length - 1, 1, 'test copy must patch the post-generation point exactly once');
  const injection = [
    marker.trimEnd(),
    "  const generatedCPath = stem + '.c';",
    "  let generatedC = fs.readFileSync(generatedCPath, 'utf8');",
    "  const entrypointMarker = 'u64 entrypoint(const u8 *input) {';",
    "  if (!generatedC.includes(entrypointMarker)) throw new Error('test recursion injection lost its entrypoint marker');",
    "  const recursiveFunction = '__attribute__((noinline,optnone)) static u64 sbf_call_depth_test(u64 n, u64 value) {\\n' +",
    "    '  if (!n) return value;\\n' +",
    "    '  volatile u64 nested = sbf_call_depth_test(n - 1, value + n);\\n' +",
    "    '  return nested + 1;\\n' +",
    "    '}\\n';",
    "  generatedC = generatedC.replace(entrypointMarker, recursiveFunction + entrypointMarker + '\\n  if (read_le(input, 8) == ~0ULL) (void)sbf_call_depth_test(4, 0);');",
    '  fs.writeFileSync(generatedCPath, generatedC);',
    '',
  ].join('\n');
  fs.writeFileSync(programScript, original.replace(marker, injection));
}

function injectUnsupportedImport(programScript: string): void {
  const original = fs.readFileSync(programScript, 'utf8');
  const marker = '  writeArtifacts(stem,emitted,root,layout);\n';
  assert.equal(original.split(marker).length - 1, 1, 'test copy must patch the post-generation point exactly once');
  const injection = [
    marker.trimEnd(),
    "  let generatedC = fs.readFileSync(stem + '.c', 'utf8');",
    "  const entrypointMarker = 'u64 entrypoint(const u8 *input) {';",
    "  const unsupportedImport = 'extern u64 sol_log_(const u8 *);\\n' + entrypointMarker + '\\n  if (read_le(input, 8) == ~0ULL) (void)sol_log_((const u8 *)\"test\");';",
    "  if (!generatedC.includes(entrypointMarker)) throw new Error('test import injection lost its entrypoint marker');",
    '  generatedC = generatedC.replace(entrypointMarker, unsupportedImport);',
    "  fs.writeFileSync(stem + '.c', generatedC);",
    '',
  ].join('\n');
  fs.writeFileSync(programScript, original.replace(marker, injection));
}

function injectPublicationThrow(programScript: string): void {
  const original = fs.readFileSync(programScript, 'utf8');
  const marker = '        verifyFinalSbfArtifactReceipt(callDepth, `${stem}.so`);';
  assert.equal(original.split(marker).length - 1, 1, 'test copy must patch the receipt publication point exactly once');
  fs.writeFileSync(programScript, original.replace(marker,
    `${marker}\n        throw new Error('test-only publication failure');`));
}

function injectRuntimeCRecursion(entrypointPath: string): void {
  const original = fs.readFileSync(entrypointPath, 'utf8');
  const marker = 'u64 entrypoint(const u8 *input) {';
  assert.equal(original.split(marker).length - 1, 1, 'test copy must find one runtime entrypoint');
  const recursiveFunction = [
    '__attribute__((noinline,optnone)) static u64 sbf_call_depth_test(u64 n, u64 value) {',
    '  if (!n) return value;',
    '  volatile u64 nested = sbf_call_depth_test(n - 1, value + n);',
    '  return nested + 1;',
    '}',
    '',
  ].join('\n');
  const changed = original.replace(marker, recursiveFunction + marker +
    '\n  if (read_le(input, 8) == ~0ULL) (void)sbf_call_depth_test(4, 0);');
  assert.notEqual(changed, original);
  fs.writeFileSync(entrypointPath, changed);
}

function assertRefusalProcess(result: ReturnType<typeof runBun>, label: string): string {
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, label + ' must start the build process');
  assert.notEqual(result.status, 0, label + ' must refuse the linked ELF');
  assert.match(output, /SBF_CALL_DEPTH_REFUSED/,
    label + ' must fail with the call-depth semantic refusal, not a compile or spawn failure');
  assert.match(output, /recursive_call_graph/);
  assert.doesNotMatch(output, /clang failed|ld\.lld failed|Cannot locate compiler executable/);
  return output;
}

async function testCheckerThrowEvidence(elfPath: string, probeRoot: string): Promise<void> {
  const compiler = path.join(probeRoot, 'throwing-checker', 'compiler');
  fs.mkdirSync(compiler, { recursive: true });
  fs.copyFileSync('compiler/sbf-call-depth-artifact.ts', path.join(compiler, 'sbf-call-depth-artifact.ts'));
  fs.writeFileSync(path.join(compiler, 'sbf-call-depth.ts'), [
    'export type SbfCallDepthReport = any;',
    "export function checkSbfCallDepth(): never { throw new Error('test-only checker exception'); }",
    '',
  ].join('\n'));
  const driver = path.join(probeRoot, 'throwing-checker', 'driver.ts');
  fs.writeFileSync(driver, [
    "import { checkFinalSbfArtifact } from './compiler/sbf-call-depth-artifact.ts';",
    'let caught: any = null;',
    'try { checkFinalSbfArtifact(process.argv[2], process.argv[3]); } catch (error) {',
    '  const value = error as any; caught = { code: value.code, message: value.message, evidence: value.evidence };',
    '}',
    'process.stdout.write(JSON.stringify(caught));',
    '',
  ].join('\n'));
  const reportDirectory = path.join(probeRoot, 'throwing-checker', 'reports');
  const result = spawnSync(process.execPath, [driver, path.resolve(elfPath), reportDirectory], {
    cwd: process.cwd(), encoding: 'utf8', env: process.env,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const caught = JSON.parse(result.stdout) as { code: string; message: string; evidence: { reportPath: string; reportSha256: string } };
  assert.equal(caught.code, 'SBF_CALL_DEPTH_CHECKER_ERROR');
  assert.match(caught.message, /test-only checker exception/);
  const reportPath = rootPath(process.cwd(), caught.evidence.reportPath);
  const report = readJson<any>(reportPath);
  assert.equal(report.status, 'refused');
  assert.equal(report.refusal.code, caught.code);
  assert.equal(report.checkerReport, null);
  assert.equal(report.artifact.sha256, hash(elfPath));
  assert.equal(report.checker.sha256, hash(path.join(compiler, 'sbf-call-depth.ts')));
  assert.equal(hash(reportPath), caught.evidence.reportSha256);
}

export async function testSbfCallDepthBuild(ordinaryBuildAlreadyRan = false): Promise<void> {
  if (!ordinaryBuildAlreadyRan) await build();
  const root = process.cwd();
  const ordinaryElf = path.resolve('build/escrow.so');
  const ordinaryManifest = readJson<Manifest>(path.resolve('build/manifest.json'));
  const ordinaryReceipt = assertAcceptedReceipt(root, ordinaryManifest, ordinaryElf);
  verifyFinalSbfArtifactReceipt(ordinaryReceipt, ordinaryElf);

  const attemptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbf-call-depth-build-'));
  const tamperRoot = path.join(attemptRoot, 'receipt-tamper-' + uniqueId());
  const tamperedElf = path.join(tamperRoot, 'tampered.so');
  fs.mkdirSync(tamperRoot, { recursive: true });
  const tamperedBytes = Buffer.from(fs.readFileSync(ordinaryElf));
  tamperedBytes[0] ^= 0xff;
  fs.writeFileSync(tamperedElf, tamperedBytes);
  assert.throws(() => verifyFinalSbfArtifactReceipt({
    ...ordinaryReceipt,
    artifact: { ...ordinaryReceipt.artifact, path: path.resolve(tamperedElf) },
  }, tamperedElf), (error: any) => error.code === 'SBF_CALL_DEPTH_ELF_HASH_MISMATCH');
  assert.throws(() => verifyFinalSbfArtifactReceipt({
    ...ordinaryReceipt,
    checker: { ...ordinaryReceipt.checker, sha256: '0'.repeat(64) },
  }, ordinaryElf), (error: any) => error.code === 'SBF_CALL_DEPTH_CHECKER_HASH_MISMATCH');
  assert.throws(() => verifyFinalSbfArtifactReceipt({
    ...ordinaryReceipt,
    configuration: { ...ordinaryReceipt.configuration, maxActiveFramesIncludingEntry: 65 },
  }, ordinaryElf), (error: any) => error.code === 'SBF_CALL_DEPTH_UNSUPPORTED_PROFILE');
  const originalReport = readJson<any>(rootPath(root, ordinaryReceipt.report.path));
  originalReport.runId = 'stale-' + originalReport.runId;
  const tamperedReport = path.join(tamperRoot, 'stale-report.json');
  fs.writeFileSync(tamperedReport, JSON.stringify(originalReport, null, 2) + '\n');
  assert.throws(() => verifyFinalSbfArtifactReceipt({
    ...ordinaryReceipt,
    report: { ...ordinaryReceipt.report, path: path.relative(root, tamperedReport) },
  }, ordinaryElf), (error: any) => error.code === 'SBF_CALL_DEPTH_REPORT_HASH_MISMATCH');

  const attempt = uniqueId();
  const outputRoot = path.join(attemptRoot, 'project-build', attempt);
  const projectStem = path.join(outputRoot, 'current-project');
  const projectManifest = await buildProgram('examples/vault/PROOF.bend', 'vault.process', projectStem);
  const projectReceipt = assertAcceptedReceipt(root, projectManifest as Manifest, projectStem + '.so');
  verifyFinalSbfArtifactReceipt(projectReceipt, projectStem + '.so');

  const probeRoot = path.join(attemptRoot, 'probes', attempt);
  const stage = path.join(probeRoot, 'project-pipeline');
  makeProgramPipelineCopy(stage);
  const control = runBun(stage, ['scripts/program.ts', 'examples/vault/PROOF.bend', 'vault.process', 'build/project-control']);
  assert.equal(control.error, undefined, control.stderr);
  assert.equal(control.status, 0, control.stdout + control.stderr);
  const controlElf = path.join(stage, 'build/project-control.so');
  const controlManifest = readJson<Manifest>(path.join(stage, 'build/project-control.manifest.json'));
  const controlReceipt = assertAcceptedReceipt(stage, controlManifest, controlElf);
  assert.match(control.stdout, /Built build\/project-control\.so/);

  const sameStemRoot = path.join(attemptRoot, 'same-stem');
  const sameStemA = path.join(sameStemRoot, 'left', 'program');
  const sameStemB = path.join(sameStemRoot, 'right', 'program');
  const sameStemManifestA = await buildProgram('examples/vault/PROOF.bend', 'vault.process', sameStemA);
  const sameStemManifestB = await buildProgram('examples/vault/PROOF.bend', 'vault.process', sameStemB);
  assert.equal(path.basename(sameStemA), path.basename(sameStemB));
  assertReproducibleProgramBuilds(programBuildSnapshot(sameStemManifestA, sameStemA),
    programBuildSnapshot(sameStemManifestB, sameStemB), 'Same-stem builds in different directories must reproduce stable content');

  const secondStemSnapshot = programBuildSnapshot(sameStemManifestB, sameStemB);
  const assertManifestTamperRejected = (mutate: (manifest: any) => void, expectedCode: string) => {
    const manifestPath = secondStemSnapshot.manifestPath;
    const original = fs.readFileSync(manifestPath);
    const changed = JSON.parse(original.toString('utf8'));
    mutate(changed);
    fs.writeFileSync(manifestPath, JSON.stringify(changed, null, 2) + '\n');
    try {
      assert.throws(() => assertReproducibleProgramBuilds(programBuildSnapshot(sameStemManifestA, sameStemA),
        { ...secondStemSnapshot, manifest: changed }), (error: any) => error.code === expectedCode);
    } finally {
      fs.writeFileSync(manifestPath, original);
    }
  };
  assertManifestTamperRejected(manifest => { manifest.artifacts['.so'] = '0'.repeat(64); }, 'ERR_ASSERTION');
  assertManifestTamperRejected(manifest => { manifest.inputs[manifest.source] = '0'.repeat(64); }, 'ERR_ASSERTION');
  assertManifestTamperRejected(manifest => { manifest.sbfCallDepth.artifact.sha256 = '0'.repeat(64); }, 'SBF_CALL_DEPTH_ELF_HASH_MISMATCH');
  assertManifestTamperRejected(manifest => {
    manifest.sbfCallDepth.checker.sha256 = '0'.repeat(64);
    manifest.inputs[manifest.sbfCallDepth.checker.path] = '0'.repeat(64);
  }, 'SBF_CALL_DEPTH_CHECKER_HASH_MISMATCH');
  assertManifestTamperRejected(manifest => { manifest.sbfCallDepth.configuration.maxActiveFramesIncludingEntry = 65; },
    'SBF_CALL_DEPTH_UNSUPPORTED_PROFILE');
  const secondElfBytes = fs.readFileSync(secondStemSnapshot.elfPath);
  const changedElfBytes = Buffer.from(secondElfBytes);
  changedElfBytes[0] ^= 0xff;
  fs.writeFileSync(secondStemSnapshot.elfPath, changedElfBytes);
  try {
    assert.throws(() => assertReproducibleProgramBuilds(programBuildSnapshot(sameStemManifestA, sameStemA), secondStemSnapshot),
      (error: any) => error.code === 'SBF_CALL_DEPTH_ELF_HASH_MISMATCH');
  } finally {
    fs.writeFileSync(secondStemSnapshot.elfPath, secondElfBytes);
  }

  const programScript = path.join(stage, 'scripts/program.ts');
  const cleanProgramScript = fs.readFileSync(programScript, 'utf8');
  injectUnsupportedImport(programScript);
  const unsupportedImport = runBun(stage, ['scripts/program.ts', 'examples/vault/PROOF.bend', 'vault.process', 'build/project-unsupported-import']);
  assert.equal(unsupportedImport.error, undefined, unsupportedImport.stderr);
  assert.notEqual(unsupportedImport.status, 0, 'post-link unsupported import must fail the project build');
  assert.match(unsupportedImport.stdout + unsupportedImport.stderr, /Unsupported SBF import: sol_log_/);
  const unsupportedQuarantines = fs.readdirSync(path.join(stage, 'build/sbf-call-depth-refused'))
    .filter(directory => fs.existsSync(path.join(stage, 'build/sbf-call-depth-refused', directory, 'project-unsupported-import.so')));
  assert.equal(unsupportedQuarantines.length, 1, 'linked unsupported-import ELF must be quarantined');
  assert.equal(fs.existsSync(path.join(stage, 'build/project-unsupported-import.so')), false,
    'post-link unsupported import must not remain at the normal ELF path');
  assert.equal(fs.existsSync(path.join(stage, 'build/project-unsupported-import.manifest.json')), false,
    'post-link unsupported import must not publish a success manifest');

  fs.writeFileSync(programScript, cleanProgramScript);
  const priorPublicationControl = runBun(stage, ['scripts/program.ts', 'examples/vault/PROOF.bend', 'vault.process', 'build/project-publication-failure']);
  assert.equal(priorPublicationControl.error, undefined, priorPublicationControl.stderr);
  assert.equal(priorPublicationControl.status, 0, priorPublicationControl.stdout + priorPublicationControl.stderr);
  const priorPublicationManifest = readJson<Manifest>(path.join(stage, 'build/project-publication-failure.manifest.json'));
  const priorPublicationReceipt = assertAcceptedReceipt(stage, priorPublicationManifest,
    path.join(stage, 'build/project-publication-failure.so'));

  injectPublicationThrow(programScript);
  const publicationFailure = runBun(stage, ['scripts/program.ts', 'examples/vault/PROOF.bend', 'vault.process', 'build/project-publication-failure']);
  assert.equal(publicationFailure.error, undefined, publicationFailure.stderr);
  assert.notEqual(publicationFailure.status, 0, 'a throwing publish callback must fail the project build');
  assert.match(publicationFailure.stdout + publicationFailure.stderr, /SBF_CALL_DEPTH_PUBLICATION_FAILED/);
  const publicationReports = collectJson(path.join(stage, 'build'))
    .map(file => ({ file, report: readJson<any>(file) }))
    .filter(item => item.report?.code === 'SBF_CALL_DEPTH_PUBLICATION_FAILED' &&
      item.report?.artifact?.path?.includes('project-publication-failure.so'));
  assert.equal(publicationReports.length, 1, 'publish callback failure must write one correlated refusal report');
  const publicationReport = publicationReports[0].report;
  assert(publicationReport.buildRunId && publicationReport.gateRunId);
  assert.notEqual(publicationReport.buildRunId, publicationReport.gateRunId,
    'build and gate run identifiers must remain distinguishable');
  assert.equal(publicationReport.status, 'refused');
  assert.equal(publicationReport.cause.message, 'test-only publication failure');
  assert.equal(publicationReport.acceptedGateObservation.status, 'accepted');
  assert.equal(publicationReport.acceptedGateObservation.receipt.runId, publicationReport.gateRunId);
  const acceptedObservationPath = rootPath(stage, publicationReport.acceptedGateObservation.report.path);
  assert.equal(hash(acceptedObservationPath), publicationReport.acceptedGateObservation.report.sha256,
    'the accepted checker report must remain intact as the publication-failure intermediate observation');
  const publicationHashInOutput = (publicationFailure.stdout + publicationFailure.stderr).match(/publication refusal report .* \(SHA-256 ([0-9a-f]{64})\)/);
  assert(publicationHashInOutput, 'build failure must identify the refusal report hash');
  assert.equal(hash(publicationReports[0].file), publicationHashInOutput[1]);
  const publicationQuarantines = fs.readdirSync(path.join(stage, 'build/sbf-call-depth-refused'))
    .filter(directory => fs.existsSync(path.join(stage, 'build/sbf-call-depth-refused', directory, 'project-publication-failure.so')));
  assert.equal(publicationQuarantines.length, 1);
  assert.equal(publicationQuarantines[0], `project-publication-failure-${publicationReport.buildRunId}`,
    'the quarantined ELF must correlate to the build ID in the publication refusal record');
  const publicationQuarantinedElf = path.join(stage, 'build/sbf-call-depth-refused', publicationQuarantines[0], 'project-publication-failure.so');
  assert.equal(hash(publicationQuarantinedElf), publicationReport.artifact.sha256,
    'publication refusal must identify the preserved ELF bytes');
  assert.equal(fs.existsSync(path.join(stage, 'build/project-publication-failure.so')), false);
  assert.equal(fs.existsSync(path.join(stage, 'build/project-publication-failure.manifest.json')), false);
  const priorPublicationArchive = path.join(stage, 'build/sbf-call-depth-archive',
    `project-publication-failure-${publicationReport.buildRunId}`);
  const archivedPublicationManifest = path.join(priorPublicationArchive, 'project-publication-failure.manifest.json');
  const archivedPublicationElf = path.join(priorPublicationArchive, 'project-publication-failure.so');
  assert(fs.existsSync(archivedPublicationManifest), 'a prior success manifest must survive a later publication failure');
  assert.equal(hash(archivedPublicationElf), priorPublicationReceipt.artifact.sha256,
    'the prior accepted ELF must remain archived without mutation');
  assert.equal(hash(rootPath(stage, priorPublicationReceipt.report.path)), priorPublicationReceipt.report.sha256,
    'the prior accepted gate report must remain available after archiving its manifest and ELF');

  fs.writeFileSync(programScript, cleanProgramScript);

  injectGeneratedCRecursion(programScript);
  const refusal = runBun(stage, ['scripts/program.ts', 'examples/vault/PROOF.bend', 'vault.process', 'build/project-recursive']);
  const refusalOutput = assertRefusalProcess(refusal, 'buildProgram project control');
  const refusalDirectories = fs.readdirSync(path.join(stage, 'build/sbf-call-depth-refused'));
  assert.equal(refusalDirectories.length, 3);
  const refusalDirectory = refusalDirectories.find(directory =>
    fs.existsSync(path.join(stage, 'build/sbf-call-depth-refused', directory, 'project-recursive.so')));
  assert(refusalDirectory);
  const refusedElf = path.join(stage, 'build/sbf-call-depth-refused', refusalDirectory, 'project-recursive.so');
  assert(fs.existsSync(refusedElf), 'refused buildProgram ELF must be quarantined with its bytes preserved');
  assert.notEqual(hash(refusedElf), hash(controlElf), 'the injected final program must differ from its accepted control');
  assert(fs.existsSync(path.join(stage, 'build/project-recursive.c')));
  assert(fs.existsSync(path.join(stage, 'build/project-recursive.o')),
    'the refused ELF must have passed C compilation before reaching the final-image gate');
  assert.equal(fs.existsSync(path.join(stage, 'build/project-recursive.so')), false,
    'the refused ELF must not remain at the normal project artifact path');
  assert.equal(fs.existsSync(path.join(stage, 'build/project-recursive.manifest.json')), false,
    'a refused project build must not publish its manifest');
  assertRefusalReport(stage, refusedElf, 'SBF_CALL_DEPTH_REFUSED', 'recursive_call_graph');
  assert.match(refusalOutput, /refusal report/);

  const ordinaryControl = runBun(stage, ['scripts/build.ts']);
  assert.equal(ordinaryControl.error, undefined, ordinaryControl.stderr);
  assert.equal(ordinaryControl.status, 0, ordinaryControl.stdout + ordinaryControl.stderr);
  const privateOrdinaryElf = path.join(stage, 'build/escrow.so');
  const privateOrdinaryManifest = readJson<Manifest>(path.join(stage, 'build/manifest.json'));
  assertAcceptedReceipt(stage, privateOrdinaryManifest, privateOrdinaryElf);
  const privateOrdinaryHash = hash(privateOrdinaryElf);

  injectRuntimeCRecursion(path.join(stage, 'runtime/entrypoint.c'));
  const ordinaryRefusal = runBun(stage, ['scripts/build.ts']);
  const ordinaryRefusalOutput = assertRefusalProcess(ordinaryRefusal, 'ordinary escrow control');
  const ordinaryRefusalDirectories = fs.readdirSync(path.join(stage, 'build/sbf-call-depth-refused'));
  assert.equal(ordinaryRefusalDirectories.length, 4);
  const ordinaryRefusalDirectory = ordinaryRefusalDirectories.find(directory =>
    fs.existsSync(path.join(stage, 'build/sbf-call-depth-refused', directory, 'escrow.so')));
  assert(ordinaryRefusalDirectory, 'ordinary pipeline must create its own refusal quarantine');
  const refusedOrdinaryElf = path.join(stage, 'build/sbf-call-depth-refused', ordinaryRefusalDirectory, 'escrow.so');
  assert(fs.existsSync(refusedOrdinaryElf));
  assert.notEqual(hash(refusedOrdinaryElf), privateOrdinaryHash,
    'the ordinary recursive ELF must differ from its accepted build control');
  assert.equal(fs.existsSync(privateOrdinaryElf), false,
    'the refused escrow ELF must not remain at build/escrow.so for direct test loading');
  assert.equal(fs.existsSync(path.join(stage, 'build/manifest.json')), false,
    'the refused escrow build must not retain a success manifest');
  assertRefusalReport(stage, refusedOrdinaryElf, 'SBF_CALL_DEPTH_REFUSED', 'recursive_call_graph');
  assert.match(ordinaryRefusalOutput, /refusal report/);

  const priorCwd = process.cwd();
  const cwdProbe = path.resolve(probeRoot, 'foreign-cwd');
  fs.mkdirSync(cwdProbe, { recursive: true });
  try {
    process.chdir(cwdProbe);
    const cwdReceipt = checkFinalSbfArtifact(ordinaryElf, path.join(cwdProbe, 'reports'));
    assert.equal(cwdReceipt.checker.path, path.resolve(root, 'compiler/sbf-call-depth.ts'));
    verifyFinalSbfArtifactReceipt(cwdReceipt, ordinaryElf);
  } finally {
    process.chdir(priorCwd);
  }

  await testCheckerThrowEvidence(ordinaryElf, probeRoot);
  console.log('Final-ELF call-depth gate passed ordinary/project controls, same-stem reproducibility, ELF/receipt/profile tamper controls, unsupported-import cleanup, publication refusal evidence, recursion refusal, quarantine, and checker-error evidence');
  fs.rmSync(attemptRoot, { recursive: true, force: true });
}

if (import.meta.main) await testSbfCallDepthBuild();
