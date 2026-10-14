import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON ?? 'python3';
const checker = resolve(repoRoot, 'verification/collection_runtime.py');
const driver = resolve(repoRoot, 'verification/check-collection-runtime.ts');
const receipt = resolve(process.env.COLLECTION_RUNTIME_RECEIPT_PATH ?? 'build/collection-runtime-refinement.json');
const receiptHashes = [
  'runtime/bend_collection_runtime.h',
  'runtime/solana_min.h',
  'verification/adapter_contract_c.py',
  'verification/collection_contracts.py',
  'verification/collection_runtime.py',
  'verification/check-collection-runtime.ts',
  'tests/collection-runtime.c',
];

function childTimeoutMs() {
  const value = Number(process.env.COLLECTION_RUNTIME_CHILD_TIMEOUT_MS ?? 180_000);
  assert.ok(Number.isSafeInteger(value) && value > 0, 'child timeout must be a positive integer');
  return value;
}

function childMaxBufferBytes() {
  const value = Number(process.env.COLLECTION_RUNTIME_CHILD_MAX_BUFFER_BYTES ?? 16 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(value) && value > 0, 'child maxBuffer must be a positive integer');
  return value;
}

function uniqueReceiptPath(label: string) {
  return `${receipt}.${label}.${Date.now()}.${process.pid}.${randomUUID()}.json`;
}

function clearReceipt() {
  fs.rmSync(receipt, {force:true});
}

function quarantineReceipt(label = 'unaccepted') {
  if (!fs.existsSync(receipt)) return null;
  const safe = uniqueReceiptPath(label);
  fs.renameSync(receipt, safe);
  assert.equal(fs.existsSync(receipt), false, 'canonical receipt path remained after quarantine');
  return safe;
}

function archiveableReceipt(bytes: Buffer) {
  let report: any;
  try {
    report = JSON.parse(bytes.toString('utf8'));
  } catch {
    return false;
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  if (report.schema !== 2 || report.passed !== true || report.status !== 'PASS' ||
      report.source_hash_comparison !== 'MATCH') return false;
  if (report.contractInterface?.format !== 'bend.collection-helper-contracts/v1' ||
      !/^[0-9a-f]{64}$/.test(report.contractInterfaceHash ?? '')) return false;
  const start = report.source_hashes_at_start;
  if (!start || typeof start !== 'object' || Array.isArray(start)) return false;
  if (Object.keys(start).sort().join('\n') !== [...receiptHashes].sort().join('\n')) return false;
  if (Object.values(start).some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) return false;
  if (JSON.stringify(report.source_hashes_at_end) !== JSON.stringify(start) ||
      JSON.stringify(report.source_hashes_at_publication) !== JSON.stringify(start)) return false;
  if (!report.proofs || typeof report.proofs !== 'object' ||
      Object.keys(report.proofs).sort().join(',') !== 'plan,select') return false;
  if (!Array.isArray(report.source_body_mutations)) return false;
  return true;
}

function archiveReceipt() {
  if (!fs.existsSync(receipt)) return null;
  const quarantined = quarantineReceipt('previous');
  assert.ok(quarantined);
  const bytes = fs.readFileSync(quarantined);
  if (!archiveableReceipt(bytes)) return quarantined;

  const directory = resolve(repoRoot, 'build/refinement-reports');
  try {
    fs.mkdirSync(directory, {recursive:true});
    const digest = createHash('sha256').update(bytes).digest('hex');
    const archived = resolve(directory, digest + '.json');
    if (fs.existsSync(archived)) {
      assert.deepEqual(fs.readFileSync(archived), bytes, 'corrupt receipt archive');
    } else {
      try {
        fs.writeFileSync(archived, bytes, {flag:'wx'});
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        assert.deepEqual(fs.readFileSync(archived), bytes, 'corrupt receipt archive');
      }
    }
    assert.deepEqual(fs.readFileSync(archived), bytes, 'receipt archive verification failed');
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    fs.rmSync(quarantined);
    return archived;
  } catch (error) {
    throw new Error(`could not archive prior receipt; conventional success path is clear and evidence is preserved at ${quarantined}: ${String(error)}`);
  }
}

function childFailureDetails(result: ReturnType<typeof spawnSync>) {
  if (result.error) return `spawn failed (${(result.error as NodeJS.ErrnoException).code ?? 'unknown'}): ${result.error.message}`;
  if (result.signal) return `child terminated by signal ${result.signal}`;
  if (result.status !== 0) return `child exited ${result.status}`;
  return null;
}

function invoke(args: string[]) {
  // The parent has already archived the last accepted receipt. A new child
  // always starts without a conventional success path, including probes.
  clearReceipt();
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(python, ['-B', checker, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: childTimeoutMs(),
      maxBuffer: childMaxBufferBytes(),
    });
  } catch (error) {
    const evidence = quarantineReceipt('unaccepted');
    throw new Error(`Python checker spawn threw: ${String(error)}${evidence ? `; unaccepted receipt preserved at ${evidence}` : ''}`);
  }
  const failure = childFailureDetails(result);
  if (failure) {
    const diagnostic = `${result.stderr || ''}${result.stdout || ''}`.trim();
    const evidence = quarantineReceipt('unaccepted');
    assert.equal(fs.existsSync(receipt), false, 'failed child left a canonical receipt');
    throw new Error(`Python checker ${failure}; ${diagnostic}${evidence ? `; unaccepted receipt preserved at ${evidence}` : ''}`);
  }
  return result;
}

