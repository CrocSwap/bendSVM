import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {emitSha256QualifiedSbf} from '../compiler/sha256-qualified-emission.ts';
import {Backend, checkedProgram} from '../compiler/backend.ts';
import {checkedModuleNames} from '../compiler/checked-module-names.ts';
import {checkedRuntimeIdentity} from '../compiler/checked-runtime-identity.ts';
import * as Bend from '../.deps/bend/bend2/bend.ts';
import {copyEmitterSandbox, copyReferenceFixture, copyShadowReferenceFixture, replaceExactlyOnce, repositoryRoot} from './sha256-qualified-emission/support.ts';

const hash = (value: string | Uint8Array) => crypto.createHash('sha256').update(value).digest('hex');
const testPath = fs.realpathSync(fileURLToPath(import.meta.url));
const testSourceBefore = hash(fs.readFileSync(testPath));
const testSupportPath = fs.realpathSync(fileURLToPath(new URL('./sha256-qualified-emission/support.ts', import.meta.url)));
const testSupportBefore = hash(fs.readFileSync(testSupportPath));
const outputDirectory = path.join(repositoryRoot, 'build/sha256-qualified-emission');
fs.mkdirSync(outputDirectory, {recursive: true});
const pins = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'compiler/sha256-qualification-pins.json'), 'utf8'));
const negativeReasons: {name: string; expectedReason: string}[] = [];
const restoredPositiveControls: string[] = [];

async function rejects(name: string, run: () => Promise<unknown>, reason: RegExp): Promise<void> {
  await assert.rejects(run, reason, `${name}: refusal must be for the expected semantic reason`);
  negativeReasons.push({name, expectedReason: reason.source});
}

function mutateFixture(name: string, edit: Parameters<typeof copyReferenceFixture>[1]): string {
  const destination = path.join(outputDirectory, name);
  fs.rmSync(destination, {recursive: true, force: true});
  fs.mkdirSync(destination, {recursive: true});
  return copyReferenceFixture(destination, edit);
}

async function expectRestoredPositive(name: string): Promise<void> {
  const restored = await emitSha256QualifiedSbf(originalProgram, ['hash_short']);
  assert.equal(restored.receipt.checkedRuntime.sha256, emission.receipt.checkedRuntime.sha256,
    `${name}: a fresh operation qualifies after the attack hook is restored`);
  assert.equal(restored.receipt.replacement.replacements, 1);
  restoredPositiveControls.push(name);
}

async function rejectDuringBackendEmit(
  name: string,
  mutate: (backend: any) => () => void,
  reason: RegExp,
): Promise<void> {
  const originalEmit = Backend.prototype.emit;
  let restore = () => {};
  (Backend.prototype as any).emit = function(this: any, roots: string[]) {
    const result = originalEmit.call(this, roots);
    restore = mutate(this);
    return result;
  };
  try {
    await rejects(name, () => emitSha256QualifiedSbf(originalProgram, ['hash_short']), reason);
  } finally {
    (Backend.prototype as any).emit = originalEmit;
    restore();
  }
  await expectRestoredPositive(name);
}

function sourceFilesUnder(directory: string): {path: string; sha256: string}[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const item of fs.readdirSync(current, {withFileTypes: true})) {
      const file = path.join(current, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile() && file !== path.join(outputDirectory, 'evidence.json') && /\.(bend|ts|json|c|h)$/.test(item.name)) files.push(file);
    }
  };
  if (fs.existsSync(directory)) visit(directory);
  return files.sort().map(file => ({path: file, sha256: hash(fs.readFileSync(file))}));
}

