import type { ExportSchema, FieldSchema, RuntimeSchema, TypeSchema, VariantSchema } from './schema.ts';

/** Caller-supplied identity for one reviewed packed-message binding. */
export type Sha256PackedIdentity = {
  export: { name: string; cName: string };
  u32Type: string;
  message: {
    type: string;
    constructor: string;
    lengthField: string;
    bytesField: string;
  };
  bytes: { type: string; constructor: string; wordsField: string; tailField: string };
  pair: {
    /** The exact root-to-leaf sequence of five binary nodes (32 words); its final three levels also hold the eight-word tail. */
    types: readonly [string, string, string, string, string];
    constructor: string;
    leftField: string;
    rightField: string;
  };
  result: {
    type: string;
    rejected: string;
    hashed: string;
    digestField: string;
  };
  digest: {
    type: string;
    constructor: string;
    fields: readonly [string, string, string, string, string, string, string, string];
  };
};

export type Sha256PackedGenerated = {
  /** C source for the selected export, using its emitted C signature. */
  definition: string;
  /** Body text without braces, for callers that replace an existing definition. */
  body: string;
  /** Checked-schema C expressions for the 40 packed input leaves, left to right. */
  slotPaths: readonly string[];
};

type NormalizedSchema = {
  types: Map<string, TypeSchema>;
  exports: ExportSchema[];
};

const C_KEYWORDS = new Set((
  'alignas alignof asm auto bool break case char const constexpr continue default do double else enum extern false float for goto if inline int long ' +
  'nullptr register restrict return short signed sizeof static static_assert struct switch thread_local true typedef typeof typeof_unqual union ' +
  'unsigned void volatile while _Alignas _Alignof _Atomic _BitInt _Bool _Complex _Decimal32 _Decimal64 _Decimal128 _Generic _Imaginary ' +
  '_Noreturn _Static_assert _Thread_local'
).split(/\s+/));

const RUNTIME_IDENTIFIERS = new Set([
  'main', 'abort', 'u8', 'u32', 'u64', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'uintptr_t', 'size_t',
  'ptrdiff_t', 'max_align_t', 'wchar_t', 'char16_t', 'char32_t', 'NULL', 'offsetof', 'UINT32_MAX', 'UINTPTR_MAX',
  'sol_sha256', 'sol_set_return_data', 'read_le', 'write_le', 'equal_key', 'read_account', 'Account',
  'BendSha256Slice', 'BendSha256Result', 'BendSha256Status', 'BEND_SHA256_MAX_SLICES',
  'BEND_SHA256_MAX_BYTES', 'BEND_SHA256_DIGEST_BYTES', 'BEND_SHA256_OK', 'BEND_SHA256_INVALID_ARGUMENT',
  'BEND_SHA256_TOO_MANY_SLICES', 'BEND_SHA256_TOO_MANY_BYTES', 'BEND_SHA256_RANGE_OVERFLOW',
  'BEND_SHA256_OUTPUT_ALIAS', 'BEND_SHA256_SYSCALL_FAILURE',
]);

function reservedIdentifier(name: string): boolean {
  return RUNTIME_IDENTIFIERS.has(name) || name.startsWith('sha256_packed_') ||
    name.startsWith('bend_sha256_') || name.startsWith('BendSha256') || name.startsWith('BEND_SHA256_');
}

