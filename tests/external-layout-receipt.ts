import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {environmentReceipt} from './external-layout';

const repositoryRoot = path.resolve(process.cwd());
const sharedRoot = repositoryRoot;
const probeRoot = path.resolve(process.env.EXTERNAL_LAYOUT_RECEIPT_ROOT ?? path.join(repositoryRoot, 'build', `external-layout-receipt-probes-${process.pid}-${crypto.randomUUID()}`));

// Copy the current gate's source closure, never an ignored developer snapshot
// or another worktree. Each probe gets fresh private outputs.
const sourceFiles = [
  'Cargo.toml', 'Cargo.lock', 'scripts/build.ts', 'compiler/diagnostics.ts',
  'runtime/solana_min.h', 'runtime/memory.c', 'runtime/sbf.ld', 'tests/sbf.rs',
  'compiler/external-layout.ts',
  'sdk/external-layout.ts',
  'runtime/bend_external_view.h',
  'tests/external-layout.ts',
  'tests/external-layout-sbf.rs',
  'tests/external-layout/sbf-entry.c',
  'docs/external-layout.md',
  'tests/external-layout-receipt.ts',
];

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashFile(file: string): string {
  return sha256(fs.readFileSync(file));
}

function requireFile(root: string, relative: string): string {
  const candidate = path.join(root, relative);
  assert(fs.statSync(candidate, {throwIfNoEntry: false})?.isFile(), `missing required file ${candidate}`);
  return candidate;
}

function ensureNoExistingPath(target: string): void {
  assert.equal(fs.lstatSync(target, {throwIfNoEntry: false}), undefined, `refusing to replace existing fixture path: ${target}`);
}

function linkSharedDirectory(fixture: string, name: '.deps' | 'node_modules'): void {
  const target = path.join(fixture, name);
  ensureNoExistingPath(target);
  const source = fs.realpathSync(path.join(sharedRoot, name));
  fs.symlinkSync(source, target, 'dir');
}

function createFixture(name: string): {root: string; overlayHashes: Record<string, string>} {
  const root = path.join(probeRoot, name);
  ensureNoExistingPath(root);
  fs.mkdirSync(root, {recursive: true});
  const overlayHashes: Record<string, string> = {};
  for (const relative of sourceFiles) {
    const source = requireFile(repositoryRoot, relative);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(source, target);
    overlayHashes[relative] = hashFile(target);
  }
  linkSharedDirectory(root, '.deps');
  linkSharedDirectory(root, 'node_modules');
  return {root, overlayHashes};
}

function privateEnvironment(fixture: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CARGO_TARGET_DIR: process.env.EXTERNAL_LAYOUT_CARGO_TARGET ?? process.env.CARGO_TARGET_DIR ?? path.join(repositoryRoot, 'build', 'external-layout-receipt-target'),
  };
}