async function runSandboxRefusal(name: string, edit: (directory: string) => void, reason: RegExp): Promise<void> {
  const destination = path.join(outputDirectory, `sandbox-${name}`);
  fs.rmSync(destination, {recursive: true, force: true});
  const engine = copyEmitterSandbox(destination, Object.keys(pins.supportFiles), edit);
  const module = await import(pathToFileURL(engine).href + `?sha-qualification-${name}`);
  const oldCwd = process.cwd();
  try {
    process.chdir(destination);
    await rejects(name, () => module.emitSha256QualifiedSbf('tests/sha256-reference/PROOF.bend', ['hash_short']), reason);
  } finally {
    process.chdir(oldCwd);
  }
}

const originalProgram = 'tests/sha256-reference/PROOF.bend';
const emission = await emitSha256QualifiedSbf(originalProgram, ['hash_short']);
const ordinaryCheck = await checkedProgram(originalProgram);
const ordinaryBackend = new Backend(ordinaryCheck.book);
const ordinaryEmission = ordinaryBackend.emit(['hash_short']);
assert.deepEqual(ordinaryEmission, emission.originalEmission, 'qualified operation preserves the ordinary complete Backend output');
const functionRecords = ordinaryBackend.emittedFunctions();
assert.deepEqual(functionRecords.map(record => record.name), ordinaryEmission.functions);
assert.equal(new Set(functionRecords.map(record => record.name)).size, functionRecords.length);
for (const record of functionRecords) assert.equal(ordinaryEmission.c.split(record.definition).length, 2,
  `internal metadata identifies one exact definition: ${record.name}`);
const internalRecord = functionRecords.find(record => record.name === emission.receipt.target.emittedName);
assert.ok(internalRecord, 'transitive SDK function has an internal emission record');
assert.equal(internalRecord.args.length, 1);
assert.equal(internalRecord.result, '../../sdk/sha256-reference.HashResult');
assert.ok(!ordinaryEmission.schema.exports.some(export_ => export_.name === internalRecord.name));
const exposedRecords = ordinaryBackend.emittedFunctions();
exposedRecords[0].args.push('forged');
exposedRecords[0].definition = 'forged';
exposedRecords.splice(1);
assert.deepEqual(ordinaryBackend.emittedFunctions().map(record => record.name), ordinaryEmission.functions,
  'internal emission metadata is returned as a defensive copy');
assert.equal(ordinaryEmission.c.split(internalRecord.definition).length, 2);
assert.equal(emission.c.split(internalRecord.definition).length, 1, 'the original SDK body was replaced');
assert.equal(emission.c.split(`${internalRecord.cName}(`).length - 1, 2,
  'the output contains one internal definition and preserves the public wrapper call');
assert.equal(emission.kind, 'sha256-qualified-sbf-emission-v1');
assert.equal(emission.receipt.checkedRuntime.sha256, '8645b9ed82f7d511d033e30422b6bff87de5a364764b9bc241ca88aef9d6860e');
assert.equal(emission.receipt.checkedRuntime.definitions, 160);
assert.equal(emission.receipt.target.canonicalName, '$module:sha256-reference.hash_short');
assert.equal(emission.receipt.target.internal, true);
assert.deepEqual(emission.schema.exports.map(export_ => export_.name), ['hash_short'], 'the original public root schema is unchanged');
assert.ok(!emission.schema.exports.some(export_ => export_.name === emission.receipt.target.emittedName), 'internal SDK is not added as a public export');
assert.equal(hash(emission.originalEmission.c), emission.receipt.originalEmission.cSha256);
assert.equal(hash(JSON.stringify(emission.originalEmission)), pins.ordinaryShaFixtureEmissionSha256,
  'complete ordinary Backend output remains equal to the reviewed pre-metadata emission');
assert.equal(emission.receipt.originalEmission.cSha256, 'c45f4b00206520e732e01fa2abce511470e0776951573a404c398a6bc64a4444');
assert.equal(emission.receipt.originalEmission.temporaryTargetSchemaTypeCount, 11,
  'generator receives only the transitive types of the internal SHA function');
