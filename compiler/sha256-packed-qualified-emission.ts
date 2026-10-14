import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Backend, checkedProgram, mangle, type CheckedModule, type EmittedFunction} from './backend.ts';
import {checkedModuleNames} from './checked-module-names.ts';
import {checkedRuntimeIdentity} from './checked-runtime-identity.ts';
import {validateCheckedSourcePaths} from './checked-source-paths.ts';
import {generateSha256Packed, type Sha256PackedIdentity} from './sha256-packed.ts';
import type {RuntimeSchema, TypeSchema, VariantSchema} from './schema.ts';

// The catalog digest is the trust anchor for the module-relative JSON catalog.
// Self-source pinning normalizes this single literal to avoid a hash cycle.
const PACKED_PIN_CATALOG_SHA256 = 'c8b0dac9b6f32310374c7efa016a308af1822dbef3f2757331160ac8e53364f4';

type PinCatalog = {
  schemaVersion: 1;
  purpose: string;
  checkedRuntime: {root: string; sha256: string; definitions: number};
  requiredModules: {label: string; sha256: string}[];
  toolchain: {
    bun: string;
    bunPlatform: string;
    bunArch: string;
    bunExecutable: string;
    bunExecutableSha256: string;
    bendCommit: string;
    bendTsSha256: string;
    baseBendSha256: string;
  };
  selfNormalizedSha256: string;
  supportFiles: Record<string, string>;
  ordinaryShaFixtureEmissionSha256: string;
};

type SourceReceipt = {path: string; namespace: string; sha256: string};

export type QualifiedSha256PackedSbfEmission = {
  kind: 'sha256-packed-qualified-sbf-emission-v1';
  /** This C has one trusted SHA body substituted and has not been ELF-authorized. */
  c: string;
  /** The public schema from ordinary Backend.emit; internal SHA is not exported. */
  schema: RuntimeSchema;
  /** Complete ordinary Backend output, with tagged-sum evidence bound to original C. */
  originalEmission: {
    c: string;
    functions: string[];
    schema: RuntimeSchema;
    taggedSumLowering: {version: 1; operations: unknown[]};
  };
  /** Descriptive immutable evidence. This is not a final-image authorization token. */
  receipt: {
    version: 1;
    qualificationCatalogSha256: string;
    checkedRuntime: {sha256: string; definitions: number; root: string; stableBeforeAfter: true};
    runtimeRoots: string[];
    target: {canonicalName: string; emittedName: string; cName: string; args: string[]; result: string; internal: true};
    sourceInputs: SourceReceipt[];
    supportInputs: Record<string, string>;
    originalEmission: {
      cSha256: string;
      schemaSha256: string;
      taggedSumLoweringSha256: string;
      taggedSumEvidenceScope: 'originalC only';
      emittedDefinitionSha256: string;
      temporaryTargetSchemaSha256: string;
      temporaryTargetSchemaTypeCount: number;
    };
    replacement: {
      definitionSha256: string;
      resultingCSha256: string;
      replacements: 1;
      boundary: 'trusted-sha256-primitive';
    };
    requiredFinalElfProfile: {
      target: 'SBF';
      version: 'SBPFv0';
      requiredImports: ['abort', 'sol_sha256'];
      forbiddenObservationImport: 'sol_log_64_';
      toolchain: 'Anza platform-tools v1.53 / Clang 20.1.7, --target=sbf -mcpu=generic';
      maxStackFrameBytes: 4096;
      abortMustResolveToTheFinalSbfSyscall: true;
      finalElfCallDepthCheckRequired: true;
      finalElfAndArtifactAuthorization: 'not performed by this layer';
    };
    assumptions: {
      process: 'trusted process with no hostile in-process patch authority';
      filesystem: 'stable, non-hostile filesystem from import-time module loading through final output; loader hashes are not read-time byte receipts';
      equivalence: 'finite evidence does not prove universal SHA equivalence or compiler correctness';
    };
  };
};

