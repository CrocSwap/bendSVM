import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generateSha256Short, type Sha256ShortIdentity } from '../compiler/sha256-short.ts';
import type { RuntimeSchema, TypeSchema } from '../compiler/schema.ts';

type ProcessResult = ReturnType<typeof spawnSync>;

const sourceRoot = path.resolve(process.env.SHA256_SHORT_SOURCE_ROOT ?? '.');
const work = process.env.SHA256_SHORT_WORK_DIR
  ? path.resolve(process.env.SHA256_SHORT_WORK_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'sha256-short-lowering-'));
fs.mkdirSync(work, { recursive: true });

function fail(message: string): never {
  throw new Error(`SHA-256 short lowering: ${message}`);
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function run(command: string, args: string[], label: string): ProcessResult {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error) fail(`${label} spawn failure: ${String(result.error)}`);
  return result;
}

function processText(result: ProcessResult): string {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function expectProcessSuccess(result: ProcessResult, label: string): void {
  if (result.status !== 0) fail(`${label} failed with status=${result.status} signal=${result.signal}:\n${processText(result)}`);
}

const requiredSourceFiles = [
  'sdk/sha256-reference.bend',
  'runtime/bend_sha256.h',
  'runtime/solana_min.h',
  'compiler/schema.ts',
  'compiler/backend.ts',
  '.deps/bend/bend2/bend.ts',
  'tests/sha256-reference/PROOF.bend',
  'tests/sha256-reference/LAWS.bend',
  'sdk/buffer.bend',
  'sdk/iteration.bend',
];
const reviewedSourceFiles = [
  'tests/sha256-reference.ts',
  'build/overnight/sha_specialization_provenance_scout-result.txt',
];
for (const relative of requiredSourceFiles) {
  if (!fs.existsSync(path.join(sourceRoot, relative))) fail(`missing source prerequisite ${path.join(sourceRoot, relative)}`);
}

assert.equal(hashFile(path.join(sourceRoot, 'compiler/schema.ts')), hashFile('compiler/schema.ts'),
  'current main schema definition matches the generator compile-time schema');
const currentBackend = await import(pathToFileURL(path.join(sourceRoot, 'compiler/backend.ts')).href) as
  typeof import('../compiler/backend.ts');
const sourceProgram = await currentBackend.checkedProgram(path.join(sourceRoot, 'tests/sha256-reference/PROOF.bend'));
const emitted = new currentBackend.Backend(sourceProgram.book).emit(['hash_short']);
assert.deepEqual(emitted.schema.exports.map(item => item.name), ['hash_short'], 'one checked reference export emitted');
assert.doesNotMatch(emitted.c, /sol_sha256|bend_sha256_hashv/, 'ordinary checked source header has no SHA syscall');

const SHA = '../../sdk/sha256-reference.';
const PAIR = '../../sdk/buffer.Pair';
const pair0 = `${PAIR}<U32>`;
const pair1 = `${PAIR}<${pair0}>`;
const pair2 = `${PAIR}<${pair1}>`;
const pair3 = `${PAIR}<${pair2}>`;
const pair4 = `${PAIR}<${pair3}>`;
const pair5 = `${PAIR}<${pair4}>`;
const identity: Sha256ShortIdentity = {
  export: { name: 'hash_short', cName: 'bend_hash_5f_short' },
  u32Type: 'U32',
  message: {
    type: `${SHA}Message`, constructor: `${SHA}Message`, lengthField: 'length', bytesField: 'bytes',
  },
  bytes: { type: `${SHA}Bytes64`, constructor: `${SHA}Bytes64`, wordsField: 'words' },
  pair: {
    types: [pair5, pair4, pair3, pair2, pair1, pair0],
    constructor: PAIR,
    leftField: 'left', rightField: 'right',
  },
  result: {
    type: `${SHA}HashResult`, rejected: `${SHA}Rejected`, hashed: `${SHA}Hashed`, digestField: 'digest',
  },
  digest: {
    type: `${SHA}Digest256`, constructor: `${SHA}Digest256`,
    fields: ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'],
  },
};
const generated = generateSha256Short(emitted.schema, identity);
assert.equal(generated.slotPaths.length, 64, 'validated 64 leaf access paths');
assert.match(generated.definition, /bend_sha256_hashv\(&sha256_short_slice, 1u, sha256_short_digest\)/);
assert.doesNotMatch(generated.definition, /__builtin_unreachable/);
assert.ok(generated.definition.indexOf('sha256_short_length > 55u') < generated.definition.indexOf(generated.slotPaths[0]),
  'length guard precedes all byte slot reads');
assert.ok(generated.definition.includes(generated.slotPaths[0]), 'first slot path comes from emitted C layout');
for (let i = 0; i < 55; i++) {
  assert.ok(generated.definition.includes(`if (sha256_short_length > ${i}u) { /* active slot ${i} */`),
    `active slot ${i} guard emitted`);
}
assert.ok(!generated.definition.includes(generated.slotPaths[55]), 'slot 55 is never read by the short-message body');

function schemaType(schema: RuntimeSchema, name: string): TypeSchema {
  const type = schema.types.find(item => item.name === name);
  assert(type, `schema has type ${name}`);
  return type;
}

function mutateType(schema: RuntimeSchema, name: string, mutate: (type: TypeSchema) => void): void {
  mutate(schemaType(schema, name));
}

function expectSchemaReject(
  label: string,
  changed: RuntimeSchema,
  expectedMessage: RegExp,
  changedIdentity: Sha256ShortIdentity = identity,
): void {
  let rejected: unknown;
  try {
    generateSha256Short(changed, changedIdentity);
  } catch (error) {
    rejected = error;
  }
  assert(rejected instanceof Error, `${label}: malformed schema must reject`);
  assert.match(rejected.message, expectedMessage, `${label}: diagnostic identifies semantic mismatch`);
}

{
  const changed = structuredClone(emitted.schema);
  changed.exports[0].args.push('U32');
  expectSchemaReject('argument arity', changed, /exactly one/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.message.type, type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].fields.reverse();
  });
  expectSchemaReject('Message field order', changed, /Message field 0/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.message.type, type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].fields[0].type = 'Bool';
  });
  expectSchemaReject('Message length primitive', changed, /Message field 0/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.pair.types[5], type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].fields[1].type = 'Bool';
  });
  expectSchemaReject('binary U32 leaf', changed, /binary pair level 5 field 1/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.pair.types[0], type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].fields.reverse();
  });
  expectSchemaReject('binary left/right order', changed, /binary pair level 0 field 0/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.result.type, type => {
    assert.equal(type.kind, 'adt');
    type.variants.reverse();
  });
  expectSchemaReject('result constructor order/tag', changed, /order\/tag mismatch/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.digest.type, type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].fields.reverse();
  });
  expectSchemaReject('digest word order', changed, /Digest256 field 0/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.bytes.type, type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].name += '_altered';
  });
  expectSchemaReject('constructor identity', changed, /constructor identity\/tag mismatch/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.pair.types[0], type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].name += '_altered';
  });
  expectSchemaReject('specialized pair constructor identity', changed, /specialized constructor identity mismatch/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.message.type, type => { type.cType = 'not-a-C-type'; });
  expectSchemaReject('C type identifier', changed, /safe C identifier/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.bytes.type, type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].cMaker = 'not-a-C-maker;';
  });
  expectSchemaReject('C maker identifier', changed, /safe C identifier/);
}
{
  const changed = structuredClone(emitted.schema);
  changed.types.push(structuredClone(changed.types[0]));
  expectSchemaReject('duplicate type', changed, /duplicate type identity/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.bytes.type, type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].fields[0].type = identity.message.type;
  });
  expectSchemaReject('cyclic schema', changed, /recursive schema type/);
}
{
  const changed = structuredClone(emitted.schema);
  changed.exports[0].cName = 'bad-name';
  expectSchemaReject('export C identifier', changed, /safe C identifier/);
}
{
  const changed = structuredClone(emitted.schema);
  const natType = changed.types.find(type => type.name === 'Nat');
  if (natType) {
    if (natType.kind !== 'u32') throw new Error('checked Nat schema identity must be a primitive');
    natType.max = 64;
  } else {
    changed.types.push({ kind: 'u32', name: 'Nat', cType: 'bend_u32', max: 64 });
  }
  for (const type of changed.types) {
    if (type.kind !== 'adt') continue;
    for (const variant of type.variants) for (const field of variant.fields) {
      if (field.type === 'U32') field.type = 'Nat';
    }
  }
  const natIdentity = structuredClone(identity);
  natIdentity.u32Type = 'Nat';
  expectSchemaReject('bounded Nat primitive', changed, /U32 type must be unbounded/, natIdentity);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.digest.type, type => { type.cType = 'sha256_short_digest'; });
  expectSchemaReject('generated local name collision', changed, /collides with a generated/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, identity.digest.type, type => {
    assert.equal(type.kind, 'adt');
    type.variants[0].cMaker = 'sol_sha256';
  });
  expectSchemaReject('SHA runtime name collision', changed, /collides with a generated or SHA runtime/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, 'U32', type => { type.cType = 'bool'; });
  expectSchemaReject('C23 keyword C type', changed, /safe C identifier/);
}
{
  const changed = structuredClone(emitted.schema);
  changed.exports[0].cName = 'main';
  expectSchemaReject('host entry point collision', changed, /collides with a generated or SHA runtime/);
}