function fail(message: string): never {
  throw new Error(`SHA-256 packed schema: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a nonempty string`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const name = string(value, label);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || C_KEYWORDS.has(name)) {
    fail(`${label} is not a safe C identifier: ${name}`);
  }
  if (reservedIdentifier(name)) fail(`${label} collides with a generated or SHA runtime identifier: ${name}`);
  return name;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function validateSchema(input: RuntimeSchema): NormalizedSchema {
  const root = record(input, 'runtime schema');
  expect(root.version === 1, 'runtime schema version must be 1');

  const rawTypes = array(root.types, 'runtime schema types');
  const rawExports = array(root.exports, 'runtime schema exports');
  const types = new Map<string, TypeSchema>();
  const typeCNames = new Set<string>();
  const makerNames = new Set<string>();

  for (const [typeIndex, raw] of rawTypes.entries()) {
    const item = record(raw, `type ${typeIndex}`);
    const name = string(item.name, `type ${typeIndex} name`);
    if (types.has(name)) fail(`duplicate type identity: ${name}`);
    const kind = item.kind;
    const cType = identifier(item.cType, `type ${name} C type`);

    if (kind === 'u32' || kind === 'bool') {
      if (item.max !== undefined && (kind !== 'u32' || !Number.isInteger(item.max) ||
          (item.max as number) < 0 || (item.max as number) > 0xffffffff)) {
        fail(`invalid integer bound on ${name}`);
      }
      typeCNames.add(cType); // Repeated primitive aliases such as U32/Bool are expected.
      types.set(name, { kind, name, cType, ...(item.max === undefined ? {} : { max: item.max as number }) });
      continue;
    }
    if (kind !== 'adt') fail(`unknown type kind for ${name}`);

    const rawVariants = array(item.variants, `type ${name} variants`);
    if (rawVariants.length === 0) fail(`empty ADT: ${name}`);
    const variants: VariantSchema[] = [];
    const variantNames = new Set<string>();
    for (const [variantIndex, rawVariant] of rawVariants.entries()) {
      const variant = record(rawVariant, `variant ${variantIndex} of ${name}`);
      const variantName = string(variant.name, `variant ${variantIndex} name of ${name}`);
      if (variantNames.has(variantName)) fail(`duplicate constructor identity in ${name}: ${variantName}`);
      variantNames.add(variantName);
      if (!Number.isSafeInteger(variant.tag) || variant.tag !== variantIndex || variant.tag < 0) {
        fail(`constructor order/tag mismatch in ${name}: ${variantName}`);
      }
      const cMaker = identifier(variant.cMaker, `constructor ${variantName} C maker`);
      if (makerNames.has(cMaker)) fail(`duplicate constructor C maker: ${cMaker}`);
      makerNames.add(cMaker);
      if (variant.sourceName !== undefined && typeof variant.sourceName !== 'string') {
        fail(`invalid source constructor identity: ${variantName}`);
      }

      const fields = array(variant.fields, `constructor ${variantName} fields`).map((rawField, fieldIndex) => {
        const field = record(rawField, `field ${fieldIndex} of ${variantName}`);
        return {
          name: string(field.name, `field ${fieldIndex} name of ${variantName}`),
          type: string(field.type, `field ${fieldIndex} type of ${variantName}`),
        } satisfies FieldSchema;
      });
      if (new Set(fields.map(field => field.name)).size !== fields.length) {
        fail(`duplicate field identity in constructor ${variantName}`);
      }
      variants.push({ name: variantName, tag: variant.tag as number, fields, cMaker,
        ...(variant.sourceName === undefined ? {} : { sourceName: variant.sourceName as string }) });
    }
    if (typeCNames.has(cType)) fail(`duplicate C type identifier: ${cType}`);
    typeCNames.add(cType);
    types.set(name, { kind: 'adt', name, cType, variants });
  }

  const exports: ExportSchema[] = [];
  const exportNames = new Set<string>();
  const exportCNames = new Set<string>();
  for (const [exportIndex, raw] of rawExports.entries()) {
    const item = record(raw, `export ${exportIndex}`);
    const name = string(item.name, `export ${exportIndex} name`);
    if (exportNames.has(name)) fail(`duplicate export identity: ${name}`);
    exportNames.add(name);
    const cName = identifier(item.cName, `export ${name} C name`);
    if (exportCNames.has(cName)) fail(`duplicate export C identifier: ${cName}`);
    exportCNames.add(cName);
    const args = array(item.args, `export ${name} arguments`).map((arg, i) => string(arg, `export ${name} argument ${i}`));
    const result = string(item.result, `export ${name} result`);
    exports.push({ name, cName, args, result });
  }

  const allOrdinaryCNames = new Set<string>(typeCNames);
  for (const name of [...makerNames, ...exportCNames]) {
    if (allOrdinaryCNames.has(name)) fail(`duplicate C ordinary identifier: ${name}`);
    allOrdinaryCNames.add(name);
  }

  for (const type of types.values()) {
    if (type.kind !== 'adt') continue;
    for (const variant of type.variants) {
      for (const field of variant.fields) {
        if (!types.has(field.type)) fail(`unknown field type ${field.type} in ${variant.name}.${field.name}`);
      }
    }
  }
  for (const item of exports) {
    for (const name of [...item.args, item.result]) if (!types.has(name)) fail(`unknown export type ${name} in ${item.name}`);
  }

  const busy = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string) => {
    if (done.has(name)) return;
    if (busy.has(name)) fail(`recursive schema type: ${name}`);
    busy.add(name);
    const type = types.get(name)!;
    if (type.kind === 'adt') for (const variant of type.variants) {
      for (const field of variant.fields) visit(field.type);
    }
    busy.delete(name);
    done.add(name);
  };
  for (const name of types.keys()) visit(name);
  return { types, exports };
}