assert.equal(emission.receipt.replacement.resultingCSha256, '16749201d0e0a7954e42a25e1ddabf3fd58708ff44808ca7c19d1ad6fa7123cb');
assert.equal(emission.receipt.replacement.replacements, 1);
assert.deepEqual(emission.schema, ordinaryEmission.schema, 'the public schema is unchanged by the C replacement');
assert.equal(hash(JSON.stringify(emission.schema)), emission.receipt.originalEmission.schemaSha256,
  'one original-schema hash also binds the unchanged public schema');
assert.equal(emission.receipt.originalEmission.taggedSumEvidenceScope, 'originalC only');
assert.deepEqual(emission.receipt.target.args, internalRecord.args);
assert.equal(emission.receipt.target.result, internalRecord.result);
assert.equal(hash(JSON.stringify(emission.originalEmission.taggedSumLowering)), emission.receipt.originalEmission.taggedSumLoweringSha256);
assert.ok(!Object.hasOwn(emission, 'taggedSumLowering'), 'original sum evidence is not attached to substituted C');
assert.equal(emission.receipt.sourceInputs.filter(input => path.basename(input.path) === 'PROOF.bend').length, 1);
assert.equal(emission.receipt.sourceInputs.filter(input => path.basename(input.path) === 'LAWS.bend').length, 1,
  'source receipt includes the checked laws/proofs');
assert.equal(Object.isFrozen(emission), true);
assert.equal(Object.isFrozen(emission.receipt.sourceInputs), true);
assert.equal(Reflect.set(emission, 'c', 'forged'), false, 'qualified output is immutable');
assert.equal(emission.receipt.requiredFinalElfProfile.finalElfAndArtifactAuthorization, 'not performed by this layer');
assert.deepEqual(emission.receipt.requiredFinalElfProfile.requiredImports, ['abort', 'sol_sha256']);
assert.equal(emission.receipt.requiredFinalElfProfile.forbiddenObservationImport, 'sol_log_64_');
assert.equal(emission.receipt.assumptions.process, 'trusted process with no hostile in-process patch authority');
assert.equal(emission.receipt.assumptions.filesystem,
  'stable, non-hostile filesystem from import-time module loading through final output; loader hashes are not read-time byte receipts');
for (const record of functionRecords) if (record.name !== internalRecord.name) {
  assert.equal(emission.c.split(record.definition).length, 2, `qualified C preserves every other emitted definition: ${record.name}`);
}

// The catalog binds one exact Bun binary and platform tuple. Simulate another
// runner tuple to verify deterministic refusal before executable lookup.
const oldPlatform = process.platform, oldArch = process.arch;
try {
  Object.defineProperty(process, 'platform', {value: 'linux', configurable: true});
  Object.defineProperty(process, 'arch', {value: 'x64', configurable: true});
  await rejects('unsupported Bun platform/architecture',
    () => emitSha256QualifiedSbf(originalProgram, ['hash_short']),
    /unsupported Bun platform\/architecture: linux\/x64; this qualification pin supports darwin\/arm64/);
} finally {
  Object.defineProperty(process, 'platform', {value: oldPlatform, configurable: true});
  Object.defineProperty(process, 'arch', {value: oldArch, configurable: true});
}

// Relocation plus an earlier generic instantiation exercises canonical module
// origins and real raw instance renumbering through the public operation.
const relocatedSource = mutateFixture('renumbered-relocation', {relocated: true, prelude: true});
const relocated = await emitSha256QualifiedSbf(relocatedSource, ['hash_short']);
assert.equal(relocated.receipt.checkedRuntime.sha256, emission.receipt.checkedRuntime.sha256);
assert.equal(relocated.receipt.checkedRuntime.definitions, emission.receipt.checkedRuntime.definitions);
assert.notDeepEqual(relocated.receipt.sourceInputs.map(input => input.path), emission.receipt.sourceInputs.map(input => input.path));
assert.ok(relocated.receipt.sourceInputs.some(input => path.basename(input.path) === 'before.bend'), 'extra unrelated source is included in receipt');
const originalNames = checkedModuleNames(ordinaryCheck.book, ordinaryCheck.modules,
  pins.requiredModules.map((required: {label: string; sha256: string}) => {
    const matches = ordinaryCheck.modules.filter(module => hash(fs.readFileSync(module.file)) === required.sha256);
    assert.equal(matches.length, 1, `original source has one ${required.label} module`);
    return {label: required.label, file: matches[0].file};
  }));
