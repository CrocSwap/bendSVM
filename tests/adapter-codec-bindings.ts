import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Backend, checkedProgram} from '../compiler/backend.ts';
import {writeArtifacts} from '../compiler/artifacts.ts';

// Focused dependency-audit coverage. Fixtures are checked Bend programs and
// every C/header/schema/interface file is emitted by the normal artifact
// writer, then archived and read back by the Python audit test.
const root = process.cwd();
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const runDir = path.join('build', `adapter-codec-bindings-${runId}`);
const sourceDir = path.join(runDir, 'sources');
const archiveDir = path.join(runDir, 'archive');
const manifestPath = path.join(runDir, 'manifest.json');
const reportPath = path.join(runDir, 'result.json');
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fail(message: string): never { throw new Error(message); }

function pythonCall(args: string[], label: string) {
  const python = process.env.PYTHON ?? 'python3';
  const result = spawnSync(python, args, {cwd: root, encoding: 'utf8', timeout: 120_000});
  if (result.error) fail(`${label}: could not start ${python}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label}: ${python} exited ${String(result.status)}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

// Fail early if the requested Python runner is missing or cannot start.
pythonCall(['--version'], 'Python availability check');

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__pycache__' ? [] : sourceFiles(file);
    return entry.isFile() && /\.(?:ts|py|bend|h|c|ld)$/.test(entry.name) ? [file] : [];
  });
}

const sourceHashes: Record<string, string> = {};
function recordSource(file: string) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) fail(`Missing source input: ${resolved}`);
  sourceHashes[resolved] = hashFile(resolved);
}

// Record the source basis used by checked loading, generation and auditing.
for (const directory of ['compiler', 'runtime', 'sdk', 'verification']) {
  for (const file of sourceFiles(directory)) recordSource(file);
}
for (const file of ['scripts/build.ts', import.meta.path, 'tests/adapter-codec-bindings.py']) recordSource(file);

const u32BoolFields = (width: 255 | 256) => {
  const boolCount = width === 255 ? 2 : 3;
  const u32Count = 63;
  return [
    ...Array.from({length: u32Count}, (_, i) => ({name: `u${i}`, type: 'U32'})),
    ...Array.from({length: boolCount}, (_, i) => ({name: `b${i}`, type: 'Bool'})),
  ];
};

function dataType(name: string, fields: {name: string; type: string}[]) {
  return `type ${name} is Data:\n  ${name}{${fields.map(f => `${f.name}: ${f.type}`).join(', ')}}\n`;
}

function pureProgram(types: string[], stateType: string, instructionType: string) {
  return [
    'import ../../../sdk/context.bend as Sol',
    ...types,
    `type State is Data:\n  State{${stateType}}`,
    `type Instruction is Data:\n  Instruction{${instructionType}}`,
    'type Outcome is Data:',
    '  Accepted{state: State}',
    '  Rejected{code: U32}',
    'def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:',
    '  Accepted{state}',
    '',
  ].join('\n');
}

const fixtures = [
  {
    name: 'abi1-small', abi: 1 as const, stateFields: [{name: 'value', type: 'U32'}],
    instructionFields: [{name: 'marker', type: 'Bool'}], expected: {n: 5, ix: 2},
  },
  {
    name: 'abi1-edge255', abi: 1 as const, stateFields: u32BoolFields(255),
    instructionFields: u32BoolFields(255), expected: {n: 255, ix: 255},
  },
  {
    name: 'abi1-edge256', abi: 1 as const, stateFields: u32BoolFields(256),
    instructionFields: u32BoolFields(256), expected: {n: 256, ix: 256},
  },
  {
    name: 'abi2-instruction255', abi: 2 as const,
    stateFields: [{name: 'left', type: 'Field255'}, {name: 'right', type: 'Field256'}],
    instructionFields: u32BoolFields(255), expected: {n: 512, ix: 255, fieldSizes: [255, 256]},
    extraTypes: [dataType('Field255', u32BoolFields(255)), dataType('Field256', u32BoolFields(256))],
  },
  {
    name: 'abi2-instruction256', abi: 2 as const,
    stateFields: [{name: 'left', type: 'Field255'}, {name: 'right', type: 'Field256'}],
    instructionFields: u32BoolFields(256), expected: {n: 512, ix: 256, fieldSizes: [255, 256]},
    extraTypes: [dataType('Field255', u32BoolFields(255)), dataType('Field256', u32BoolFields(256))],
  },
];

function includeClosure(stem: string, name: string): {files: Record<string, string>; paths: Record<string, string>} {
  const files: Record<string, string> = {};
  const paths: Record<string, string> = {};
  const pending = [{file: `${name}.c`, found: `${stem}.c`}];
  while (pending.length) {
    const {file, found} = pending.pop()!;
    if (file in files) {
      assert.equal(path.resolve(paths[file]), path.resolve(found), `${name}: ambiguous include binding ${file}`);
      continue;
    }
    files[file] = fs.readFileSync(found, 'utf8');
    paths[file] = found;
    for (const match of files[file].matchAll(/^[ \t]*#[ \t]*include[ \t]*(["<])([^">\n]+)[">]/gm)) {
      const search = match[1] === '"' ? [path.dirname(found), 'build', 'runtime'] : ['build', 'runtime'];
      const resolved = search.map(directory => path.join(directory, match[2])).find(filePath => fs.existsSync(filePath));
      assert(resolved, `${name}: unresolved include ${match[2]}`);
      pending.push({file: match[2], found: resolved});
    }
  }
  return {files, paths};
}

fs.mkdirSync(sourceDir, {recursive: true});
fs.mkdirSync(archiveDir, {recursive: true});
const records: any[] = [];
for (const fixture of fixtures) {
  const stateFields = fixture.stateFields;
  const instructionFields = fixture.instructionFields;
  const extraTypes = 'extraTypes' in fixture ? fixture.extraTypes : [];
  const source = pureProgram(
    extraTypes,
    stateFields.map(field => `${field.name}: ${field.type}`).join(', '),
    instructionFields.map(field => `${field.name}: ${field.type}`).join(', '),
  );
  const sourcePath = path.join(sourceDir, `${fixture.name}.bend`);
  fs.writeFileSync(sourcePath, source);
  const checked = await checkedProgram(sourcePath);
  for (const file of checked.files) recordSource(file);
  const emitted = new Backend(checked.book).emit(['process']);
  const stem = path.join(runDir, fixture.name);
  if (fixture.abi === 1) writeArtifacts(stem, emitted, 'process');
  else writeArtifacts(stem, emitted, 'process', {stateAccounts: ['left', 'right']});
  const filesOnDisk = includeClosure(stem, fixture.name);
  const schemaPath = `${stem}.schema.json`;
  const interfacePath = `${stem}.interface.json`;
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const iface = JSON.parse(fs.readFileSync(interfacePath, 'utf8'));
  assert.equal(iface.version, fixture.abi, `${fixture.name}: wrong emitted ABI`);

  // Boundary facts are asserted against the fixture layout, independently of
  // the emitter's threshold constant.
  const primitiveWireWidth = (fields: {type: string}[]) => 1 + fields.reduce((n, field) => n + (field.type === 'Bool' ? 1 : 4), 0);
  if (fixture.abi === 1) {
    assert.equal(primitiveWireWidth(fixture.stateFields), fixture.expected.n, `${fixture.name}: state fixture width`);
    assert.equal(primitiveWireWidth(fixture.instructionFields), fixture.expected.ix, `${fixture.name}: instruction fixture width`);
  } else {
    const fieldSizes = (fixture.expected as {fieldSizes: number[]}).fieldSizes;
    assert.equal(1 + fieldSizes.reduce((n, width) => n + width, 0), fixture.expected.n, `${fixture.name}: state fixture width`);
    assert.equal(primitiveWireWidth(fixture.instructionFields), fixture.expected.ix, `${fixture.name}: instruction fixture width`);
  }

  const archive = path.join(archiveDir, fixture.name);
  fs.mkdirSync(archive, {recursive: true});
  const archiveHashes: Record<string, string> = {};
  for (const [file, found] of Object.entries(filesOnDisk.paths)) {
    const destination = path.join(archive, file);
    fs.copyFileSync(found, destination);
    archiveHashes[file] = hashFile(destination);
  }
  for (const file of [schemaPath, interfacePath]) {
    const destination = path.join(archive, path.basename(file));
    fs.copyFileSync(file, destination);
    archiveHashes[path.basename(file)] = hashFile(destination);
  }
  const outputHashes: Record<string, string> = {};
  for (const suffix of ['.c', '.h', '.wire.h', '.dispatch.h', '.schema.json', '.interface.json', '.resources.json']) {
    const file = `${stem}${suffix}`;
    outputHashes[path.basename(file)] = hashFile(file);
  }
  recordSource(sourcePath);
  records.push({
    name: fixture.name, abi: fixture.abi, adapter: `${fixture.name}.c`,
    schema: path.resolve(archive, `${fixture.name}.schema.json`),
    interface: path.resolve(archive, `${fixture.name}.interface.json`),
    archiveDirectory: path.resolve(archive), archiveFiles: Object.keys(filesOnDisk.files).sort(),
    archiveHashes, outputDirectory: path.resolve(runDir), outputHashes,
    expected: fixture.expected,
    sourcePath: path.resolve(sourcePath), sourceSha256: hashFile(sourcePath),
    checkedSourceHashes: Object.fromEntries([...new Set(checked.files)].map(file => [path.resolve(file), hashFile(file)])),
  });
}

const manifest = {
  version: 1,
  scope: 'ABI 1 and ABI 2 emitted-header dependency annotation and unique file-scope binding checks only',
  runId, root: path.resolve(root),
  sourceHashes,
  fixtures: records,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

const pythonOutput = pythonCall(['-B', 'tests/adapter-codec-bindings.py', manifestPath, reportPath], 'Focused Python audit');
if (!fs.existsSync(reportPath)) fail(`Focused Python audit did not write ${reportPath}\n${pythonOutput}`);
const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
assert.equal(report.passed, true, 'focused Python audit did not pass');
assert.equal(report.fixtures.length, fixtures.length, 'focused Python audit fixture count');
assert.equal(report.positives.length, fixtures.length + 2, 'baseline, whitespace and comment positive controls');
assert.equal(report.mutations.length, 27, 'focused negative mutation count');

for (const [file, expectedHash] of Object.entries(sourceHashes)) {
  assert.equal(hashFile(file), expectedHash, `source changed during focused audit: ${file}`);
}
for (const fixture of records) {
  for (const [file, expectedHash] of Object.entries(fixture.archiveHashes)) {
    assert.equal(hashFile(path.join(fixture.archiveDirectory, file)), expectedHash,
      `${fixture.name}: archived dependency changed during focused audit: ${file}`);
  }
}

console.log(`Adapter codec binding audit passed: ${fixtures.length} emitted fixtures, ` +
  `${report.positives.length - fixtures.length} positive controls, ${report.mutations.length} expected rejections.`);
console.log(`Evidence: ${path.resolve(reportPath)} sha256=${hashFile(reportPath)}`);
