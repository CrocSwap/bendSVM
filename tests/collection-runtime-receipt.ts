import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON ?? 'python3';
let validReceipt: Buffer;
const staleReceipt = Buffer.from(JSON.stringify({passed:true, stale:true}) + '\n');
const sourceFiles = [
  'runtime/bend_collection_runtime.h',
  'runtime/solana_min.h',
  'verification/adapter_contract_c.py',
  'verification/collection_contracts.py',
  'verification/collection_runtime.py',
  'verification/check-collection-runtime.ts',
  'tests/collection-runtime.c',
];

function makeFixture(label: string) {
  const root = fs.mkdtempSync(join(tmpdir(), `collection-runtime-${label}-`));
  for (const relative of sourceFiles) {
    const destination = join(root, relative);
    fs.mkdirSync(dirname(destination), {recursive:true});
    fs.copyFileSync(join(repoRoot, relative), destination);
  }
  fs.mkdirSync(join(root, 'build'), {recursive:true});
  return root;
}

function putPriorReceipt(root: string) {
  fs.writeFileSync(join(root, 'build/collection-runtime-refinement.json'), validReceipt);
}

function quarantineFiles(root: string) {
  return fs.readdirSync(join(root, 'build'))
    .filter((name) => name.startsWith('collection-runtime-refinement.json.'))
    .map((name) => join(root, 'build', name));
}

function runBunDriver(root: string, env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [join(root, 'verification/check-collection-runtime.ts')], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, ...env},
    timeout: Number(env.COLLECTION_RUNTIME_TEST_DRIVER_TIMEOUT_MS ?? 30_000),
    maxBuffer: 16 * 1024 * 1024,
  });
}

function pythonReceiptArchiveFailure() {
  const root = makeFixture('python-archive-fail');
  putPriorReceipt(root);
  fs.writeFileSync(join(root, 'build/refinement-reports'), 'block archive directory');
  const result = spawnSync(python, [
    '-B', join(root, 'verification/collection_runtime.py'),
    '--repo-root', root,
    '--ts-checker', join(root, 'verification/check-collection-runtime.ts'),
  ], {cwd:root, encoding:'utf8', timeout:30_000, maxBuffer:4 * 1024 * 1024});
  const diagnostic = `${result.stdout || ''}${result.stderr || ''}`;
  assert.notEqual(result.status, 0, 'direct Python path accepted a failed archive');
  assert.match(diagnostic, /could not archive prior receipt/);
  assert.match(diagnostic, /evidence is preserved at/);
  assert.equal(fs.existsSync(join(root, 'build/collection-runtime-refinement.json')), false,
    'direct Python path left a stale canonical receipt');
  const safe = quarantineFiles(root);
  assert.equal(safe.length, 1, 'direct Python path must report one preserved prior receipt');
  assert.deepEqual(fs.readFileSync(safe[0]), validReceipt, 'direct Python quarantine changed prior evidence');
  fs.rmSync(root, {recursive:true, force:true});
}

function typescriptReceiptArchiveFailure() {
  const root = makeFixture('typescript-archive-fail');
  putPriorReceipt(root);
  fs.writeFileSync(join(root, 'build/refinement-reports'), 'block archive directory');
  const result = runBunDriver(root);
  const diagnostic = `${result.stdout || ''}${result.stderr || ''}`;
  assert.notEqual(result.status, 0, 'TypeScript parent accepted a failed archive');
  assert.match(diagnostic, /could not archive prior receipt/);
  assert.match(diagnostic, /evidence is preserved at/);
  assert.equal(fs.existsSync(join(root, 'build/collection-runtime-refinement.json')), false,
    'TypeScript parent left a stale canonical receipt');
  const safe = quarantineFiles(root);
  assert.equal(safe.length, 1, 'TypeScript parent must report one preserved prior receipt');
  assert.deepEqual(fs.readFileSync(safe[0]), validReceipt, 'TypeScript quarantine changed prior evidence');
  fs.rmSync(root, {recursive:true, force:true});
}