const identityBeforePrimitiveProbe = checkedRuntimeIdentity(ordinaryCheck.book, [internalRecord.name], originalNames.canonical);
const primitiveName = Object.keys(identityBeforePrimitiveProbe.definitions).find(name => {
  const declaration = ordinaryCheck.book.tlds[name];
  return name.startsWith('U32.') && declaration?.$ === 'Def' && declaration.b === true;
});
assert.ok(primitiveName, 'the qualified closure contains checked primitive metadata');
const primitiveDeclaration = ordinaryCheck.book.tlds[primitiveName!];
assert.equal(primitiveDeclaration.$, 'Def');
if (primitiveDeclaration.$ !== 'Def') throw new Error('qualified primitive declaration disappeared');
const primitiveFlag = primitiveDeclaration.b;
primitiveDeclaration.b = !primitiveFlag;
try {
  assert.notEqual(checkedRuntimeIdentity(ordinaryCheck.book, [internalRecord.name], originalNames.canonical).sha256,
    identityBeforePrimitiveProbe.sha256, 'primitive status is part of checked runtime identity');
} finally {
  primitiveDeclaration.b = primitiveFlag;
}
assert.equal(checkedRuntimeIdentity(ordinaryCheck.book, [internalRecord.name], originalNames.canonical).sha256,
  identityBeforePrimitiveProbe.sha256, 'restored primitive status is the identity positive control');
const relocatedCheck = await checkedProgram(relocatedSource);
const relocatedNames = checkedModuleNames(relocatedCheck.book, relocatedCheck.modules,
  pins.requiredModules.map((required: {label: string; sha256: string}) => {
    const matches = relocatedCheck.modules.filter(module => hash(fs.readFileSync(module.file)) === required.sha256);
    assert.equal(matches.length, 1, `relocated source has one ${required.label} module`);
    return {label: required.label, file: matches[0].file};
  }));
const instanceMap = (checked: typeof ordinaryCheck, names: ReturnType<typeof checkedModuleNames>) => {
  const values = Object.values(checked.book.tmps).flatMap(entries => Object.values(entries));
  return new Map(values.map(raw => [names.canonical(raw), raw]));
};
const originalInstances = instanceMap(ordinaryCheck, originalNames);
const relocatedInstances = instanceMap(relocatedCheck, relocatedNames);
const changedInstanceNumbers = [...originalInstances].filter(([canonical, raw]) => {
  const before = raw.match(/~(\d+)$/), after = relocatedInstances.get(canonical)?.match(/~(\d+)$/);
  return Boolean(before && after && before[1] !== after[1]);
});
assert.ok(changedInstanceNumbers.length > 0, 'the end-to-end positive control actually renumbers generic instances');

// A byte-identical required module loaded elsewhere does not legitimize a
// shadow dependency used by the SHA graph.
for (const shadow of ['buffer', 'iteration'] as const) {
  const directory = path.join(outputDirectory, `shadow-${shadow}`);
  fs.rmSync(directory, {recursive: true, force: true});
  const shadowProgram = copyShadowReferenceFixture(directory, shadow);
  await rejects(`shadow mutated ${shadow} with genuine pin loaded elsewhere`,
    () => emitSha256QualifiedSbf(shadowProgram, ['hash_short']),
    /complete checked SHA runtime graph differs from the reviewed identity/);
}