const headerPath = path.join(work, 'checked-sha256-reference.h');
fs.writeFileSync(headerPath, emitted.c);
const runtimeHeader = path.join(sourceRoot, 'runtime/bend_sha256.h');
const clang = process.env.CC ?? 'clang';
const versionResult = run(clang, ['--version'], 'host Clang version');
expectProcessSuccess(versionResult, 'host Clang version');
const versionLine = processText(versionResult).split('\n')[0];
const compilerPath = clang.includes(path.sep) ? path.resolve(clang) : (run('which', [clang], 'resolve host Clang').stdout as string).trim();
const compilerRealPath = fs.realpathSync(compilerPath);

const vectors = Array.from({ length: 56 }, (_, length) => {
  const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + length * 11) & 255));
  return { bytes, digest: createHash('sha256').update(bytes).digest() };
});
const edgeBytes = Buffer.from([0, 255]);
const edgeDigest = createHash('sha256').update(edgeBytes).digest();
const orderBytes = Buffer.from([0x12, 0xa5]);
const orderDigest = createHash('sha256').update(orderBytes).digest();

function cBytes(bytes: Uint8Array): string {
  return [...bytes].map(byte => `0x${byte.toString(16).padStart(2, '0')}u`).join(', ');
}

const digestTable = vectors.map(vector => `  { ${cBytes(vector.digest)} }`).join(',\n');
const edgeDigestC = cBytes(edgeDigest);
const orderDigestC = cBytes(orderDigest);
const typeByName = new Map(emitted.schema.types.map(type => [type.name, type]));
const messageType = typeByName.get(identity.message.type)!;
const bytesType = typeByName.get(identity.bytes.type)!;
const pairRoot = typeByName.get(identity.pair.types[0])!;
const resultType = typeByName.get(identity.result.type)!;
const digestType = typeByName.get(identity.digest.type)!;
assert.equal(messageType.kind, 'adt');
assert.equal(bytesType.kind, 'adt');
assert.equal(pairRoot.kind, 'adt');
assert.equal(resultType.kind, 'adt');
assert.equal(digestType.kind, 'adt');
const messageVariant = messageType.variants[0];
const bytesVariant = bytesType.variants[0];
const resultRejected = resultType.variants[0];
const resultHashed = resultType.variants[1];
const digestVariant = digestType.variants[0];