const fail = (message: string): never => {
  throw new Error(`SHA qualified SBF emission: ${message}`);
};
const hash = (bytes: string | Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const enginePath = fileURLToPath(import.meta.url);
const catalogPath = path.join(path.dirname(enginePath), 'sha256-packed-qualification-pins.json');

function assertRepositoryWorkingDirectory(): void {
  let cwd: string;
  try { cwd = fs.realpathSync(process.cwd()); }
  catch { return fail('cannot resolve current working directory'); }
  let moduleRoot: string;
  try { moduleRoot = fs.realpathSync(projectRoot); }
  catch { return fail('cannot resolve module-relative repository root'); }
  if (cwd !== moduleRoot) fail('cwd/import mismatch; run from the repository root that owns this module');
}

function readCatalog(): {catalog: PinCatalog; bytesSha256: string; normalizedSelfSha256: string} {
  const bytes = fs.readFileSync(catalogPath);
  const bytesSha256 = hash(bytes);
  if (bytesSha256 !== PACKED_PIN_CATALOG_SHA256) fail('qualification catalog bytes do not match the reviewed module-relative pin');
  const selfSource = fs.readFileSync(enginePath, 'utf8');
  const pinLiteral = /const PACKED_PIN_CATALOG_SHA256 = '[0-9a-f]{64}';/g;
  if ([...selfSource.matchAll(pinLiteral)].length !== 1) fail('qualified emitter self-pin marker is missing or ambiguous');
  const normalized = selfSource.replace(pinLiteral, "const PACKED_PIN_CATALOG_SHA256 = '<catalog-digest>';" );
  const normalizedSelfSha256 = hash(normalized);
  let catalog: PinCatalog;
  try { catalog = JSON.parse(bytes.toString('utf8')) as PinCatalog; }
  catch { return fail('qualification catalog is not valid JSON'); }
  if (catalog.schemaVersion !== 1 || catalog.purpose !== 'Reviewed source qualification pins for explicit packed SHA-only SBF emission.') {
    fail('qualification catalog identity mismatch');
  }
  if (catalog.selfNormalizedSha256 !== normalizedSelfSha256) fail('qualified emitter implementation bytes do not match the catalog');
  return {catalog, bytesSha256, normalizedSelfSha256};
}

function withinRoot(file: string): boolean {
  const relative = path.relative(projectRoot, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function supportSnapshot(catalog: PinCatalog, catalogSha256: string, normalizedSelfSha256: string): Record<string, string> {
  if (hash(fs.readFileSync(catalogPath)) !== catalogSha256) fail('qualification catalog changed during operation');
  const result: Record<string, string> = Object.create(null);
  const entries = Object.entries(catalog.supportFiles).sort(([a], [b]) => a.localeCompare(b));
  if (new Set(entries.map(([file]) => file)).size !== entries.length) fail('duplicate support path in catalog');
  for (const [relative, expected] of entries) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) fail(`invalid module-relative support path ${relative}`);
    const file = path.resolve(projectRoot, relative);
    if (!withinRoot(file)) fail(`support path escapes module root: ${relative}`);
    let actualPath: string;
    try { actualPath = fs.realpathSync(file); }
    catch { return fail(`missing pinned support input ${relative}`); }
    if (actualPath !== file) fail(`support input resolves through a path alias: ${relative}`);
    const digest = hash(fs.readFileSync(file));
    if (!/^[0-9a-f]{64}$/.test(expected) || digest !== expected) fail(`support input hash mismatch: ${relative}`);
    result[relative] = digest;
  }
  result['compiler/sha256-packed-qualified-emission.ts#normalized'] = normalizedSelfSha256;
  result['compiler/sha256-packed-qualified-emission.ts#raw'] = hash(fs.readFileSync(enginePath));
  result['compiler/sha256-packed-qualification-pins.json'] = catalogSha256;
  return result;
}

function checkPinnedToolchain(catalog: PinCatalog): Record<string, string> {
  if (process.versions.bun !== catalog.toolchain.bun) fail(`Bun version must be ${catalog.toolchain.bun}`);
  if (process.platform !== catalog.toolchain.bunPlatform || process.arch !== catalog.toolchain.bunArch) {
    fail(`unsupported Bun platform/architecture: ${process.platform}/${process.arch}; this qualification pin supports ${catalog.toolchain.bunPlatform}/${catalog.toolchain.bunArch}`);
  }
  const bunExecutable = path.resolve(projectRoot, catalog.toolchain.bunExecutable);
  let resolvedBun: string;
  let runningBun: string;
  try {
    resolvedBun = fs.realpathSync(bunExecutable);
    runningBun = fs.realpathSync(process.execPath);
  } catch { return fail('cannot resolve pinned Bun executable'); }
  if (resolvedBun !== runningBun) fail('running Bun executable differs from the repository-pinned Bun');
  const bunSha256 = hash(fs.readFileSync(resolvedBun));
  if (bunSha256 !== catalog.toolchain.bunExecutableSha256) fail('pinned Bun executable bytes mismatch');
  const bend = path.join(projectRoot, '.deps', 'bend');
  let root: string;
  try { root = fs.realpathSync(bend); }
  catch { return fail('pinned Bend checkout is missing'); }
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8'}).trim();
  let commit: string;
  let status: string;
  try {
    commit = git(['rev-parse', 'HEAD']);
    status = git(['status', '--porcelain', '--untracked-files=all']);
  } catch { return fail('cannot inspect pinned Bend checkout'); }
  if (commit !== catalog.toolchain.bendCommit) fail('Bend checkout commit mismatch');
  if (status !== '') fail('Bend checkout must be clean');
  const bendTs = path.join(root, 'bend2', 'bend.ts');
  const base = path.join(root, 'bend2', 'base.bend');
  if (hash(fs.readFileSync(bendTs)) !== catalog.toolchain.bendTsSha256) fail('pinned Bend checker bytes mismatch');
  if (hash(fs.readFileSync(base)) !== catalog.toolchain.baseBendSha256) fail('pinned Bend Base bytes mismatch');
  return {
    'toolchain/bun-executable': bunSha256,
    'toolchain/bend-commit': commit,
    'toolchain/bend2/bend.ts': catalog.toolchain.bendTsSha256,
    'toolchain/bend2/base.bend': catalog.toolchain.baseBendSha256,
  };
}

function rootList(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) {
    fail('ordinary runtime roots must be a plain string array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter(key => key !== 'length');
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) fail('runtime roots must be a dense array');
  const roots = keys.map(key => {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !descriptor.value) {
      return fail('runtime roots must contain only nonempty strings');
    }
    return descriptor.value;
  });
  if (!roots.length || new Set(roots).size !== roots.length) fail('runtime roots must be nonempty and unique');
  return roots;
}