// Same-shaped user code and an unused exact SDK import cannot select a target.
const unusedSource = mutateFixture('unused-sdk-target', {
  editSource: (_file, text) => text + '\ndef user_same_shape(message: SHA.Message) -> SHA.HashResult:\n  SHA.Rejected{}\n',
});
await rejects('unused SDK target and same-shaped user function',
  () => emitSha256QualifiedSbf(unusedSource, ['user_same_shape']), /qualified SHA target was not emitted exactly once/);
await rejects('internal target cannot be promoted to a public root',
  () => emitSha256QualifiedSbf(originalProgram, ['../../sdk/sha256-reference.hash_short']), /must remain an internal transitive function/);

// A same-shaped payload, digest, receipt or target cannot be passed through
// the explicit API as an authorization argument.
await rejects('forged caller payload',
  () => (emitSha256QualifiedSbf as any)(originalProgram, ['hash_short'], {
    expectedDigest: emission.receipt.checkedRuntime.sha256,
    authorized: true,
    target: emission.receipt.target.emittedName,
  }), /only source and ordinary runtime roots are accepted/);
await rejects('cwd/import mismatch', async () => {
  const oldCwd = process.cwd();
  const other = path.join(outputDirectory, 'wrong-cwd');
  fs.mkdirSync(other, {recursive: true});
  try { process.chdir(other); return await emitSha256QualifiedSbf(originalProgram, ['hash_short']); }
  finally { process.chdir(oldCwd); }
}, /cwd\/import mismatch/);

// Full-byte pins refuse semantic changes to the source modules before any C
// substitution. These edits preserve valid checked source and law files.
const roundConstantSource = mutateFixture('mutated-round-constant', {
  editSdk: (relative, text) => relative === 'sdk/sha256-reference.bend'
    ? replaceExactlyOnce(text, '1116352408', '1116352409', 'round-constant mutation') : text,
});
await rejects('SHA body/round-constant source pin',
  () => emitSha256QualifiedSbf(roundConstantSource, ['hash_short']), /required sha256-reference module is absent or its full-byte pin changed/);
const transitiveSource = mutateFixture('mutated-transitive-buffer', {
  editSdk: (relative, text) => relative === 'sdk/buffer.bend'
    ? replaceExactlyOnce(text, 'pick(T, left, right, U32.is_zero(index))', 'pick(T, right, left, U32.is_zero(index))', 'buffer body mutation') : text,
});
await rejects('transitive generic helper source pin',
  () => emitSha256QualifiedSbf(transitiveSource, ['hash_short']), /required buffer module is absent or its full-byte pin changed/);
const iterationBytesSource = mutateFixture('mutated-iteration-bytes', {
  editSdk: (relative, text) => relative === 'sdk/iteration.bend' ? text + '\n# byte-pin probe\n' : text,
});
await rejects('iteration module full-byte pin',
  () => emitSha256QualifiedSbf(iterationBytesSource, ['hash_short']), /required iteration module is absent or its full-byte pin changed/);
const constructorOrderSource = mutateFixture('mutated-constructor-order', {
  editSdk: (relative, text) => relative === 'sdk/sha256-reference.bend'
    ? replaceExactlyOnce(text, '  Rejected{}\n  Hashed{digest: Digest256}', '  Hashed{digest: Digest256}\n  Rejected{}', 'constructor-order mutation') : text,
});
await rejects('constructor-order source pin',
  () => emitSha256QualifiedSbf(constructorOrderSource, ['hash_short']), /required sha256-reference module is absent or its full-byte pin changed/);

// Mutate trusted-book state only after ordinary emission so the qualification
// operation must detect it in the post-emission identity check.
await rejectDuringBackendEmit('primitive metadata mutation during emission', backend => {
  const target = Object.keys(backend.book.tlds).find(name => name.endsWith('sha256-reference.hash_short'));
  assert.ok(target, 'emission book contains the qualified SHA root');
  const definitions = checkedRuntimeIdentity(backend.book, [target]).definitions;
  const name = Object.keys(definitions).find(candidate => {
    const declaration = backend.book.tlds[candidate];
    return candidate.startsWith('U32.') && declaration?.$ === 'Def' && declaration.b === true;
  });
  assert.ok(name, 'emission book graph contains a primitive declaration');
  const declaration = backend.book.tlds[name!];
  const original = declaration.b;
  declaration.b = !original;
  return () => { declaration.b = original; };
}, /checked book identity changed during emission or substitution/);