function parentFailureProbe(mode: string) {
  const pythonArgs = mode === 'unknown' ? ['--probe-unknown']
    : mode === 'published-enobufs' ? ['--ts-checker', driver]
      : ['--probe-child-failure'];
  let failure: Error | null = null;
  try {
    invoke(['--repo-root', repoRoot, ...pythonArgs, '--skip-receipt-archive']);
  } catch (error) {
    failure = error as Error;
  }
  assert.ok(failure, `parent ${mode} probe unexpectedly accepted its failed Python child`);
  if (mode === 'nonzero') {
    assert.match(failure.message, /child exited 29/);
    assert.match(failure.message, /intentional child failure probe/);
  } else if (mode === 'unknown') {
    assert.match(failure.message, /child exited 1/);
    assert.match(failure.message, /UNKNOWN is not a proof/);
  } else if (mode === 'spawn') {
    assert.match(failure.message, /spawn failed/);
  } else if (mode === 'signal') {
    assert.match(failure.message, /terminated by signal/);
  } else if (mode === 'timeout') {
    assert.match(failure.message, /ETIMEDOUT|timed out/);
  } else if (mode === 'enobufs') {
    assert.match(failure.message, /ENOBUFS/);
  } else if (mode === 'published-nonzero') {
    assert.match(failure.message, /child exited 29/);
    assert.match(failure.message, /unaccepted receipt preserved at/);
  } else if (mode === 'published-enobufs') {
    assert.match(failure.message, /ENOBUFS/);
    assert.match(failure.message, /unaccepted receipt preserved at/);
  } else {
    throw new Error(`unknown parent failure probe mode ${mode}`);
  }
  assert.equal(fs.existsSync(receipt), false, `parent left a receipt after ${mode} child failure`);
}

function verifyReceipt(stdout: string) {
  assert.ok(fs.existsSync(receipt), 'successful checker did not publish a receipt');
  const bytes = fs.readFileSync(receipt);
  assert.ok(archiveableReceipt(bytes), 'published receipt is incomplete or not self-consistent');
  const report = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(report.source_hashes_at_end, report.source_hashes_at_start,
    'source hashes changed during proof work');
  assert.deepEqual(report.source_hashes_at_publication, report.source_hashes_at_start,
    'source hashes changed between capture and publication');
  assert.equal(report.fail_closed_checks?.child_nonzero,
    'checked by TypeScript parent failure probes', 'receipt must record the probes this parent completed');
  process.stdout.write(stdout);
}

function runParentProbeChild(mode: string) {
  fs.mkdirSync(resolve(repoRoot, 'build'), {recursive:true});
  fs.writeFileSync(receipt, JSON.stringify({passed:true, stale:true}) + '\n');
  const result = spawnSync(process.execPath, [driver], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {...process.env, COLLECTION_RUNTIME_PARENT_PROBE:mode},
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const failure = childFailureDetails(result);
  if (failure) {
    clearReceipt();
    throw new Error(`TypeScript parent ${mode} probe process ${failure}: ${result.stderr || result.stdout}`);
  }
  assert.equal(fs.existsSync(receipt), false, `parent ${mode} probe child left a stale receipt`);
}

function main() {
  const probe = process.env.COLLECTION_RUNTIME_PARENT_PROBE;
  if (probe) {
    // Probe children must never archive their planted success-looking bytes.
    clearReceipt();
    parentFailureProbe(probe);
    return;
  }

  archiveReceipt();

  // Re-run the actual TypeScript parent for the ordinary nonzero and UNKNOWN
  // cases. Each child starts with a planted fake receipt that must not reach
  // the shared refinement-reports archive.
  for (const mode of ['nonzero', 'unknown']) runParentProbeChild(mode);
  process.stdout.write('FAIL-CLOSED: parent rejected nonzero and UNKNOWN children; no stale receipt remained\n');

  const result = invoke([
    '--repo-root', repoRoot,
    '--ts-checker', driver,
    '--skip-receipt-archive',
    '--parent-probes-complete',
  ]);
  try {
    verifyReceipt(result.stdout);
  } catch (error) {
    const evidence = quarantineReceipt('unaccepted');
    throw new Error(`${String(error)}${evidence ? `; unaccepted receipt preserved at ${evidence}` : ''}`);
  }
}

main();