function pairExpression(level: number, offset: number): string {
  const pair = typeByName.get(identity.pair.types[level]);
  assert(pair && pair.kind === 'adt');
  const variant = pair.variants[0];
  const left = level === 5 ? `slots[${offset}]` : pairExpression(level + 1, offset);
  const rightOffset = offset + 2 ** (5 - level);
  const right = level === 5 ? `slots[${rightOffset}]` : pairExpression(level + 1, rightOffset);
  return `${variant.cMaker}(${left}, ${right})`;
}

const rootPairExpr = pairExpression(0, 0);
const resultCode = `
#define ${identity.export.cName} sha256_short_checked_reference
#include "${headerPath}"
#undef ${identity.export.cName}
#include "${runtimeHeader}"
/* SHA256_SHORT_GENERATED_DEFINITION */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

static const u8 expected_digests[56][32] = {
${digestTable}
};
static const u8 edge_digest[32] = { ${edgeDigestC} };
static const u8 order_digest[32] = { ${orderDigestC} };
static u8 expected_input[55];
static u64 expected_input_len;
static const u8 *expected_digest;
static u64 syscall_calls;
static u64 injected_syscall_status;
static int input_mismatch;
static int syscall_must_not_run;

static ${messageType.cType} make_message(bend_u32 length, const bend_u32 slots[64]) {
  ${pairRoot.cType} tree = ${rootPairExpr};
  ${bytesType.cType} bytes = ${bytesVariant.cMaker}(tree);
  return ${messageVariant.cMaker}(length, bytes);
}

u64 sol_sha256(const u8 *vals, u64 val_len, u8 *hash_result) {
  ++syscall_calls;
  if (syscall_must_not_run) {
    for (u32 i = 0; i < 32u; ++i) hash_result[i] = 0;
    return 0;
  }
  if (val_len != 1u) input_mismatch = 1;
  if (val_len == 1u) {
    const BendSha256Slice *part = (const BendSha256Slice *)vals;
    if (part->len != expected_input_len) input_mismatch = 1;
    if (part->len <= 55u && part->len == expected_input_len) {
      for (u64 i = 0; i < part->len; ++i) {
        if (part->data[i] != expected_input[i]) input_mismatch = 1;
      }
    } else {
      input_mismatch = 1;
    }
  }
  if (injected_syscall_status != 0u) return injected_syscall_status;
  for (u32 i = 0; i < 32u; ++i) hash_result[i] = expected_digest[i];
  return 0;
}

static int semantic_failure(const char *message) {
  fprintf(stderr, "SEMANTIC_ASSERT: %s\\n", message);
  return 91;
}

#define REQUIRE(test, message) do { if (!(test)) return semantic_failure(message); } while (0)

static void reset_mock(void) {
  syscall_calls = 0;
  injected_syscall_status = 0;
  input_mismatch = 0;
  syscall_must_not_run = 0;
  expected_input_len = 0;
  expected_digest = expected_digests[0];
  memset(expected_input, 0, sizeof(expected_input));
}

static void fill_poison(bend_u32 slots[64]) {
  for (u32 i = 0; i < 64u; ++i) slots[i] = 0xdeadbeefu;
}

static bend_u32 input_byte(u32 i, u32 length) {
  return (bend_u32)((i * 37u + length * 11u) & 255u);
}

static u32 expected_word(const u8 digest[32], u32 word) {
  u32 offset = word * 4u;
  return ((u32)digest[offset] << 24) | ((u32)digest[offset + 1u] << 16) |
    ((u32)digest[offset + 2u] << 8) | (u32)digest[offset + 3u];
}

static int check_digest(${resultType.cType} result, const u8 expected[32]) {
  if (result.tag != ${resultHashed.tag}u) return semantic_failure("short input did not produce Hashed");
  ${digestType.cType} digest = result.as.c${resultHashed.tag}.f0;
  if (digest.tag != ${digestVariant.tag}u) return semantic_failure("Digest256 constructor tag mismatch");
${identity.digest.fields.map((field, index) => `  if (digest.as.c${digestVariant.tag}.f${index} != expected_word(expected, ${index}u)) return semantic_failure("digest word ${index} is not big-endian");`).join('\n')}
  return 0;
}

static int compare_checked_reference(${messageType.cType} message, ${resultType.cType} actual) {
  ${resultType.cType} reference = sha256_short_checked_reference(message);
  if (reference.tag != actual.tag) return semantic_failure("specialized result tag differs from checked reference");
  if (actual.tag == ${resultHashed.tag}u) {
    ${digestType.cType} actual_digest = actual.as.c${resultHashed.tag}.f0;
    ${digestType.cType} reference_digest = reference.as.c${resultHashed.tag}.f0;
    if (actual_digest.tag != reference_digest.tag) return semantic_failure("Digest256 tag differs from checked reference");
${identity.digest.fields.map((field, index) => `    if (actual_digest.as.c${digestVariant.tag}.f${index} != reference_digest.as.c${digestVariant.tag}.f${index}) return semantic_failure("digest word ${index} differs from checked reference");`).join('\n')}
  }
  return 0;
}

static int run_valid(u32 length) {
  bend_u32 slots[64];
  fill_poison(slots);
  reset_mock();
  expected_input_len = length;
  expected_digest = expected_digests[length];
  for (u32 i = 0; i < length; ++i) {
    slots[i] = input_byte(i, length);
    expected_input[i] = (u8)slots[i];
  }
  ${messageType.cType} message = make_message((bend_u32)length, slots);
  ${resultType.cType} result = ${identity.export.cName}(message);
  REQUIRE(!input_mismatch, "hashv slice count, length, byte order, or contents mismatch");
  int digest_status = check_digest(result, expected_digest);
  if (digest_status != 0) return digest_status;
  int reference_status = compare_checked_reference(message, result);
  if (reference_status != 0) return reference_status;
  REQUIRE(syscall_calls == 1u, "valid message did not make exactly one hashv call");
  return 0;
}

static int run_edge_bytes(void) {
  bend_u32 slots[64];
  fill_poison(slots);
  reset_mock();
  slots[0] = 0u;
  slots[1] = 255u;
  expected_input_len = 2u;
  expected_input[0] = 0u;
  expected_input[1] = 255u;
  expected_digest = edge_digest;
  ${messageType.cType} message = make_message(2u, slots);
  ${resultType.cType} result = ${identity.export.cName}(message);
  REQUIRE(!input_mismatch && syscall_calls == 1u, "active byte values 0 and 255 were not marshalled exactly");
  int digest_status = check_digest(result, edge_digest);
  if (digest_status != 0) return digest_status;
  return compare_checked_reference(message, result);
}

static int run_rejected_length(bend_u32 length, const char *label) {
  bend_u32 slots[64];
  fill_poison(slots);
  for (u32 i = 0; i < 55u; ++i) slots[i] = input_byte(i, 55u);
  reset_mock();
  syscall_must_not_run = 1;
  ${messageType.cType} message = make_message(length, slots);
  ${resultType.cType} result = ${identity.export.cName}(message);
  if (syscall_calls != 0u) return semantic_failure("rejected length reached hashv before returning Rejected");
  if (result.tag != ${resultRejected.tag}u) return semantic_failure(label);
  return compare_checked_reference(message, result);
}

static int run_invalid_byte(int last) {
  bend_u32 slots[64];
  fill_poison(slots);
  reset_mock();
  syscall_must_not_run = 1;
  bend_u32 length = last ? 55u : 1u;
  for (u32 i = 0; i < length; ++i) slots[i] = input_byte(i, length);
  slots[last ? 54u : 0u] = 256u;
  ${messageType.cType} message = make_message(length, slots);
  ${resultType.cType} result = ${identity.export.cName}(message);
  if (syscall_calls != 0u) return semantic_failure("invalid active byte reached hashv");
  if (result.tag != ${resultRejected.tag}u) return semantic_failure("invalid active byte was not Rejected");
  return compare_checked_reference(message, result);
}

static int run_order_case(void) {
  bend_u32 slots[64];
  fill_poison(slots);
  reset_mock();
  slots[0] = 0x12u;
  slots[1] = 0xa5u;
  expected_input_len = 2u;
  expected_input[0] = 0x12u;
  expected_input[1] = 0xa5u;
  expected_digest = order_digest;
  ${messageType.cType} message = make_message(2u, slots);
  ${resultType.cType} result = ${identity.export.cName}(message);
  REQUIRE(!input_mismatch, "active slots were not marshalled in left-to-right order");
  REQUIRE(syscall_calls == 1u, "ordered message did not make exactly one hashv call");
  int digest_status = check_digest(result, expected_digest);
  if (digest_status != 0) return digest_status;
  return compare_checked_reference(message, result);
}

static int run_syscall_failure(void) {
  bend_u32 slots[64];
  fill_poison(slots);
  reset_mock();
  slots[0] = 7u;
  expected_input_len = 1u;
  expected_input[0] = 7u;
  expected_digest = expected_digests[1];
  injected_syscall_status = 17u;
  ${resultType.cType} result = ${identity.export.cName}(make_message(1u, slots));
  (void)result;
  return semantic_failure("nonzero syscall status returned a tagged result instead of failing execution");
}

int main(int argc, char **argv) {
  (void)&sha256_short_checked_reference;
  if (argc == 2 && strcmp(argv[1], "--length56") == 0) return run_rejected_length(56u, "length 56 was not Rejected");
  if (argc == 2 && strcmp(argv[1], "--length-max") == 0) return run_rejected_length(0xffffffffu, "U32 max length was not Rejected");
  if (argc == 2 && strcmp(argv[1], "--empty") == 0) return run_valid(0u);
  if (argc == 2 && strcmp(argv[1], "--length54") == 0) return run_valid(54u);
  if (argc == 2 && strcmp(argv[1], "--invalid-first") == 0) return run_invalid_byte(0);
  if (argc == 2 && strcmp(argv[1], "--invalid-last") == 0) return run_invalid_byte(1);
  if (argc == 2 && strcmp(argv[1], "--order") == 0) return run_order_case();
  if (argc == 2 && strcmp(argv[1], "--digest") == 0) return run_valid(0u);
  if (argc == 2 && strcmp(argv[1], "--syscall-failure") == 0) return run_syscall_failure();
  for (u32 length = 0; length <= 55u; ++length) {
    int status = run_valid(length);
    if (status != 0) return status;
  }
  if (run_edge_bytes() != 0) return 1;
  if (run_valid(55u) != 0) return 1;
  if (run_rejected_length(56u, "length 56 was not Rejected") != 0) return 1;
  if (run_rejected_length(0xffffffffu, "U32 max length was not Rejected") != 0) return 1;
  if (run_invalid_byte(0) != 0) return 1;
  if (run_invalid_byte(1) != 0) return 1;
  return 0;
}
`;