await rejectDuringBackendEmit('memo cell mutation during emission', backend => {
  const target = Object.keys(backend.book.tlds).find(name => name.endsWith('sha256-reference.hash_short'));
  assert.ok(target, 'emission book contains the qualified SHA root');
  const names = Object.keys(checkedRuntimeIdentity(backend.book, [target]).definitions);
  const seen = new Set<object>();
  let restore: (() => void) | undefined;
  const visit = (value: any) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value.$ === 'Var' && value.v !== undefined && value.v !== null) {
      const original = value.v;
      value.v = Bend.Ref('Bool');
      restore = () => { value.v = original; };
      return;
    }
    for (const child of Object.values(value)) if (!restore) visit(child);
  };
  for (const name of names) {
    visit(backend.book.tlds[name]);
    if (restore) break;
  }
  assert.ok(restore, 'emission book graph contains a mutable type memo cell');
  return restore!;
}, /checked book identity changed during emission or substitution/);

// Source hashes are rechecked after Backend.emit. Restore the changed bytes and
// qualify the same fixture again as a positive control.
const driftDirectory = path.join(outputDirectory, 'transitive-source-drift-during-emission');
fs.rmSync(driftDirectory, {recursive: true, force: true});
const driftProgram = copyReferenceFixture(driftDirectory);
const driftBufferPath = path.join(driftDirectory, 'sdk/buffer.bend');
const driftBufferBefore = fs.readFileSync(driftBufferPath);
const originalEmitForDrift = Backend.prototype.emit;
(Backend.prototype as any).emit = function(this: any, roots: string[]) {
  const result = originalEmitForDrift.call(this, roots);
  fs.appendFileSync(driftBufferPath, '\n# changed during emission\n');
  return result;
};
try {
  await rejects('transitive source byte drift during emission',
    () => emitSha256QualifiedSbf(driftProgram, ['hash_short']),
    /checked source bytes changed during qualification\/emission/);
} finally {
  (Backend.prototype as any).emit = originalEmitForDrift;
  fs.writeFileSync(driftBufferPath, driftBufferBefore);
}
const restoredDrift = await emitSha256QualifiedSbf(driftProgram, ['hash_short']);
assert.equal(restoredDrift.receipt.checkedRuntime.sha256, emission.receipt.checkedRuntime.sha256,
  'restoring the transitive module restores the positive qualification case');
restoredPositiveControls.push('transitive source restored');

// Metadata returned by the inspection API must not bind the selected target
// to another function or another signature.
const originalRecordsMethod = Backend.prototype.emittedFunctions;
(Backend.prototype as any).emittedFunctions = function(this: any) {
  const records = originalRecordsMethod.call(this);
  const target = records.find((record: any) => record.name.endsWith('sha256-reference.hash_short'));
  const other = records.find((record: any) => record !== target && record.name.includes('sha256-reference.'));
  assert.ok(target && other, 'metadata attack fixture has target and sibling definitions');
  target.definition = other.definition;
  return records;
};
try {
  await rejects('metadata points target at wrong generated definition',
    () => emitSha256QualifiedSbf(originalProgram, ['hash_short']),
    /emitted function definition does not match its recorded name and signature/);
} finally {
  (Backend.prototype as any).emittedFunctions = originalRecordsMethod;
}
await expectRestoredPositive('wrong definition metadata');