function runBun(fixture: string, args: string[], env: NodeJS.ProcessEnv): {status: number | null; output: string; signal: NodeJS.Signals | null} {
  const result = spawnSync(process.execPath, args, {
    cwd: fixture,
    env,
    encoding: 'utf8',
    timeout: 1_800_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\nspawn error: ${result.error.message}` : ''}`;
  return {status: result.status, signal: result.signal, output};
}

function requireReport(fixture: string): any {
  const reportPath = path.join(fixture, 'build/external-layout-report.json');
  assert(fs.statSync(reportPath, {throwIfNoEntry: false})?.isFile(), `gate did not publish its report: ${reportPath}`);
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function assertSharedGateCases(report: any): void {
  assert.equal(report.typescript.passed, 10, 'all ten accepted TypeScript groups must remain covered');
  assert.equal(report.generatedC.passed, 11, 'all eleven accepted C groups must remain covered');
  assert.equal(report.generatedSbf.compileChecks.length, 2, 'both accepted SBF compile checks must remain covered');
}

export function testExternalLayoutReceipt(): void {
  const privateValue = 'low-entropy-secret-123';
  const envA = environmentReceipt({RUSTFLAGS: privateValue, API_TOKEN: privateValue, HTTPS_PROXY: `https://user:${privateValue}@proxy.invalid`});
  const envB = environmentReceipt({RUSTFLAGS: 'different', API_TOKEN: 'different', HTTPS_PROXY: 'different'});
  assert.deepEqual(envA, envB, 'environment receipt must not depend on secret values, even under build-variable names');
  assert.deepEqual(envA.values, {RUSTFLAGS: {redacted: true}});
  assert.equal(envA.scope, 'selected-variable-presence-only');
  assert(!JSON.stringify(envA).includes(privateValue));
  assert(!JSON.stringify(envA).includes(sha256(Buffer.from(privateValue))), 'no dictionary-attackable secret hashes');
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hashFile(requireFile(repositoryRoot, file))]));
  assert(fs.statSync(path.join(sharedRoot, '.deps'), {throwIfNoEntry: false}), 'shared .deps is required');
  assert(fs.statSync(path.join(sharedRoot, 'node_modules'), {throwIfNoEntry: false}), 'shared node_modules is required');
  ensureNoExistingPath(probeRoot);
  fs.mkdirSync(probeRoot, {recursive: true});

  const probesOnly = process.env.EXTERNAL_LAYOUT_PROBES_ONLY === '1';
  const focused = probesOnly ? undefined : createFixture('focused-standalone');
  let focusedSummary: Record<string, unknown> | null = null;
  if (focused) {
    const focusedRun = runBun(focused.root, ['tests/external-layout.ts'], privateEnvironment(focused.root));
    assert.equal(focusedRun.status, 0, `focused standalone gate failed (signal ${focusedRun.signal})\n${focusedRun.output}`);
    const focusedReport = requireReport(focused.root);
    assertSharedGateCases(focusedReport);
    assert.equal(focusedReport.generatedSbf.runtime.executed, true);
    assert.equal(focusedReport.generatedSbf.runtime.deferred, false);
    assert.equal(focusedReport.generatedSbf.runtime.engine, 'LiteSVM');
    assert.equal(focusedReport.generatedSbf.runtime.tests.length, 8, 'all eight accepted LiteSVM cases must remain covered');
    assert.equal(focusedReport.generatedSbf.runtime.inputElfSha256, focusedReport.generatedSbf.runtime.outputElfSha256);
    assert(fs.statSync(focusedReport.generatedSbf.runtime.testExecutable.path, {throwIfNoEntry: false})?.isFile());
    focusedSummary = {
      fixture: focused.root,
      report: path.join(focused.root, 'build/external-layout-report.json'),
      reportSha256: hashFile(path.join(focused.root, 'build/external-layout-report.json')),
      outputSha256: sha256(Buffer.from(focusedRun.output)),
    };
  }

  const imported = createFixture('imported-compile-only');
  const poisonBin = path.join(imported.root, 'build/receipt-cargo-poison');
  fs.mkdirSync(poisonBin, {recursive: true});
  const marker = path.join(poisonBin, 'cargo-was-run');
  const cargoPoison = path.join(poisonBin, 'cargo');
  fs.writeFileSync(cargoPoison, `#!/bin/sh\n: > '${marker}'\nexit 91\n`);
  fs.chmodSync(cargoPoison, 0o755);
  const importedEnv = {
    ...privateEnvironment(imported.root),
    CARGO: cargoPoison,
    PATH: `${poisonBin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  const importedRun = runBun(imported.root, ['-e', "import {testExternalLayout} from './tests/external-layout.ts'; testExternalLayout();"], importedEnv);
  assert.equal(importedRun.status, 0, `imported compile-only gate failed (signal ${importedRun.signal})\n${importedRun.output}`);
  assert.equal(fs.existsSync(marker), false, 'an imported gate must not invoke Cargo');
  const importedReport = requireReport(imported.root);
  assertSharedGateCases(importedReport);
  assert.equal(importedReport.execution.runtime.executed, false);
  assert.equal(importedReport.execution.runtime.deferred, true);
  assert.equal(importedReport.generatedSbf.runtime.executed, false);
  assert.equal(importedReport.generatedSbf.runtime.deferred, true);
  assert.equal(Object.hasOwn(importedReport.generatedSbf.runtime, 'passed'), false, 'deferred runtime is not a LiteSVM pass');
  assert.equal(fs.existsSync(path.join(imported.root, 'build/external-layout-cargo.log')), false);

  const ccFailure = createFixture('prior-report-then-cc-failure');
  const ccReportPath = path.join(ccFailure.root, 'build/external-layout-report.json');
  fs.mkdirSync(path.dirname(ccReportPath), {recursive: true});
  const previousCcBytes = Buffer.from('{"receiptProbe":"opaque prior evidence bytes, not a gate result"}\n');
  assert.doesNotMatch(previousCcBytes.toString('utf8'), /"passed"\s*:\s*true/);
  fs.writeFileSync(ccReportPath, previousCcBytes, {flag: 'wx'});
  const ccEnv = {...privateEnvironment(ccFailure.root), CC: '/nonexistent/external-layout-clang'};
  const ccRun = runBun(ccFailure.root, ['tests/external-layout.ts'], ccEnv);
  assert.notEqual(ccRun.status, 0, `deliberate missing-CC gate call unexpectedly succeeded\n${ccRun.output}`);
  assert.match(ccRun.output, /required executable not found or not executable: \/nonexistent\/external-layout-clang/, 'missing compiler must be the refusal reason');
  assert.equal(fs.existsSync(ccReportPath), false, 'failed gate must not leave a canonical report');
  const ccDigest = sha256(previousCcBytes);
  const ccArchive = path.join(ccFailure.root, 'build/external-layout-reports', `${ccDigest}.json`);
  assert.deepEqual(fs.readFileSync(ccArchive), previousCcBytes, 'successfully archived previous bytes must be preserved exactly');
  assert.equal(fs.readdirSync(path.dirname(ccReportPath)).some(name => name.endsWith('.quarantine')), false,
    'quarantine is removed only after the content-addressed archive succeeds');

  const corruptArchive = createFixture('corrupt-archive-retains-quarantine');
  const corruptReportPath = path.join(corruptArchive.root, 'build/external-layout-report.json');
  fs.mkdirSync(path.dirname(corruptReportPath), {recursive: true});
  const previousCorruptBytes = Buffer.from('{"receiptProbe":"previous bytes retained after archive conflict"}\n');
  assert.doesNotMatch(previousCorruptBytes.toString('utf8'), /"passed"\s*:\s*true/);
  fs.writeFileSync(corruptReportPath, previousCorruptBytes, {flag: 'wx'});
  const corruptDigest = sha256(previousCorruptBytes);
  const corruptArchivePath = path.join(corruptArchive.root, 'build/external-layout-reports', `${corruptDigest}.json`);
  fs.mkdirSync(path.dirname(corruptArchivePath), {recursive: true});
  const corruptArchiveBytes = Buffer.from('{"receiptProbe":"deliberately corrupt content-addressed archive"}\n');
  assert.notDeepEqual(corruptArchiveBytes, previousCorruptBytes);
  fs.writeFileSync(corruptArchivePath, corruptArchiveBytes, {flag: 'wx'});
  const corruptRun = runBun(corruptArchive.root, ['tests/external-layout.ts'], privateEnvironment(corruptArchive.root));
  assert.notEqual(corruptRun.status, 0, `corrupt archive gate call unexpectedly succeeded\n${corruptRun.output}`);
  assert.match(corruptRun.output, /failed to archive previous/, 'archive conflict must be the refusal reason');
  assert.equal(fs.existsSync(corruptReportPath), false, 'archive failure must not leave a canonical report');
  assert.deepEqual(fs.readFileSync(corruptArchivePath), corruptArchiveBytes, 'corrupt archive fixture must remain unchanged');
  const quarantineNames = fs.readdirSync(path.dirname(corruptReportPath)).filter(name => name.startsWith('external-layout-report.json.') && name.endsWith('.quarantine'));
  assert.equal(quarantineNames.length, 1, 'archive failure must leave one same-directory quarantine');
  const quarantinePath = path.join(path.dirname(corruptReportPath), quarantineNames[0]!);
  assert.deepEqual(fs.readFileSync(quarantinePath), previousCorruptBytes, 'quarantine must retain original report bytes');

  const sourceHashesAfter = Object.fromEntries(sourceFiles.map(file => [file, hashFile(requireFile(repositoryRoot, file))]));
  assert.deepEqual(sourceHashesAfter, sourceHashes, 'receipt probe inputs changed during the run');
  for (const fixture of [focused, imported, ccFailure, corruptArchive]) {
    if(fixture)assert.deepEqual(fixture.overlayHashes, sourceHashes, 'probe did not copy the selected source closure');
  }
  const summary = {
    format: 'bend.external-layout.receipt-probes/v1',
    environmentPrivacy: {selectedPresenceOnly: true, valuesAndSecretHashesAbsent: true},
    passed: true,
    source: {root: repositoryRoot, before: sourceHashes, after: sourceHashesAfter, unchanged: true},
    overlay: focused?.overlayHashes ?? imported.overlayHashes,
    focusedStandalone: focusedSummary,
    importedCompileOnly: {
      fixture: imported.root,
      report: path.join(imported.root, 'build/external-layout-report.json'),
      reportSha256: hashFile(path.join(imported.root, 'build/external-layout-report.json')),
      cargoMarkerAbsent: true,
      outputSha256: sha256(Buffer.from(importedRun.output)),
    },
    previousEvidenceAndFailure: {
      fixture: ccFailure.root,
      exitStatus: ccRun.status,
      canonicalAbsent: true,
      preservedArchive: ccArchive,
      preservedBytesSha256: ccDigest,
    },
    corruptArchiveFailure: {
      fixture: corruptArchive.root,
      exitStatus: corruptRun.status,
      canonicalAbsent: true,
      quarantine: quarantinePath,
      preservedBytesSha256: corruptDigest,
      corruptArchiveSha256: sha256(corruptArchiveBytes),
    },
  };
  const summaryPath = path.join(probeRoot, 'receipt-probes.json');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {flag: 'wx'});
  console.log(`External layout receipt probes passed: ${probesOnly ? 'focused standalone skipped, ' : 'standalone LiteSVM, '}imported compile-only, prior evidence failure, corrupt archive failure; report ${summaryPath}`);
}

if (import.meta.main) testExternalLayoutReceipt();