const compilerFlags = [
  '-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-Wpedantic', '-Wconversion',
  '-Wsign-conversion', '-Wstrict-prototypes', '-fno-omit-frame-pointer', '-fsanitize=address,undefined',
  '-fno-sanitize-recover=all',
];

function compileDefinition(label: string, definition: string, prelude = ''): string {
  const source = path.join(work, `${label}.c`);
  const binary = path.join(work, label);
  const inserted = `${prelude}${prelude ? '\n' : ''}${definition}`;
  fs.writeFileSync(source, replaceOnce(resultCode, '/* SHA256_SHORT_GENERATED_DEFINITION */', inserted, `${label} definition insertion`));
  const compiled = run(clang, [...compilerFlags, source, '-o', binary], `${label} host compile`);
  fs.writeFileSync(path.join(work, `${label}.compile.stdout.log`), compiled.stdout ?? '');
  fs.writeFileSync(path.join(work, `${label}.compile.stderr.log`), compiled.stderr ?? '');
  if (compiled.status !== 0) fail(`${label} host compile failure (not a semantic rejection), status=${compiled.status}:\n${processText(compiled)}`);
  return binary;
}

function definitionFromBody(generated: {definition: string; body: string}): string {
  const start = generated.definition.indexOf('static __attribute__((noinline))');
  const end = generated.definition.indexOf('{', start);
  assert.ok(start >= 0 && end > start, 'generated function signature exists');
  return generated.definition.slice(start, end + 1) + '\n' + generated.body + '\n}';
}