function identityString(value: unknown, label: string): string {
  return string(value, `identity ${label}`);
}

function adtType(schema: NormalizedSchema, name: string, label: string): Extract<TypeSchema, { kind: 'adt' }> {
  const type = schema.types.get(name);
  if (!type) fail(`identity ${label} type is absent: ${name}`);
  if (type.kind !== 'adt') fail(`identity ${label} must name an ADT: ${name}`);
  return type;
}

function variantIdentity(variant: VariantSchema): string {
  return variant.sourceName ?? variant.name;
}

function onlyVariant(type: Extract<TypeSchema, { kind: 'adt' }>, expectedConstructor: string, label: string): VariantSchema {
  if (type.variants.length !== 1) fail(`${label} must have exactly one constructor`);
  const variant = type.variants[0];
  if (variant.tag !== 0 || variantIdentity(variant) !== expectedConstructor) {
    fail(`${label} constructor identity/tag mismatch: expected ${expectedConstructor} at tag 0`);
  }
  return variant;
}

function exactFields(variant: VariantSchema, expected: readonly { name: string; type: string }[], label: string): void {
  if (variant.fields.length !== expected.length) fail(`${label} field count mismatch`);
  for (let i = 0; i < expected.length; i++) {
    if (variant.fields[i].name !== expected[i].name || variant.fields[i].type !== expected[i].type) {
      fail(`${label} field ${i} identity/order/type mismatch`);
    }
  }
}

function fieldPath(variant: VariantSchema, fieldIndex: number): string {
  return `.as.c${variant.tag}.f${fieldIndex}`;
}

/**
 * Generate a replacement C definition for an explicitly identified checked
 * binding. This validates representation only; it does not authenticate the
 * checked source body or its transitive closure.
 */