function writeChildWrapper(root: string) {
  const path = join(root, 'build/fake-python.py');
  const script = `#!/usr/bin/env python3
import base64, os, pathlib, signal, subprocess, sys, time
mode = os.environ.get('COLLECTION_RUNTIME_TEST_CHILD_MODE', 'nonzero')
report = os.environ.get('COLLECTION_RUNTIME_TEST_RECEIPT_B64')
if report and mode != 'published-enobufs':
    pathlib.Path(os.environ['COLLECTION_RUNTIME_TEST_RECEIPT_PATH']).write_bytes(base64.b64decode(report))
if mode == 'published-enobufs':
    child = subprocess.run([os.environ['COLLECTION_RUNTIME_TEST_REAL_PYTHON'], *sys.argv[1:]],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    sys.stdout.buffer.write(child.stdout)
    sys.stderr.buffer.write(child.stderr)
    if child.returncode != 0:
        raise SystemExit(child.returncode)
    sys.stdout.buffer.write(b'x' * (4 * 1024 * 1024))
    sys.stdout.flush()
    time.sleep(1)
if mode == 'unknown':
    sys.stderr.write('UNKNOWN is not a proof (intentional test child)\\n')
    raise SystemExit(1)
if mode in ('nonzero', 'published-nonzero'):
    sys.stderr.write('intentional child failure probe\\n')
    raise SystemExit(29)
if mode == 'signal':
    os.kill(os.getpid(), signal.SIGTERM)
if mode == 'timeout':
    time.sleep(3)
if mode == 'enobufs':
    sys.stdout.buffer.write(b'x' * (4 * 1024 * 1024))
    sys.stdout.flush()
    time.sleep(1)
raise SystemExit(29)
`;
  fs.writeFileSync(path, script, {mode:0o755});
  return path;
}

function assertNoArchiveOf(root: string, bytes: Buffer) {
  const directory = join(root, 'build/refinement-reports');
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return;
  for (const name of fs.readdirSync(directory)) {
    const path = join(directory, name);
    if (fs.statSync(path).isFile()) {
      assert.notDeepEqual(fs.readFileSync(path), bytes, `unaccepted receipt bytes entered archive ${path}`);
    }
  }
}

function typescriptChildFailurePaths() {
  const root = makeFixture('typescript-child-failures');
  const wrapper = writeChildWrapper(root);
  const receiptPath = join(root, 'build/collection-runtime-refinement.json');
  const cases = [
    {mode:'published-nonzero', probe:'published-nonzero'},
    {mode:'published-enobufs', probe:'published-enobufs', maxBuffer:'2048', realPython:python},
    {mode:'signal', probe:'signal'},
    {mode:'timeout', probe:'timeout', timeout:'100'},
    {mode:'enobufs', probe:'enobufs', maxBuffer:'2048'},
    {mode:'spawn', probe:'spawn', python:join(root, 'build/missing-python')},
  ];
  try {
  for (const test of cases) {
    const result = runBunDriver(root, {
      PYTHON:test.python ?? wrapper,
      COLLECTION_RUNTIME_PARENT_PROBE:test.probe,
      COLLECTION_RUNTIME_TEST_CHILD_MODE:test.mode,
      COLLECTION_RUNTIME_TEST_RECEIPT_PATH:receiptPath,
      COLLECTION_RUNTIME_TEST_RECEIPT_B64:test.mode === 'spawn' ? undefined : validReceipt.toString('base64'),
      COLLECTION_RUNTIME_TEST_REAL_PYTHON:test.realPython,
      COLLECTION_RUNTIME_TEST_DRIVER_TIMEOUT_MS:test.realPython ? '180000' : undefined,
      COLLECTION_RUNTIME_CHILD_TIMEOUT_MS:test.timeout,
      COLLECTION_RUNTIME_CHILD_MAX_BUFFER_BYTES:test.maxBuffer,
    });
    assert.equal(result.status, 0,
      `${test.mode} probe should be rejected by the TypeScript parent: ${result.stderr || result.stdout}`);
    assert.equal(fs.existsSync(receiptPath), false, `${test.mode} left a canonical receipt`);
    if (test.mode === 'published-enobufs') {
      const safe = quarantineFiles(root).filter((path) => path.includes('.unaccepted.'));
      const freshPass = safe.map((path) => ({path, report:JSON.parse(fs.readFileSync(path, 'utf8'))}))
        .find(({report}) => report.passed === true && report.status === 'PASS' &&
          JSON.stringify(report.source_hashes_at_start) === JSON.stringify(report.source_hashes_at_publication) &&
          report.fail_closed_checks?.child_nonzero === 'not checked by this Python invocation');
      assert.ok(freshPass, 'real direct Python PASS was not preserved as unaccepted evidence after ENOBUFS');
      assert.equal(freshPass.report.fail_closed_checks?.child_nonzero,
        'not checked by this Python invocation', 'direct Python receipt must not claim the TypeScript parent probe ran');
      assertNoArchiveOf(root, fs.readFileSync(freshPass.path));
    } else if (test.mode !== 'spawn') {
      const safe = quarantineFiles(root).filter((path) => path.includes('.unaccepted.'));
      assert.ok(safe.some((path) => fs.readFileSync(path).equals(validReceipt)),
        `${test.mode} did not preserve the child's fresh PASS bytes as unaccepted evidence`);
    }
    assertNoArchiveOf(root, validReceipt);
  }
  } finally {
    fs.rmSync(root, {recursive:true, force:true});
  }
}