function sourceSnapshot(source: string, modules: readonly CheckedModule[], files: readonly string[]): SourceReceipt[] {
  if (modules.length !== files.length || modules.length > 4096) fail('checked loader map is incomplete or exceeds the profile limit');
  const seen = new Set<string>();
  const receipts: SourceReceipt[] = [];
  for (let index = 0; index < modules.length; index++) {
    const module = modules[index];
    if (module.file !== files[index] || seen.has(module.file)) fail('checked loader file/map order is inconsistent');
    seen.add(module.file);
    receipts.push({path: module.file, namespace: module.namespace, sha256: hash(fs.readFileSync(module.file))});
  }
  if (!receipts.some(item => item.path === fs.realpathSync(source))) fail('entry source is absent from the checked loader map');
  return receipts;
}

function sourceModulePins(catalog: PinCatalog, sourceInputs: readonly SourceReceipt[], modules: readonly CheckedModule[]): Map<string, CheckedModule> {
  const byLabel = new Map<string, CheckedModule>();
  for (const required of catalog.requiredModules) {
    if (!/^[a-z][a-z0-9-]*$/.test(required.label) || !/^[0-9a-f]{64}$/.test(required.sha256)) {
      fail(`invalid reviewed source pin for ${required.label}`);
    }
    const matching = sourceInputs.filter(input => input.sha256 === required.sha256);
    if (matching.length !== 1) {
      fail(matching.length ? `required ${required.label} module has ambiguous exact-byte matches` : `required ${required.label} module is absent or its full-byte pin changed`);
    }
    const moduleMatches = modules.filter(module => module.file === matching[0].path);
    if (moduleMatches.length !== 1) fail(`required ${required.label} loader-map origin is missing or ambiguous`);
    byLabel.set(required.label, moduleMatches[0]);
  }
  if (new Set([...byLabel.values()].map(module => module.file)).size !== catalog.requiredModules.length) {
    fail('required module pins resolve to the same physical source');
  }
  return byLabel;
}