(Backend.prototype as any).emittedFunctions = function(this: any) {
  const records = originalRecordsMethod.call(this);
  const target = records.find((record: any) => record.name.endsWith('sha256-reference.hash_short'));
  assert.ok(target, 'metadata signature attack fixture has the target definition');
  target.args[0] = 'U32';
  return records;
};
try {
  await rejects('metadata records wrong generated signature',
    () => emitSha256QualifiedSbf(originalProgram, ['hash_short']),
    /emitted function definition does not match its recorded name and signature/);
} finally {
  (Backend.prototype as any).emittedFunctions = originalRecordsMethod;
}
await expectRestoredPositive('wrong signature metadata');

// Existing proof/subset gates remain on the operation's path. Each fixture
// asserts the expected gate reason, so parse/tool failures cannot count as pass.
const missingLaws = mutateFixture('missing-adjacent-laws', {
  editSource: (_file, text) => {
    const withoutImport = replaceExactlyOnce(text, 'import ./LAWS.bend as Laws\n', '', 'missing-laws mutation');
    return withoutImport.replace(/^def Laws\.[^\n]+\n  \{==\}\n(?:\n|$)/gm, '');
  },
});
await rejects('missing adjacent laws', () => emitSha256QualifiedSbf(missingLaws, ['hash_short']), /must import the adjacent LAWS\.bend/);
const proofHole = mutateFixture('proof-hole', {
  editSource: (_file, text) => replaceExactlyOnce(text,
    'def Laws.accepts_last_short_length():\n  {==}', 'def Laws.accepts_last_short_length():\n  ?TODO', 'proof-hole mutation'),
});
await rejects('proof hole', () => emitSha256QualifiedSbf(proofHole, ['hash_short']), /Unresolved proof holes or open laws/);
const openLaw = mutateFixture('open-law', {
  editSource: (_file, text) => replaceExactlyOnce(text,
    'def Laws.accepts_last_short_length():\n  {==}\n\n', '', 'open-law mutation'),
});
await rejects('open law', () => emitSha256QualifiedSbf(openLaw, ['hash_short']), /Unresolved proof holes or open laws/);
const unsafeSource = mutateFixture('unsafe-source', {
  editSource: (_file, text) => text + '\n@unsafe\ndef unsafe_probe(value: U32) -> U32:\n  value\n',
});
await rejects('unsafe foreign-code boundary', () => emitSha256QualifiedSbf(unsafeSource, ['hash_short']), /Unsafe\/foreign dependency/);
const foreignSource = mutateFixture('foreign-source', {
  editSource: (_file, text) => text + '\nlaw foreign_probe:\n  U32 -> IO(U32)\n\ndef foreign_probe(value):\n  import "./foreign.c"\n',
});
fs.writeFileSync(path.join(path.dirname(foreignSource), 'foreign.c'), '');
await rejects('foreign dependency boundary', () => emitSha256QualifiedSbf(foreignSource, ['hash_short']), /Unsafe\/foreign dependency/);

// Catalog, support and the emitter itself are checked against module-relative
// reviewed hashes in an isolated copied tree. The main tree is never edited.
await runSandboxRefusal('altered-catalog', directory => {
  const file = path.join(directory, 'compiler/sha256-qualification-pins.json');
  fs.appendFileSync(file, ' ');
}, /qualification catalog bytes do not match/);
await runSandboxRefusal('altered-support', directory => {
  fs.appendFileSync(path.join(directory, 'compiler/primitives.ts'), '\n// pin mutation\n');
}, /support input hash mismatch: compiler\/primitives\.ts/);
await runSandboxRefusal('altered-emitter', directory => {
  fs.appendFileSync(path.join(directory, 'compiler/sha256-qualified-emission.ts'), '\n// pin mutation\n');
}, /qualified emitter implementation bytes do not match the catalog/);