export function generateSha256Packed(
  input: RuntimeSchema,
  identity: Sha256PackedIdentity,
): Sha256PackedGenerated {
  const schema = validateSchema(input);
  const exportName = identityString(identity?.export?.name, 'export name');
  const exportCName = identifier(identity?.export?.cName, 'identity export C name');
  const u32Name = identityString(identity?.u32Type, 'U32 type');
  const messageName = identityString(identity?.message?.type, 'Message type');
  const messageConstructor = identityString(identity?.message?.constructor, 'Message constructor');
  const lengthField = identityString(identity?.message?.lengthField, 'Message length field');
  const bytesField = identityString(identity?.message?.bytesField, 'Message bytes field');
  const bytesName = identityString(identity?.bytes?.type, 'Bytes160 type');
  const bytesConstructor = identityString(identity?.bytes?.constructor, 'Bytes160 constructor');
  const wordsField = identityString(identity?.bytes?.wordsField, 'Bytes160 words field');
  const tailField = identityString(identity?.bytes?.tailField, 'Bytes160 tail field');
  const pairTypes = identity?.pair?.types;
  if (!Array.isArray(pairTypes) || pairTypes.length !== 5) fail('identity pair types must name five nodes root to leaf');
  pairTypes.forEach((name, i) => identityString(name, `pair type ${i}`));
  const pairConstructor = identityString(identity?.pair?.constructor, 'pair constructor');
  const leftField = identityString(identity?.pair?.leftField, 'pair left field');
  const rightField = identityString(identity?.pair?.rightField, 'pair right field');
  const resultName = identityString(identity?.result?.type, 'HashResult type');
  const rejectedName = identityString(identity?.result?.rejected, 'Rejected constructor');
  const hashedName = identityString(identity?.result?.hashed, 'Hashed constructor');
  const resultDigestField = identityString(identity?.result?.digestField, 'Hashed digest field');
  const digestName = identityString(identity?.digest?.type, 'Digest256 type');
  const digestConstructor = identityString(identity?.digest?.constructor, 'Digest256 constructor');
  const digestFields = identity?.digest?.fields;
  if (!Array.isArray(digestFields) || digestFields.length !== 8) fail('identity digest fields must name exactly eight words');
  digestFields.forEach((name, i) => identityString(name, `digest field ${i}`));

  const u32 = schema.types.get(u32Name);
  if (!u32 || u32.kind !== 'u32') fail(`identity U32 type must be a u32 primitive: ${u32Name}`);
  if (u32.max !== undefined) fail(`identity U32 type must be unbounded: ${u32Name}`);

  const targetExports = schema.exports.filter(item => item.name === exportName);
  if (targetExports.length !== 1) fail(`expected exactly one identified export: ${exportName}`);
  const target = targetExports[0];
  if (target.cName !== exportCName) fail(`export C identity mismatch for ${exportName}`);
  if (target.args.length !== 1 || target.args[0] !== messageName) {
    fail(`${exportName} must have exactly one ${messageName} argument`);
  }
  if (target.result !== resultName) fail(`${exportName} result identity mismatch`);

  const messageType = adtType(schema, messageName, 'Message');
  const messageVariant = onlyVariant(messageType, messageConstructor, 'Message');
  exactFields(messageVariant, [
    { name: lengthField, type: u32Name },
    { name: bytesField, type: bytesName },
  ], 'Message');

  const bytesType = adtType(schema, bytesName, 'Bytes160');
  const bytesVariant = onlyVariant(bytesType, bytesConstructor, 'Bytes160');
  exactFields(bytesVariant, [{ name: wordsField, type: pairTypes[0] }, { name: tailField, type: pairTypes[2] }], 'Bytes160');

  const pairVariants: VariantSchema[] = [];
  for (let level = 0; level < 5; level++) {
    const pairType = adtType(schema, pairTypes[level], `binary pair level ${level}`);
    const pairVariant = onlyVariant(pairType, pairConstructor, `binary pair level ${level}`);
    if (pairVariant.name !== pairTypes[level]) {
      fail(`binary pair level ${level} specialized constructor identity mismatch`);
    }
    const childType = level === 4 ? u32Name : pairTypes[level + 1];
    exactFields(pairVariant, [
      { name: leftField, type: childType },
      { name: rightField, type: childType },
    ], `binary pair level ${level}`);
    pairVariants.push(pairVariant);
  }

  const resultType = adtType(schema, resultName, 'HashResult');
  if (resultType.variants.length !== 2) fail('HashResult must have exactly Rejected and Hashed constructors');
  const rejected = resultType.variants[0];
  const hashed = resultType.variants[1];
  if (rejected.tag !== 0 || variantIdentity(rejected) !== rejectedName || rejected.fields.length !== 0) {
    fail('HashResult Rejected constructor identity/order/tag/fields mismatch');
  }
  if (hashed.tag !== 1 || variantIdentity(hashed) !== hashedName) {
    fail('HashResult Hashed constructor identity/order/tag mismatch');
  }
  exactFields(hashed, [{ name: resultDigestField, type: digestName }], 'HashResult Hashed');

  const digestType = adtType(schema, digestName, 'Digest256');
  const digestVariant = onlyVariant(digestType, digestConstructor, 'Digest256');
  exactFields(digestVariant, digestFields.map(name => ({ name, type: u32Name })), 'Digest256');

  const messageLengthIndex = messageVariant.fields.findIndex(field => field.name === lengthField);
  const messageBytesIndex = messageVariant.fields.findIndex(field => field.name === bytesField);
  const wordsIndex = bytesVariant.fields.findIndex(field => field.name === wordsField);
  const inputName = 'sha256_packed_message';
  const lengthPath = `${inputName}${fieldPath(messageVariant, messageLengthIndex)}`;
  const wordsPath = `${inputName}${fieldPath(messageVariant, messageBytesIndex)}${fieldPath(bytesVariant, wordsIndex)}`;

  const expand = (root: string, levels: VariantSchema[]) => {
    let paths = [root];
    for (const variant of levels) paths = paths.flatMap(path => [
      `${path}${fieldPath(variant, 0)}`, `${path}${fieldPath(variant, 1)}`,
    ]);
    return paths;
  };
  const tailIndex = bytesVariant.fields.findIndex(field => field.name === tailField);
  const tailPath = `${inputName}${fieldPath(messageVariant, messageBytesIndex)}${fieldPath(bytesVariant, tailIndex)}`;
  const leafPaths = [...expand(wordsPath, pairVariants), ...expand(tailPath, pairVariants.slice(2))];
  if (leafPaths.length !== 40) fail(`packed message layout must expose 40 U32 words, found ${leafPaths.length}`);

  const byteLines: string[] = [];
  for (let i = 0; i < 151; i++) byteLines.push(
    `if (sha256_packed_length > ${i}u) { /* active byte ${i} */`,
    `  sha256_packed_compact[${i}] = (u8)((${leafPaths[Math.floor(i / 4)]} >> ${(i % 4) * 8}u) & 255u);`,
    '}',
  );
  const digestWords = Array.from({ length: 8 }, (_, word) => {
    const bytes = Array.from({ length: 4 }, (_, part) => {
      const index = word * 4 + part;
      const shift = 24 - part * 8;
      return `((uint32_t)sha256_packed_digest[${index}] << ${shift})`;
    });
    return `(${u32.cType})(${bytes.join(' | ')})`;
  });

  const bodyLines = [
    `_Static_assert(sizeof(${u32.cType}) == sizeof(uint32_t) && (${u32.cType})-1 > (${u32.cType})0 && (${u32.cType})UINT32_MAX == UINT32_MAX, "SHA-256 packed U32 C type must be unsigned and exactly 32 bits");`,
    `const ${u32.cType} sha256_packed_length = ${lengthPath};`,
    'if (sha256_packed_length > 151u) {',
    `  return ${rejected.cMaker}();`,
    '}',
    'u8 sha256_packed_compact[151] = {0};',
    ...byteLines,
    'BendSha256Slice sha256_packed_slice = {',
    '  .data = sha256_packed_compact,',
    '  .len = (u64)sha256_packed_length,',
    '};',
    'u8 sha256_packed_digest[BEND_SHA256_DIGEST_BYTES] = {0};',
    'BendSha256Result sha256_packed_status = bend_sha256_hashv(&sha256_packed_slice, 1u, sha256_packed_digest);',
    'if (sha256_packed_status.status != BEND_SHA256_OK) {',
    '  __builtin_trap();',
    '}',
    `return ${hashed.cMaker}(${digestVariant.cMaker}(${digestWords.join(', ')}));`,
  ];
  const body = bodyLines.map(line => `  ${line}`).join('\n');
  const definition = `static __attribute__((noinline)) ${resultType.cType} ${target.cName}(${messageType.cType} ${inputName}) {\n${body}\n}`;
  return { definition, body, slotPaths: leafPaths };
}