function staleProbeDoesNotArchive() {
  const root = makeFixture('stale-probe');
  const wrapper = join(root, 'build/fake-probe-python.py');
  fs.writeFileSync(wrapper, `#!/usr/bin/env python3
import sys
if '--probe-unknown' in sys.argv:
    sys.stderr.write('UNKNOWN is not a proof\\n')
    raise SystemExit(1)
if '--probe-child-failure' in sys.argv:
    sys.stderr.write('intentional child failure probe\\n')
    raise SystemExit(29)
raise SystemExit(29)
`, {mode:0o755});
  const result = runBunDriver(root, {PYTHON:wrapper});
  assert.notEqual(result.status, 0, 'fake proof child unexpectedly passed');
  assert.equal(fs.existsSync(join(root, 'build/collection-runtime-refinement.json')), false);
  assertNoArchiveOf(root, staleReceipt);
  fs.rmSync(root, {recursive:true, force:true});
}

function pythonArchiveVerificationAndClaim() {
  const root = makeFixture('python-archive-success');
  putPriorReceipt(root);
  const moduleDir = join(root, 'verification');
  const code = [
    'import pathlib, sys',
    'sys.path.insert(0, sys.argv[1])',
    'import collection_runtime as cr',
    'root = pathlib.Path(sys.argv[2])',
    'print(cr.child_nonzero_claim(False))',
    'print(cr.archive_previous_receipt(root))',
  ].join('; ');
  const result = spawnSync(python, ['-B', '-c', code, moduleDir, root], {
    cwd:root, encoding:'utf8', timeout:30_000, maxBuffer:4 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /not checked by this Python invocation/);
  assert.equal(fs.existsSync(join(root, 'build/collection-runtime-refinement.json')), false);
  const archiveDir = join(root, 'build/refinement-reports');
  const digest = receiptHash(validReceipt);
  const archived = join(archiveDir, `${digest}.json`);
  assert.deepEqual(fs.readFileSync(archived), validReceipt, 'Python archive did not preserve exact prior bytes');
  assert.deepEqual(quarantineFiles(root), [], 'Python removed quarantine only after verified archival');
  fs.rmSync(root, {recursive:true, force:true});
}

function receiptHash(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Produce real starting evidence in a private fixture, so this test works on a
// fresh checkout and never depends on or replaces the caller's last receipt.
const seedRoot = makeFixture('seed');
try {
  const seed = runBunDriver(seedRoot, {COLLECTION_RUNTIME_TEST_DRIVER_TIMEOUT_MS:'180000'});
  assert.ifError(seed.error);
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);
  validReceipt = fs.readFileSync(join(seedRoot, 'build/collection-runtime-refinement.json'));
  assert.equal(JSON.parse(validReceipt.toString('utf8')).passed, true);
  assert.equal(JSON.parse(validReceipt.toString('utf8')).contractInterface?.format,
    'bend.collection-helper-contracts/v1');
} finally {
  fs.rmSync(seedRoot, {recursive:true, force:true});
}
pythonReceiptArchiveFailure();
typescriptReceiptArchiveFailure();
typescriptChildFailurePaths();
staleProbeDoesNotArchive();
pythonArchiveVerificationAndClaim();
process.stdout.write('PASS receipt hardening: Python/TypeScript archive failures, child failures, stale probes and verified archival\n');