// Strict native syntax checks compile the exact qualified C plus its reviewed
// SHA header. Spawn/compiler failures are assertion failures, never evidence.
const header = path.join(repositoryRoot, 'runtime/bend_sha256.h');
const cArtifacts = {
  ordinary: path.join(outputDirectory, 'ordinary.c'),
  qualified: path.join(outputDirectory, 'qualified.c'),
};
const generatedHeaders = {
  ordinary: path.join(outputDirectory, 'ordinary.generated.h'),
  qualified: path.join(outputDirectory, 'qualified.generated.h'),
};
fs.writeFileSync(generatedHeaders.ordinary, emission.originalEmission.c);
fs.writeFileSync(generatedHeaders.qualified, emission.c);
for (const [name, file] of Object.entries(cArtifacts)) {
  fs.writeFileSync(file, `#include "${header}"\n#include "${path.basename(generatedHeaders[name as keyof typeof generatedHeaders])}"\n`);
}
const compiler = process.env.CC ?? 'clang';
const compilerArgs = ['-std=c17', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Iruntime', '-fsyntax-only'];
for (const file of Object.values(cArtifacts)) execFileSync(compiler, [...compilerArgs, file], {cwd: repositoryRoot, stdio: 'pipe'});

const testSourceAfter = hash(fs.readFileSync(testPath));
assert.equal(testSourceAfter, testSourceBefore, 'the executing test source stayed fixed while evidence was produced');
const testSupportAfter = hash(fs.readFileSync(testSupportPath));
assert.equal(testSupportAfter, testSupportBefore, 'the executing test support source stayed fixed while evidence was produced');
const evidence = {
  schemaVersion: 1,
  result: 'PASS',
  executingTest: {path: testPath, sha256Before: testSourceBefore, sha256After: testSourceAfter,
    supportPath: testSupportPath, supportSha256Before: testSupportBefore, supportSha256After: testSupportAfter},
  acceptedPrerequisiteScope: {
    normalizedGraph: '8645b9ed82f7d511d033e30422b6bff87de5a364764b9bc241ca88aef9d6860e',
    definitions: 160,
    existingIdentityTestsAreSupportingEvidenceOnly: true,
    primitiveStatusMutationChangesIdentity: true,
    emissionBookMutationRefusals: negativeReasons.filter(item => item.name.includes('mutation during emission')).map(item => item.name),
    memoMutationAndOpenTermCapture: 'memo cell mutation during emission is exercised here; open-term capture remains covered by tests/checked-runtime-identity.ts',
  },
  positiveCases: [
    {name: 'original source', graphSha256: emission.receipt.checkedRuntime.sha256},
    {name: 'relocated source with generic instance renumbering', graphSha256: relocated.receipt.checkedRuntime.sha256,
      unrelatedModuleReceipted: true},
    ...restoredPositiveControls.map(name => ({name, graphSha256: emission.receipt.checkedRuntime.sha256})),
  ],
  negativeReasons,
  negativeFixtureInputs: sourceFilesUnder(outputDirectory),
  qualifiedReceipt: emission.receipt,
  sourceSnapshot: emission.receipt.sourceInputs,
  generatedArtifacts: Object.fromEntries([...Object.entries(cArtifacts), ...Object.entries(generatedHeaders)].map(([name, file]) => [name, {
    path: file, sha256: hash(fs.readFileSync(file)), bytes: fs.statSync(file).size,
  }])),
  syntaxCheck: {compiler, args: compilerArgs, exitStatus: 0},
  scope: {
    finalElfBuiltOrAuthorized: false,
    finalCombinedProductionSbfStillRequired: true,
    universalShaEquivalenceProved: false,
    trustAssumptions: 'trusted process with no hostile in-process patch authority; stable, non-hostile filesystem from import-time module loading through final output',
    loaderHashesAreReadTimeByteReceipts: false,
  },
};
const evidencePath = path.join(outputDirectory, 'evidence.json');
fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
console.log(`SHA qualified SBF emission: original and relocated/renumbered source qualified; ${negativeReasons.length} semantic refusals; strict native C syntax passed; ${evidencePath}`);