function targetForCatalogRoot(
  catalogRoot: string,
  identity: ReturnType<typeof checkedModuleNames>,
  shaModule: CheckedModule,
  book: Parameters<typeof checkedRuntimeIdentity>[0],
): string {
  const candidates = [...identity.names]
    .filter(([raw, canonical]) => canonical === catalogRoot && shaModule.declarations.includes(raw) && book.tlds[raw]?.$ === 'Def')
    .map(([raw]) => raw);
  if (candidates.length !== 1) fail('pinned SHA target is absent or ambiguous in its checked module origin');
  return candidates[0];
}

function schemaType(schema: RuntimeSchema, name: string): TypeSchema {
  const matches = schema.types.filter(type => type.name === name);
  if (matches.length !== 1) fail(`internal target schema does not contain one ${name} type`);
  return matches[0];
}

function adt(schema: RuntimeSchema, name: string): Extract<TypeSchema, {kind: 'adt'}> {
  const type = schemaType(schema, name);
  if (type.kind !== 'adt') fail(`qualified SHA type is not an ADT: ${name}`);
  return type;
}

function oneVariant(type: Extract<TypeSchema, {kind: 'adt'}>, label: string): VariantSchema {
  if (type.variants.length !== 1) fail(`${label} must have one constructor in the ordinary emitted schema`);
  return type.variants[0];
}

function temporaryTargetSchema(schema: RuntimeSchema, record: EmittedFunction): RuntimeSchema {
  const types = new Map(schema.types.map(type => [type.name, type]));
  const needed = new Set<string>();
  const pending = [...record.args, record.result];
  while (pending.length) {
    const name = pending.pop()!;
    if (needed.has(name)) continue;
    const type = types.get(name);
    if (!type) fail(`internal target signature references an absent schema type: ${name}`);
    needed.add(name);
    if (type.kind === 'adt') for (const variant of type.variants) {
      for (const field of variant.fields) pending.push(field.type);
    }
  }
  return {
    version: schema.version,
    types: structuredClone(schema.types.filter(type => needed.has(type.name))),
    exports: [{name: record.name, cName: record.cName, args: [...record.args], result: record.result}],
  };
}