function expectCompileFailure(label: string, definition: string, prelude: string, diagnostic: RegExp): void {
  const source = path.join(work, `${label}.c`);
  const inserted = `${prelude}${prelude ? '\n' : ''}${definition}`;
  fs.writeFileSync(source, replaceOnce(resultCode, '/* SHA256_SHORT_GENERATED_DEFINITION */', inserted, `${label} definition insertion`));
  const negativeFlags = compilerFlags.filter(flag => flag !== '-Wconversion' && flag !== '-Wsign-conversion');
  const compiled = run(clang, [...negativeFlags, source, '-o', path.join(work, label)], `${label} host compile`);
  fs.writeFileSync(path.join(work, `${label}.compile.stdout.log`), compiled.stdout ?? '');
  fs.writeFileSync(path.join(work, `${label}.compile.stderr.log`), compiled.stderr ?? '');
  assert.notEqual(compiled.status, 0, `${label} must fail compilation`);
  assert.match(processText(compiled), diagnostic, `${label} must fail for the intended type assertion`);
}

{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, 'U32', type => { type.cType = 'sha256_test_narrow_u32_t'; });
  const narrow = generateSha256Short(changed, identity);
  assert.match(narrow.definition, /_Static_assert\(sizeof\(sha256_test_narrow_u32_t\)/,
    'generated definition asserts the concrete U32 C representation');
  assert.match(narrow.body, /_Static_assert\(sizeof\(sha256_test_narrow_u32_t\)/,
    'replacement body asserts the concrete U32 C representation');
  expectCompileFailure('mismatched-narrow-u32-c-type', narrow.definition,
    'typedef unsigned short sha256_test_narrow_u32_t;', /error: static assertion failed/);
  expectCompileFailure('body-mismatched-narrow-u32-c-type', definitionFromBody(narrow),
    'typedef unsigned short sha256_test_narrow_u32_t;', /error: static assertion failed/);
}
{
  const changed = structuredClone(emitted.schema);
  mutateType(changed, 'U32', type => { type.cType = 'sha256_test_signed_u32_t'; });
  const signed = generateSha256Short(changed, identity);
  expectCompileFailure('mismatched-signed-u32-c-type', signed.definition,
    'typedef int sha256_test_signed_u32_t;', /error: static assertion failed/);
  expectCompileFailure('body-mismatched-signed-u32-c-type', definitionFromBody(signed),
    'typedef int sha256_test_signed_u32_t;', /error: static assertion failed/);
}

function runExecutable(binary: string, args: string[], label: string): ProcessResult {
  const result = run(binary, args, label);
  fs.writeFileSync(path.join(work, `${label.replace(/[^A-Za-z0-9_-]/g, '_')}.stdout.log`), result.stdout ?? '');
  fs.writeFileSync(path.join(work, `${label.replace(/[^A-Za-z0-9_-]/g, '_')}.stderr.log`), result.stderr ?? '');
  return result;
}

const positiveBinary = compileDefinition('sha256-short-positive', generated.definition);
const positive = runExecutable(positiveBinary, [], 'positive-vectors');
expectProcessSuccess(positive, 'sanitized positive vectors, lengths 0..55 and edge/rejection cases');

const failure = runExecutable(positiveBinary, ['--syscall-failure'], 'injected-syscall-failure');
if (failure.error) fail(`injected syscall failure spawn failure: ${String(failure.error)}`);
if (failure.status !== null || failure.signal !== 'SIGTRAP') {
  fail(`nonzero sol_sha256 status did not terminate execution: status=${failure.status} signal=${failure.signal} ${processText(failure)}`);
}
if (/(?:Address|Leak|Memory|Thread|UndefinedBehavior)Sanitizer|runtime error:|SUMMARY:.*Sanitizer|ubsan:/i.test(processText(failure))) {
  fail(`injected syscall failure emitted sanitizer diagnostics instead of the intended trap: ${processText(failure)}`);
}

function replaceOnce(source: string, before: string, after: string, label: string): string {
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${label} mutation anchor exists`);
  assert.equal(source.indexOf(before, first + before.length), -1, `${label} mutation anchor is unique`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function expectMutationKilled(label: string, source: string, args: string[], diagnostic: RegExp): void {
  const binary = compileDefinition(`mutation-${label}`, source);
  const result = runExecutable(binary, args, `mutation-${label}-semantic`);
  assert.notEqual(result.status, 0, `${label} mutation must fail semantic test`);
  assert.match(result.stderr ?? '', diagnostic, `${label} mutation must report the semantic invariant it broke`);
}

expectMutationKilled('length-guard',
  replaceOnce(generated.definition, 'sha256_short_length > 55u', 'sha256_short_length > 56u', 'length guard'),
  ['--length56'], /SEMANTIC_ASSERT: rejected length reached hashv/);
expectMutationKilled('active-boundary',
  replaceOnce(generated.definition, 'sha256_short_length > 0u) { /* active slot 0 */',
    'sha256_short_length >= 0u) { /* active slot 0 */', 'active boundary'),
  ['--empty'], /SEMANTIC_ASSERT: short input did not produce Hashed/);
expectMutationKilled('last-active-boundary',
  replaceOnce(generated.definition, 'sha256_short_length > 54u) { /* active slot 54 */',
    'sha256_short_length >= 54u) { /* active slot 54 */', 'last active boundary'),
  ['--length54'], /SEMANTIC_ASSERT: short input did not produce Hashed/);
expectMutationKilled('byte-bound',
  replaceOnce(generated.definition, 'sha256_short_byte_0 > 255u', 'sha256_short_byte_0 > 256u', 'byte bound'),
  ['--invalid-first'], /SEMANTIC_ASSERT: invalid active byte reached hashv/);
{
  const path0 = generated.slotPaths[0];
  const path1 = generated.slotPaths[1];
  let swapped = replaceOnce(generated.definition, path0, '__SHA256_SHORT_PATH_SWAP__', 'first slot path');
  swapped = replaceOnce(swapped, path1, path0, 'second slot path');
  swapped = replaceOnce(swapped, '__SHA256_SHORT_PATH_SWAP__', path1, 'restore first slot path');
  expectMutationKilled('slot-order', swapped, ['--order'], /SEMANTIC_ASSERT: active slots were not marshalled in left-to-right order/);
}
expectMutationKilled('digest-endianness',
  replaceOnce(generated.definition, 'sha256_short_digest[0] << 24', 'sha256_short_digest[0] << 0', 'digest endian'),
  ['--digest'], /SEMANTIC_ASSERT: digest word 0 is not big-endian/);
expectMutationKilled('syscall-failure-branch',
  replaceOnce(generated.definition, '__builtin_trap();', ';', 'syscall failure branch'),
  ['--syscall-failure'], /SEMANTIC_ASSERT: nonzero syscall status returned a tagged result/);

let sbfShape: Record<string, unknown> | undefined;
if (process.env.SHA256_SHORT_SBF_SHAPE === '1') {
  const tools = process.env.SBF_TOOLS ?? path.join(os.homedir(), '.cache/solana/v1.53/platform-tools/llvm/bin');
  const sbfClang = path.join(tools, 'clang');
  const readelf = path.join(tools, 'llvm-readelf');
  if (!fs.existsSync(sbfClang) || !fs.existsSync(readelf)) fail(`pinned Anza shape tools are missing under ${tools}`);
  const sbfVersion = run(sbfClang, ['--version'], 'Anza Clang version');
  expectProcessSuccess(sbfVersion, 'Anza Clang version');
  if (!processText(sbfVersion).includes('20.1.7') || !processText(sbfVersion).toLowerCase().includes('anza')) {
    fail(`SBF shape check requires Anza Clang 20.1.7, got ${processText(sbfVersion).split('\n')[0]}`);
  }
  const sbfSource = path.join(work, 'sha256-short-sbf-shape.c');
  const sbfObject = path.join(work, 'sha256-short-sbf-shape.o');
  const sbfClangRealPath = fs.realpathSync(sbfClang);
  const sbfSourceText = `
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunused-function"
#define ${identity.export.cName} sha256_short_checked_reference
#include "${headerPath}"
#undef ${identity.export.cName}
#pragma clang diagnostic pop
#include "${runtimeHeader}"
${generated.definition}
${resultType.cType} (*sha256_short_keep_specialized)( ${messageType.cType} ) = ${identity.export.cName};
`;
  fs.writeFileSync(sbfSource, sbfSourceText);
  const sbfFlags = [
    '--target=sbf', '-mcpu=generic', '-O2', '-fPIC', '-ffreestanding', '-fno-builtin',
    '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
    '-Wframe-larger-than=4096', '-fstack-usage', '-ffunction-sections', '-fdata-sections',
  ];
  const sbfCompile = run(sbfClang, [...sbfFlags, '-c', sbfSource, '-o', sbfObject], 'Anza SBF shape compile');
  fs.writeFileSync(path.join(work, 'sbf-shape.compile.stdout.log'), sbfCompile.stdout ?? '');
  fs.writeFileSync(path.join(work, 'sbf-shape.compile.stderr.log'), sbfCompile.stderr ?? '');
  expectProcessSuccess(sbfCompile, 'Anza SBF shape compile');
  const symbols = run(readelf, ['-s', sbfObject], 'SBF object symbol inspection');
  expectProcessSuccess(symbols, 'SBF object symbol inspection');
  const undefinedSymbols = [...new Set(processText(symbols).split('\n')
    .filter(line => /\bUND\b/.test(line)).map(line => line.trim().split(/\s+/).at(-1)!).filter(name => name !== 'UND'))].sort();
  assert.deepEqual(undefinedSymbols, ['abort', 'sol_sha256'],
    'specialized object has only the SHA syscall and Clang trap imports');
  const stackPath = sbfObject.replace(/\.o$/, '.su');
  assert.ok(fs.existsSync(stackPath), 'Anza writes stack usage evidence');
  const stackReport = fs.readFileSync(stackPath, 'utf8');
  const stackRows = stackReport.trim().split('\n').map(line => line.split('\t'));
  const shaFrame = stackRows.find(row => row[0]?.includes(identity.export.cName));
  assert(shaFrame && /^\d+$/.test(shaFrame[1] ?? ''), 'Anza stack report contains the specialized function');
  const frameBytes = Number(shaFrame[1]);
  assert.ok(frameBytes < 4096, `specialized frame ${frameBytes} is below the 4096-byte bound`);
  sbfShape = { version: processText(sbfVersion).split('\n')[0], flags: sbfFlags, object: sbfObject,
    clangRealPath: sbfClangRealPath, clangSha256: hashFile(sbfClangRealPath),
    undefinedSymbols, stackReport: stackPath, specializedFrameBytes: frameBytes };
}

const actualCompilerFiles = ['compiler/sha256-short.ts', 'tests/sha256-short-lowering.ts', 'compiler/schema.ts'];
const sourceHashes = Object.fromEntries([...new Set([
  ...requiredSourceFiles,
  ...reviewedSourceFiles.filter(relative => fs.existsSync(path.join(sourceRoot, relative))),
  ...sourceProgram.files.map(file => path.relative(sourceRoot, file)),
])].sort().map(relative => [relative, hashFile(path.join(sourceRoot, relative))]));
const generatorHashes = Object.fromEntries(actualCompilerFiles.map(relative => [relative, hashFile(relative)]));
const evidence = {
  scope: 'host C marshalling conformance only; no SHA algorithm proof or SBF execution claim',
  sourceRoot,
  sourceHashes,
  generatorHashes,
  checkedProgramFiles: sourceProgram.files,
  compiler: { command: clang, realPath: compilerRealPath, sha256: hashFile(compilerRealPath),
    bunVersion: process.versions.bun, version: versionLine, flags: compilerFlags },
  emittedExport: emitted.schema.exports[0],
  slotPathCount: generated.slotPaths.length,
  positiveCases: 'all lengths 0..55 compared with the checked reference and Node SHA-256, varied active bytes, poisoned inactive slots including 55, 0/255 edges, length 56 and U32 max, invalid first/last active bytes, big-endian digest words',
  negativeSchemas: 19,
  u32CTypeCompileRejections: ['unsigned short alias rejected by generated exact-32-bit static assertion',
    'signed int alias rejected by generated unsigned static assertion'],
  checkedReferenceComparison: 'all successful vectors plus invalid lengths and invalid active bytes compare result tags and all eight digest words against sha256_short_checked_reference',
  killedMutations: ['length-guard', 'active-boundary', 'last-active-boundary', 'byte-bound', 'slot-order', 'digest-endianness', 'syscall-failure-branch'],
  injectedSyscallFailure: { status: failure.status, signal: failure.signal },
  sbfCompileOnlyShape: sbfShape ?? 'not requested; set SHA256_SHORT_SBF_SHAPE=1 with pinned Anza tools',
  workDirectory: work,
};
fs.writeFileSync(path.join(work, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
fs.writeFileSync(path.join(work, 'toolchain.log'), `${versionLine}\n${compilerRealPath}\n${compilerFlags.join(' ')}\n`);
console.log(JSON.stringify({ status: 'passed', evidencePath: path.join(work, 'evidence.json'), workDirectory: work }));