function deriveInternalIdentity(record: EmittedFunction, temporarySchema: RuntimeSchema): Sha256PackedIdentity {
  if (record.args.length !== 1) fail('pinned SHA internal target must have one emitted argument');
  const messageType = record.args[0];
  const message = oneVariant(adt(temporarySchema, messageType), 'Message');
  if (message.fields.length !== 2) fail('Message must have two emitted fields');
  const lengthField = message.fields.find(field => field.name === 'length');
  const bytesField = message.fields.find(field => field.name === 'bytes');
  if (!lengthField || !bytesField) fail('Message fields do not match the reviewed source field names');
  const bytesType = bytesField.type;
  const bytes = oneVariant(adt(temporarySchema, bytesType), 'Bytes160');
  if (bytes.fields.length !== 2 || bytes.fields[0].name !== 'words' || bytes.fields[1].name !== 'tail') fail('Bytes160 emitted field shape mismatch');
  const pairTypes: string[] = [];
  let childType = bytes.fields[0].type;
  let pairConstructor = '';
  for (let level = 0; level < 5; level++) {
    pairTypes.push(childType);
    const pair = oneVariant(adt(temporarySchema, childType), `Pair level ${level}`);
    const sourceName = pair.sourceName ?? pair.name;
    if (!pairConstructor) pairConstructor = sourceName;
    else if (sourceName !== pairConstructor) fail('binary Pair levels resolve to different source constructors');
    if (pair.name !== childType || pair.fields.length !== 2 || pair.fields[0].name !== 'left' || pair.fields[1].name !== 'right') {
      fail(`binary Pair emitted shape mismatch at level ${level}`);
    }
    const next = pair.fields[0].type;
    if (pair.fields[1].type !== next) fail(`binary Pair child types differ at level ${level}`);
    childType = next;
  }
  const resultType = record.result;
  const result = adt(temporarySchema, resultType);
  if (result.variants.length !== 2 || result.variants[0].fields.length !== 0 || result.variants[1].fields.length !== 1) {
    fail('HashResult emitted constructor shape mismatch');
  }
  const rejected = result.variants[0], hashed = result.variants[1];
  const digestField = hashed.fields[0];
  const digestType = digestField.type;
  const digest = oneVariant(adt(temporarySchema, digestType), 'Digest256');
  if (digest.fields.length !== 8) fail('Digest256 must have eight emitted fields');
  return {
    export: {name: record.name, cName: record.cName},
    u32Type: lengthField.type,
    message: {type: messageType, constructor: message.sourceName ?? message.name,
      lengthField: lengthField.name, bytesField: bytesField.name},
    bytes: {type: bytesType, constructor: bytes.sourceName ?? bytes.name, wordsField: bytes.fields[0].name, tailField: bytes.fields[1].name},
    pair: {types: pairTypes as [string, string, string, string, string], constructor: pairConstructor,
      leftField: 'left', rightField: 'right'},
    result: {type: resultType, rejected: rejected.sourceName ?? rejected.name,
      hashed: hashed.sourceName ?? hashed.name, digestField: digestField.name},
    digest: {type: digestType, constructor: digest.sourceName ?? digest.name,
      fields: digest.fields.map(field => field.name) as [string, string, string, string, string, string, string, string]},
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function countOneExact(value: string, needle: string, label: string): void {
  if (!needle || value.split(needle).length !== 2) fail(`${label} must occur exactly once in ordinary C`);
}

function signatureCType(schema: RuntimeSchema, typeName: string): string {
  const matches = schema.types.filter(type => type.name === typeName);
  if (matches.length !== 1) fail(`emitted function signature references an absent or ambiguous schema type: ${typeName}`);
  return matches[0].cType;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertGeneratedDefinitionBinding(record: EmittedFunction, definition: string, schema: RuntimeSchema): void {
  if (typeof record.name !== 'string' || !record.name || typeof record.cName !== 'string' || !record.cName ||
      record.cName !== mangle(record.name) || !Array.isArray(record.args) || typeof record.result !== 'string' ||
      typeof definition !== 'string' || !definition) {
    fail('emitted function metadata is malformed or its C name does not match its checked name');
  }
  const resultType = signatureCType(schema, record.result);
  const arguments_ = record.args.map((type, index) => {
    if (typeof type !== 'string' || !type) fail(`emitted function argument ${index} has an invalid schema type`);
    return `${regexEscape(signatureCType(schema, type))} [A-Za-z_][A-Za-z0-9_]*`;
  });
  const header = new RegExp(`^static (?:inline|__attribute__\\(\\(noinline\\)\\)) ${regexEscape(resultType)} ${regexEscape(record.cName)}\\(${arguments_.join(', ') || 'void'}\\) \\{\\n`);
  if (!header.test(definition) || !definition.endsWith('\n}')) {
    fail('emitted function definition does not match its recorded name and signature');
  }
}

function assertOrdinaryFunctionRecords(
  ordinary: {c: string; functions: string[]; schema: RuntimeSchema},
  records: EmittedFunction[],
): void {
  if (!Array.isArray(ordinary.functions) || !Array.isArray(records) ||
      ordinary.functions.length !== records.length || new Set(ordinary.functions).size !== ordinary.functions.length) {
    fail('ordinary emitted function list and function metadata are inconsistent');
  }
  const byName = new Map<string, EmittedFunction>();
  const cNames = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (record.name !== ordinary.functions[index] || byName.has(record.name) || cNames.has(record.cName)) {
      fail('ordinary emitted function list and function metadata are inconsistent');
    }
    assertGeneratedDefinitionBinding(record, record.definition, ordinary.schema);
    countOneExact(ordinary.c, record.definition, `emitted function definition ${record.name}`);
    byName.set(record.name, record);
    cNames.add(record.cName);
  }
  if (new Set(ordinary.schema.types.map(type => type.name)).size !== ordinary.schema.types.length ||
      ordinary.schema.exports.length > byName.size) {
    fail('ordinary schema does not describe its emitted function set');
  }
  for (const export_ of ordinary.schema.exports) {
    const record = byName.get(export_.name);
    if (!record || export_.cName !== record.cName || export_.result !== record.result ||
        JSON.stringify(export_.args) !== JSON.stringify(record.args)) {
      fail('ordinary schema export differs from its emitted function metadata');
    }
  }
}

/**
 * Explicit source-qualified SBF C emission. There is no expected digest,
 * permission flag, receipt, target name, or profile argument in this API.
 * This operation runs checkedProgram and the ordinary proof/subset gates,
 * then binds one checked book through qualification, ordinary Backend emission,
 * and one exact internal definition replacement.
 */
export async function emitSha256PackedQualifiedSbf(
  sourcePath: string,
  runtimeRootsInput: readonly string[],
): Promise<QualifiedSha256PackedSbfEmission> {
  if (arguments.length !== 2) fail('only source and ordinary runtime roots are accepted');
  assertRepositoryWorkingDirectory();
  const roots = rootList(runtimeRootsInput);
  const {catalog, bytesSha256: catalogSha256, normalizedSelfSha256} = readCatalog();
  const toolchainBefore = checkPinnedToolchain(catalog);
  const supportBefore = supportSnapshot(catalog, catalogSha256, normalizedSelfSha256);
  const source = path.resolve(process.cwd(), sourcePath);

  // checkedProgram performs the existing Bend checking, laws/proofs, unsafe/
  // foreign scan and all ordinary loader checks. Its single book is retained.
  const checked = await checkedProgram(source);
  const validatedFiles = validateCheckedSourcePaths(source, checked.modules);
  if (validatedFiles.length !== checked.files.length || validatedFiles.some((file, index) => file !== checked.files[index])) {
    fail('validated source paths differ from the actual checked loader map');
  }
  const sourcesBefore = sourceSnapshot(source, checked.modules, checked.files);
  const resolved = sourceModulePins(catalog, sourcesBefore, checked.modules);
  const bindings = catalog.requiredModules.map(({label}) => ({label, file: resolved.get(label)!.file}));
  const names = checkedModuleNames(checked.book, checked.modules, bindings);
  const targetName = targetForCatalogRoot(catalog.checkedRuntime.root, names,
    resolved.get('sha256-packed')!, checked.book);
  if (roots.includes(targetName)) fail('qualified SHA target must remain an internal transitive function, not a runtime root');
  const identityBefore = checkedRuntimeIdentity(checked.book, [targetName], names.canonical);
  if (identityBefore.sha256 !== catalog.checkedRuntime.sha256 ||
      Object.keys(identityBefore.definitions).length !== catalog.checkedRuntime.definitions ||
      identityBefore.roots.length !== 1 || identityBefore.roots[0] !== catalog.checkedRuntime.root) {
    fail('complete checked SHA runtime graph differs from the reviewed identity');
  }

  // No await occurs between the same-book identity, Backend emission, schema
  // generation, replacement and the second identity check.
  const backend = new Backend(checked.book);
  const ordinary = backend.emit(roots);
  const records = backend.emittedFunctions();
  assertOrdinaryFunctionRecords(ordinary, records);
  const targetRecords = records.filter(record => record.name === targetName);
  if (targetRecords.length !== 1) fail('qualified SHA target was not emitted exactly once by the ordinary runtime roots');
  const target: EmittedFunction = targetRecords[0];

  const temporarySchema = temporaryTargetSchema(ordinary.schema, target);
  const generatorIdentity = deriveInternalIdentity(target, temporarySchema);
  const replacement = generateSha256Packed(temporarySchema, generatorIdentity);
  assertGeneratedDefinitionBinding(target, replacement.definition, temporarySchema);
  const targetOffset = ordinary.c.indexOf(target.definition);
  const originalPrefix = ordinary.c.slice(0, targetOffset);
  const originalSuffix = ordinary.c.slice(targetOffset + target.definition.length);
  const resultingC = originalPrefix + replacement.definition + originalSuffix;
  countOneExact(resultingC, replacement.definition, 'qualified replacement definition');
  if (resultingC.includes(target.definition) || !resultingC.startsWith(originalPrefix) || !resultingC.endsWith(originalSuffix)) {
    fail('qualified replacement must change only the exact internal target definition');
  }
  for (const record of records) if (record.name !== targetName) {
    countOneExact(resultingC, record.definition, `preserved emitted function definition ${record.name}`);
  }

  const identityAfter = checkedRuntimeIdentity(checked.book, [targetName], names.canonical);
  if (JSON.stringify(identityAfter) !== JSON.stringify(identityBefore)) fail('checked book identity changed during emission or substitution');
  const sourcesAfter = sourceSnapshot(source, checked.modules, checked.files);
  if (JSON.stringify(sourcesAfter) !== JSON.stringify(sourcesBefore)) fail('checked source bytes changed during qualification/emission');
  const validatedFilesAfter = validateCheckedSourcePaths(source, checked.modules);
  if (validatedFilesAfter.length !== checked.files.length || validatedFilesAfter.some((file, index) => file !== checked.files[index])) {
    fail('validated source paths changed during qualification/emission');
  }
  const supportAfter = supportSnapshot(catalog, catalogSha256, normalizedSelfSha256);
  if (JSON.stringify(supportAfter) !== JSON.stringify(supportBefore)) fail('compiler/support bytes changed during qualification/emission');
  const toolchainAfter = checkPinnedToolchain(catalog);
  if (JSON.stringify(toolchainAfter) !== JSON.stringify(toolchainBefore)) fail('pinned Bend/Bun bytes changed during qualification/emission');
  const supportReceipt = {...supportBefore, ...toolchainBefore};

  const originalC = ordinary.c;
  const originalSchema = structuredClone(ordinary.schema);
  const originalEvidence = structuredClone(ordinary.taggedSumLowering);
  const originalEmission = {
    c: originalC,
    functions: [...ordinary.functions],
    schema: originalSchema,
    taggedSumLowering: originalEvidence,
  };
  const receipt = {
    version: 1 as const,
    qualificationCatalogSha256: catalogSha256,
    checkedRuntime: {sha256: identityBefore.sha256, definitions: Object.keys(identityBefore.definitions).length,
      root: catalog.checkedRuntime.root, stableBeforeAfter: true as const},
    runtimeRoots: [...roots],
    target: {canonicalName: catalog.checkedRuntime.root, emittedName: target.name, cName: target.cName,
      args: [...target.args], result: target.result, internal: true as const},
    sourceInputs: sourcesBefore,
    supportInputs: supportReceipt,
    originalEmission: {
      cSha256: hash(originalC),
      schemaSha256: hash(JSON.stringify(originalSchema)),
      taggedSumLoweringSha256: hash(JSON.stringify(originalEvidence)),
      taggedSumEvidenceScope: 'originalC only' as const,
      emittedDefinitionSha256: hash(target.definition),
      temporaryTargetSchemaSha256: hash(JSON.stringify(temporarySchema)),
      temporaryTargetSchemaTypeCount: temporarySchema.types.length,
    },
    replacement: {
      definitionSha256: hash(replacement.definition),
      resultingCSha256: hash(resultingC),
      replacements: 1 as const,
      boundary: 'trusted-sha256-primitive' as const,
    },
    requiredFinalElfProfile: {
      target: 'SBF' as const,
      version: 'SBPFv0' as const,
      requiredImports: ['abort', 'sol_sha256'] as ['abort', 'sol_sha256'],
      forbiddenObservationImport: 'sol_log_64_' as const,
      toolchain: 'Anza platform-tools v1.53 / Clang 20.1.7, --target=sbf -mcpu=generic' as const,
      maxStackFrameBytes: 4096 as const,
      abortMustResolveToTheFinalSbfSyscall: true as const,
      finalElfCallDepthCheckRequired: true as const,
      finalElfAndArtifactAuthorization: 'not performed by this layer' as const,
    },
    assumptions: {
      process: 'trusted process with no hostile in-process patch authority' as const,
      filesystem: 'stable, non-hostile filesystem from import-time module loading through final output; loader hashes are not read-time byte receipts' as const,
      equivalence: 'finite evidence does not prove universal SHA equivalence or compiler correctness' as const,
    },
  };
  return deepFreeze({
    kind: 'sha256-packed-qualified-sbf-emission-v1' as const,
    c: resultingC,
    schema: originalSchema,
    originalEmission,
    receipt,
  });
}

// Keep this local helper referenced in emitted code reviews: the complete
// checked identity is data, not a caller-provided authorization payload.
