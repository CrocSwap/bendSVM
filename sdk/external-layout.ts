export type ExternalEndian = 'little' | 'big';
export type ExternalScalarType = 'u8' | 'u16' | 'u32' | 'u64';
export type ExternalFieldType = ExternalScalarType | 'key32' | 'bytes';

export interface ExternalFieldDescriptor {
  readonly name: string;
  readonly offset: number;
  readonly type: ExternalFieldType;
  readonly endian?: ExternalEndian;
  readonly length?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

export type ExternalSizeTerm =
  | {readonly kind: 'multiply'; readonly field: string; readonly by: number}
  | {readonly kind: 'multiply'; readonly field: string; readonly byField: string}
  | {readonly kind: 'ceil_divide'; readonly field: string; readonly by: number};

/** A deliberately flat checked expression: base plus a bounded list of terms. */
export interface ExternalSizeFormula {
  readonly base: number;
  readonly terms: readonly ExternalSizeTerm[];
}

export interface ExternalSpanWindowDescriptor {
  readonly name: string;
  readonly offsetField: string;
  readonly lengthField: string;
  readonly maxLength: number;
}

export interface ExternalFormulaWindowDescriptor {
  readonly kind: 'bytes';
  readonly name: string;
  readonly offset: ExternalSizeFormula;
  readonly length: ExternalSizeFormula;
  readonly maxLength: number;
  /** Return the bytes present in a prefix-grown allocation, including an empty prefix. */
  readonly allowPrefix?: boolean;
}

export interface ExternalRecordWindowDescriptor {
  readonly kind: 'records';
  readonly name: string;
  readonly offset: number;
  readonly countField: string;
  readonly recordSize: number | {readonly field: string};
  readonly maxCount: number;
  readonly maxRecordSize?: number;
  /** Return only whole records present in a prefix-grown allocation. */
  readonly allowPrefix?: boolean;
}

export type ExternalWindowDescriptor = ExternalSpanWindowDescriptor | ExternalFormulaWindowDescriptor | ExternalRecordWindowDescriptor;

export interface ExternalLayoutDescriptor {
  readonly name: string;
  readonly fixedSize: number;
  readonly allocation: {readonly kind: 'exact'} | {readonly kind: 'prefix'; readonly maxLength: number};
  readonly fields: readonly ExternalFieldDescriptor[];
  readonly logicalSize?: ExternalSizeFormula;
  readonly checks?: {
    readonly magic?: {readonly field: string; readonly bytes: readonly number[]};
    readonly version?: {readonly field: string; readonly equals: number};
    readonly reservedZero?: readonly string[];
  };
  readonly windows?: readonly ExternalWindowDescriptor[];
}

export interface ValidatedExternalLayout extends ExternalLayoutDescriptor {
  readonly fields: readonly ExternalFieldDescriptor[];
  readonly windows: readonly ExternalWindowDescriptor[];
}

export type ExternalFieldValue = number | bigint | Uint8Array;
export interface ExternalRecordWindowView {
  readonly data: Uint8Array;
  readonly recordSize: number;
  readonly count: number;
  readonly logicalCount: number;
}
export interface ExternalWindowInfo {
  readonly offset: number;
  readonly logicalLength: number;
  readonly accessibleLength: number;
}
export interface ExternalLayoutView {
  readonly layout: string;
  /** Physically accessible bytes in the account data supplied by the caller. */
  readonly byteLength: number;
  /** Full descriptor-computed size; may exceed byteLength for prefix-grown layouts. */
  readonly logicalSize: number;
  readonly fields: Readonly<Record<string, ExternalFieldValue>>;
  /** Borrowed slices of input. Keep input alive and unchanged while reading them. */
  readonly windows: Readonly<Record<string, Uint8Array>>;
  readonly windowInfo: Readonly<Record<string, ExternalWindowInfo>>;
  readonly records: Readonly<Record<string, ExternalRecordWindowView>>;
}

export const EXTERNAL_MAX_COPIED_BYTES = 1536;
export const EXTERNAL_MAX_ACCOUNT_BYTES = 10 * 1024 * 1024;
export const EXTERNAL_MAX_FIELDS = 64;
export const EXTERNAL_MAX_WINDOWS = 16;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

function fail(message: string): never { throw new TypeError(`external layout: ${message}`); }
function record(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail(`${label} has an unknown property ${String(key)}`);
    if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) fail(`${label}.${key} must not be an accessor`);
  }
}
function dense(value: readonly unknown[], label: string): void {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail(`${label} must not contain holes`);
    if (!('value' in Object.getOwnPropertyDescriptor(value, String(index))!)) fail(`${label} must not contain accessors`);
  }
}
function safeNonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative safe integer`);
  return value;
}
function validName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value)) fail(`${label} must be a lowercase C identifier`);
  return value;
}
function scalar(type: ExternalFieldType): type is ExternalScalarType {
  return type === 'u8' || type === 'u16' || type === 'u32' || type === 'u64';
}
function fieldSize(field: ExternalFieldDescriptor): number {
  switch (field.type) {
    case 'u8': return 1;
    case 'u16': return 2;
    case 'u32': return 4;
    case 'u64': return 8;
    case 'key32': return 32;
    case 'bytes': return field.length!;
  }
}
function maxScalar(type: ExternalScalarType): bigint {
  return type === 'u8' ? 0xffn : type === 'u16' ? 0xffffn : type === 'u32' ? 0xffff_ffffn : MAX_U64;
}
function normalizeFormula(
  raw: unknown,
  label: string,
  fieldMap: ReadonlyMap<string, ExternalFieldDescriptor>,
  minimumBase = 0,
): ExternalSizeFormula {
  record(raw, ['base', 'terms'], label);
  const base = safeNonnegative((raw as ExternalSizeFormula).base, `${label}.base`);
  if (base < minimumBase || base > EXTERNAL_MAX_ACCOUNT_BYTES) fail(`${label}.base is outside the bounded account size`);
  const rawTerms = (raw as ExternalSizeFormula).terms;
  if (!Array.isArray(rawTerms) || rawTerms.length > 8) fail(`${label}.terms must contain 0..8 entries`);
  dense(rawTerms, `${label}.terms`);
  const terms = rawTerms.map((term, index): ExternalSizeTerm => {
    const itemLabel = `${label}.terms[${index}]`;
    record(term, ['kind', 'field', 'by', 'byField'], itemLabel);
    const rawKind = (term as {kind?: unknown}).kind;
    if (rawKind === 'multiply') record(term, ['kind', 'field', 'by', 'byField'], itemLabel);
    else if (rawKind === 'ceil_divide') record(term, ['kind', 'field', 'by'], itemLabel);
    else fail(`${itemLabel}.kind must be multiply or ceil_divide`);
    const fieldName = validName((term as {field?: unknown}).field, `${itemLabel}.field`);
    const field = fieldMap.get(fieldName);
    if (!field || !scalar(field.type)) fail(`${itemLabel} references missing or nonscalar field ${fieldName}`);
    if (rawKind === 'multiply') {
      const by = (term as {by?: unknown}).by;
      const byFieldRaw = (term as {byField?: unknown}).byField;
      const hasBy = Object.hasOwn(term, 'by');
      const hasByField = Object.hasOwn(term, 'byField');
      if (hasBy === hasByField) fail(`${itemLabel} multiply requires exactly one of by or byField`);
      if (by !== undefined) {
        const multiplier = safeNonnegative(by, `${itemLabel}.by`);
        if (multiplier === 0) fail(`${itemLabel}.by must be positive`);
        return Object.freeze({kind: 'multiply' as const, field: fieldName, by: multiplier});
      }
      const byField = validName(byFieldRaw, `${itemLabel}.byField`);
      const other = fieldMap.get(byField);
      if (!other || !scalar(other.type)) fail(`${itemLabel} references missing or nonscalar field ${byField}`);
      return Object.freeze({kind: 'multiply' as const, field: fieldName, byField});
    }
    const divisor = safeNonnegative((term as {by?: unknown}).by, `${itemLabel}.by`);
    if (divisor === 0) fail(`${itemLabel}.by must be positive`);
    return Object.freeze({kind: 'ceil_divide' as const, field: fieldName, by: divisor});
  });
  return Object.freeze({base, terms: Object.freeze(terms)});
}

export function validateExternalLayout(input: ExternalLayoutDescriptor): ValidatedExternalLayout {
  record(input, ['name', 'fixedSize', 'allocation', 'fields', 'logicalSize', 'checks', 'windows'], 'descriptor');
  const name = validName(input.name, 'name');
  const fixedSize = safeNonnegative(input.fixedSize, 'fixedSize');
  if (fixedSize === 0 || fixedSize > EXTERNAL_MAX_ACCOUNT_BYTES) fail(`fixedSize must be 1..${EXTERNAL_MAX_ACCOUNT_BYTES}`);
  record(input.allocation, ['kind', 'maxLength'], 'allocation');
  let allocation: ValidatedExternalLayout['allocation'];
  if (input.allocation.kind === 'exact') {
    if (Object.hasOwn(input.allocation, 'maxLength')) fail('exact allocation must not specify maxLength');
    allocation = Object.freeze({kind: 'exact' as const});
  } else if (input.allocation.kind === 'prefix') {
    const maxLength = safeNonnegative(input.allocation.maxLength, 'allocation.maxLength');
    if (maxLength < fixedSize || maxLength > EXTERNAL_MAX_ACCOUNT_BYTES) fail('allocation.maxLength is outside the bounded account size');
    allocation = Object.freeze({kind: 'prefix' as const, maxLength});
  } else fail('allocation.kind must be exact or prefix');

  if (!Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > EXTERNAL_MAX_FIELDS) fail(`fields must contain 1..${EXTERNAL_MAX_FIELDS} entries`);
  dense(input.fields, 'fields');
  const seen = new Set<string>();
  const fields = input.fields.map((raw, index): ExternalFieldDescriptor => {
    record(raw, ['name', 'offset', 'type', 'endian', 'length', 'minimum', 'maximum'], `fields[${index}]`);
    const fieldName = validName(raw.name, `fields[${index}].name`);
    if (seen.has(fieldName)) fail(`duplicate field name ${fieldName}`);
    seen.add(fieldName);
    const offset = safeNonnegative(raw.offset, `field ${fieldName}.offset`);
    const type = raw.type;
    if (type !== 'u8' && type !== 'u16' && type !== 'u32' && type !== 'u64' && type !== 'key32' && type !== 'bytes') fail(`field ${fieldName} has an unsupported type`);
    let endian: ExternalEndian | undefined;
    let length: number | undefined;
    let minimum: number | undefined;
    let maximum: number | undefined;
    if (scalar(type)) {
      if (type === 'u8') {
        if (Object.hasOwn(raw, 'endian')) fail(`u8 field ${fieldName} must not specify endian`);
      } else {
        if (raw.endian !== 'little' && raw.endian !== 'big') fail(`field ${fieldName} requires explicit little or big endian`);
        endian = raw.endian;
      }
      if (Object.hasOwn(raw, 'length')) fail(`scalar field ${fieldName} must not specify length`);
      if (Object.hasOwn(raw, 'minimum')) minimum = safeNonnegative(raw.minimum, `field ${fieldName}.minimum`);
      if (Object.hasOwn(raw, 'maximum')) maximum = safeNonnegative(raw.maximum, `field ${fieldName}.maximum`);
      if (minimum !== undefined && BigInt(minimum) > maxScalar(type)) fail(`field ${fieldName}.minimum does not fit ${type}`);
      if (maximum !== undefined && BigInt(maximum) > maxScalar(type)) fail(`field ${fieldName}.maximum does not fit ${type}`);
      if (minimum !== undefined && maximum !== undefined && minimum > maximum) fail(`field ${fieldName}.minimum exceeds maximum`);
    } else {
      if (Object.hasOwn(raw, 'endian')) fail(`byte field ${fieldName} must not specify endian`);
      if (Object.hasOwn(raw, 'minimum') || Object.hasOwn(raw, 'maximum')) fail(`byte field ${fieldName} must not specify a numeric range`);
      if (type === 'key32') {
        if (Object.hasOwn(raw, 'length') && raw.length !== 32) fail(`key32 field ${fieldName} has fixed length 32`);
        length = 32;
      } else {
        length = safeNonnegative(raw.length, `field ${fieldName}.length`);
        if (length === 0 || length > EXTERNAL_MAX_COPIED_BYTES) fail(`byte field ${fieldName}.length must be 1..${EXTERNAL_MAX_COPIED_BYTES}`);
      }
    }
    const field: ExternalFieldDescriptor = Object.freeze({name: fieldName, offset, type, ...(endian ? {endian} : {}), ...((type === 'bytes' || type === 'key32') ? {length} : {}), ...(minimum !== undefined ? {minimum} : {}), ...(maximum !== undefined ? {maximum} : {})});
    const size = fieldSize(field);
    if (!Number.isSafeInteger(offset + size) || offset + size > fixedSize) fail(`field ${fieldName} is outside fixedSize`);
    return field;
  }).sort((a, b) => a.offset - b.offset || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let priorEnd = -1;
  let copiedBound = 0;
  for (const field of fields) {
    if (field.offset < priorEnd) fail(`field ${field.name} overlaps another fixed field`);
    priorEnd = field.offset + fieldSize(field);
    if (field.type === 'bytes' || field.type === 'key32') copiedBound += fieldSize(field);
  }
  if (copiedBound > EXTERNAL_MAX_COPIED_BYTES) fail(`bounded byte copies exceed ${EXTERNAL_MAX_COPIED_BYTES} bytes`);

  const fieldMap = new Map(fields.map(field => [field.name, field]));
  const logicalSize = Object.hasOwn(input, 'logicalSize') ? normalizeFormula(input.logicalSize, 'logicalSize', fieldMap, fixedSize) : undefined;
  if (Object.hasOwn(input, 'checks')) record(input.checks, ['magic', 'version', 'reservedZero'], 'checks');
  const rawChecks = input.checks ?? {};
  for (const name of ['magic', 'version', 'reservedZero']) {
    if (Object.hasOwn(rawChecks, name) && (rawChecks as Record<string, unknown>)[name] === undefined) fail(`checks.${name} must not be undefined`);
  }
  let magic: {readonly field: string; readonly bytes: readonly number[]} | undefined;
  if (rawChecks.magic !== undefined) {
    record(rawChecks.magic, ['field', 'bytes'], 'checks.magic');
    const fieldName = validName(rawChecks.magic.field, 'checks.magic.field');
    const field = fieldMap.get(fieldName);
    if (!field) fail(`checks.magic references missing field ${fieldName}`);
    if (field.type !== 'bytes' && field.type !== 'key32') fail('checks.magic field must be bytes or key32');
    if (!Array.isArray(rawChecks.magic.bytes) || rawChecks.magic.bytes.length !== fieldSize(field)) fail('checks.magic bytes must match the magic field width');
    dense(rawChecks.magic.bytes, 'checks.magic.bytes');
    const bytes = rawChecks.magic.bytes.map((byte, index) => {
      const n = safeNonnegative(byte, `checks.magic.bytes[${index}]`);
      if (n > 255) fail('magic byte must be between 0 and 255');
      return n;
    });
    magic = Object.freeze({field: fieldName, bytes: Object.freeze(bytes)});
  }
  let version: {readonly field: string; readonly equals: number} | undefined;
  if (rawChecks.version !== undefined) {
    record(rawChecks.version, ['field', 'equals'], 'checks.version');
    const fieldName = validName(rawChecks.version.field, 'checks.version.field');
    const field = fieldMap.get(fieldName);
    if (!field) fail(`checks.version references missing field ${fieldName}`);
    if (!scalar(field.type)) fail('checks.version field must be an integer scalar');
    const equals = safeNonnegative(rawChecks.version.equals, 'checks.version.equals');
    if (BigInt(equals) > maxScalar(field.type)) fail(`checks.version value does not fit ${field.type}`);
    version = Object.freeze({field: fieldName, equals});
  }
  const rawReservedZero = rawChecks.reservedZero === undefined ? [] : rawChecks.reservedZero;
  if (!Array.isArray(rawReservedZero)) fail('checks.reservedZero must be an array');
  dense(rawReservedZero, 'checks.reservedZero');
  const reservedZero = rawReservedZero.map((value, index) => {
    const fieldName = validName(value, `checks.reservedZero[${index}]`);
    const field = fieldMap.get(fieldName);
    if (!field) fail(`checks.reservedZero references missing field ${fieldName}`);
    if (field.type !== 'bytes' && field.type !== 'key32') fail(`reserved field ${fieldName} must be bytes`);
    return fieldName;
  });
  if (new Set(reservedZero).size !== reservedZero.length) fail('checks.reservedZero contains duplicate fields');
  if (magic && reservedZero.includes(magic.field)) fail(`magic field ${magic.field} cannot also be reserved-zero`);
  reservedZero.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const checks = Object.freeze({...(magic ? {magic} : {}), ...(version ? {version} : {}), ...(reservedZero.length ? {reservedZero: Object.freeze(reservedZero)} : {})});

  if (Object.hasOwn(input, 'windows') && input.windows === undefined) fail('windows must not be undefined');
  const rawWindows = input.windows === undefined ? [] : input.windows;
  if (!Array.isArray(rawWindows) || rawWindows.length > EXTERNAL_MAX_WINDOWS) fail(`windows must contain 0..${EXTERNAL_MAX_WINDOWS} entries`);
  dense(rawWindows, 'windows');
  const windowNames = new Set<string>();
  const windowPairs = new Set<string>();
  let windowBound = 0;
  const windows = rawWindows.map((raw, index): ExternalWindowDescriptor => {
    record(raw, ['kind', 'name', 'offsetField', 'lengthField', 'maxLength', 'offset', 'length', 'countField', 'recordSize', 'maxCount', 'maxRecordSize', 'allowPrefix'], `windows[${index}]`);
    const windowName = validName((raw as {name?: unknown}).name, `windows[${index}].name`);
    if (seen.has(windowName) || windowNames.has(windowName)) fail(`ambiguous field/window name ${windowName}`);
    windowNames.add(windowName);
    if ((raw as {kind?: unknown}).kind === 'records') {
      record(raw, ['kind', 'name', 'offset', 'countField', 'recordSize', 'maxCount', 'maxRecordSize', 'allowPrefix'], `windows[${index}]`);
      const offset = safeNonnegative((raw as ExternalRecordWindowDescriptor).offset, `window ${windowName}.offset`);
      if (offset < fixedSize) fail(`record window ${windowName} starts inside the fixed header`);
      const countField = validName((raw as ExternalRecordWindowDescriptor).countField, `window ${windowName}.countField`);
      const countDescriptor = fieldMap.get(countField);
      if (!countDescriptor || !scalar(countDescriptor.type)) fail(`record window ${windowName} count must reference an integer field`);
      const maxCount = safeNonnegative((raw as ExternalRecordWindowDescriptor).maxCount, `window ${windowName}.maxCount`);
      if (maxCount === 0 || maxCount > EXTERNAL_MAX_ACCOUNT_BYTES) fail(`window ${windowName}.maxCount must be 1..${EXTERNAL_MAX_ACCOUNT_BYTES}`);
      if (countDescriptor.maximum === undefined || countDescriptor.maximum > maxCount) fail(`record window ${windowName} count field must declare maximum no greater than maxCount`);
      const rawRecordSize = (raw as ExternalRecordWindowDescriptor).recordSize;
      let recordSize: number | {readonly field: string};
      let maxRecordSize: number;
      if (typeof rawRecordSize === 'number') {
        recordSize = safeNonnegative(rawRecordSize, `window ${windowName}.recordSize`);
        if (recordSize === 0 || Object.hasOwn(raw, 'maxRecordSize')) fail(`window ${windowName} has invalid static record size`);
        maxRecordSize = recordSize;
      } else {
        record(rawRecordSize, ['field'], `window ${windowName}.recordSize`);
        const field = validName(rawRecordSize.field, `window ${windowName}.recordSize.field`);
        const fieldDescriptor = fieldMap.get(field);
        if (!fieldDescriptor || !scalar(fieldDescriptor.type)) fail(`record window ${windowName} width must reference an integer field`);
        maxRecordSize = safeNonnegative((raw as ExternalRecordWindowDescriptor).maxRecordSize, `window ${windowName}.maxRecordSize`);
        if (maxRecordSize === 0 || maxRecordSize > EXTERNAL_MAX_ACCOUNT_BYTES || fieldDescriptor.maximum === undefined || fieldDescriptor.maximum > maxRecordSize || fieldDescriptor.minimum === undefined || fieldDescriptor.minimum === 0) fail(`record window ${windowName} width field must have a positive bounded range`);
        recordSize = Object.freeze({field});
      }
      const allowPrefix = (raw as ExternalRecordWindowDescriptor).allowPrefix;
      if (Object.hasOwn(raw, 'allowPrefix') && typeof allowPrefix !== 'boolean') fail(`window ${windowName}.allowPrefix must be boolean`);
      if (allowPrefix && allocation.kind !== 'prefix') fail(`record window ${windowName} prefix access requires prefix allocation`);
      const maximumLength = maxCount * maxRecordSize;
      if (!Number.isSafeInteger(maximumLength) || maximumLength > EXTERNAL_MAX_ACCOUNT_BYTES) fail(`record window ${windowName} exceeds the bounded account size`);
      windowBound += maximumLength;
      if (windowBound > EXTERNAL_MAX_ACCOUNT_BYTES) fail('bounded windows exceed the account size limit');
      return Object.freeze({kind: 'records' as const, name: windowName, offset, countField, recordSize, maxCount, ...(typeof recordSize === 'object' ? {maxRecordSize} : {}), ...(allowPrefix ? {allowPrefix: true} : {})});
    }
    if ((raw as {kind?: unknown}).kind === 'bytes') {
      record(raw, ['kind', 'name', 'offset', 'length', 'maxLength', 'allowPrefix'], `windows[${index}]`);
      const offset = normalizeFormula((raw as ExternalFormulaWindowDescriptor).offset, `window ${windowName}.offset`, fieldMap, fixedSize);
      const length = normalizeFormula((raw as ExternalFormulaWindowDescriptor).length, `window ${windowName}.length`, fieldMap);
      const maxLength = safeNonnegative((raw as ExternalFormulaWindowDescriptor).maxLength, `window ${windowName}.maxLength`);
      if (maxLength === 0 || maxLength > EXTERNAL_MAX_ACCOUNT_BYTES) fail(`window ${windowName}.maxLength is outside the bounded account size`);
      const allowPrefix = (raw as ExternalFormulaWindowDescriptor).allowPrefix;
      if (Object.hasOwn(raw, 'allowPrefix') && typeof allowPrefix !== 'boolean') fail(`window ${windowName}.allowPrefix must be boolean`);
      if (allowPrefix && allocation.kind !== 'prefix') fail(`window ${windowName} prefix access requires prefix allocation`);
      windowBound += maxLength;
      if (windowBound > EXTERNAL_MAX_ACCOUNT_BYTES) fail('bounded windows exceed the account size limit');
      return Object.freeze({kind: 'bytes' as const, name: windowName, offset, length, maxLength, ...(allowPrefix ? {allowPrefix: true} : {})});
    }
    if ((raw as {kind?: unknown}).kind !== undefined) fail(`window ${windowName}.kind must be bytes or records`);
    record(raw, ['name', 'offsetField', 'lengthField', 'maxLength'], `windows[${index}]`);
    const offsetField = validName((raw as ExternalSpanWindowDescriptor).offsetField, `window ${windowName}.offsetField`);
    const lengthField = validName((raw as ExternalSpanWindowDescriptor).lengthField, `window ${windowName}.lengthField`);
    if (offsetField === lengthField) fail(`window ${windowName} must use distinct offset and length fields`);
    const pair = `${offsetField}\u0000${lengthField}`;
    if (windowPairs.has(pair)) fail(`windows have an ambiguous duplicate field pair ${offsetField}/${lengthField}`);
    windowPairs.add(pair);
    for (const referenced of [offsetField, lengthField]) {
      const field = fieldMap.get(referenced);
      if (!field) fail(`window ${windowName} references missing field ${referenced}`);
      if (!scalar(field.type)) fail(`window ${windowName} reference ${referenced} must be an integer scalar`);
    }
    const maxLength = safeNonnegative((raw as ExternalSpanWindowDescriptor).maxLength, `window ${windowName}.maxLength`);
    if (maxLength === 0 || maxLength > EXTERNAL_MAX_ACCOUNT_BYTES) fail(`window ${windowName}.maxLength is outside the bounded account size`);
    windowBound += maxLength;
    if (windowBound > EXTERNAL_MAX_ACCOUNT_BYTES) fail('bounded windows exceed the account size limit');
    return Object.freeze({name: windowName, offsetField, lengthField, maxLength});
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

  const normalized: ValidatedExternalLayout = {
    name, fixedSize, allocation,
    fields: Object.freeze(fields), ...(logicalSize ? {logicalSize} : {}), checks,
    windows: Object.freeze(windows),
  };
  return Object.freeze(normalized);
}

function decodeField(bytes: Uint8Array, field: ExternalFieldDescriptor): ExternalFieldValue {
  const size = fieldSize(field);
  const offset = field.offset;
  if (field.type === 'bytes' || field.type === 'key32') return Uint8Array.from(bytes.subarray(offset, offset + size));
  if (field.type === 'u8') return bytes[offset]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (field.type === 'u16') return view.getUint16(offset, field.endian === 'little');
  if (field.type === 'u32') return view.getUint32(offset, field.endian === 'little');
  return view.getBigUint64(offset, field.endian === 'little');
}

function fieldInteger(value: ExternalFieldValue, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new RangeError(`external layout: ${label} is not a safe nonnegative integer`);
}
function safeFormulaValue(value: bigint, label: string): number {
  if (value < 0n || value > MAX_U64) throw new RangeError(`external layout: ${label} overflows u64`);
  if (value > BigInt(EXTERNAL_MAX_ACCOUNT_BYTES)) throw new RangeError(`external layout: ${label} exceeds the account size limit`);
  return Number(value);
}
function evaluateFormula(formula: ExternalSizeFormula, fields: Readonly<Record<string, ExternalFieldValue>>, label: string): number {
  let value = BigInt(formula.base);
  for (const [index, term] of formula.terms.entries()) {
    const factor = fieldInteger(fields[term.field]!, `${label}.${term.field}`);
    let amount: bigint;
    if (term.kind === 'ceil_divide') {
      const divisor = BigInt(term.by);
      amount = factor / divisor + (factor % divisor === 0n ? 0n : 1n);
    } else {
      const multiplier = 'byField' in term ? fieldInteger(fields[term.byField]!, `${label}.${term.byField}`) : BigInt(term.by);
      amount = factor * multiplier;
    }
    if (amount > MAX_U64 || value + amount > MAX_U64) throw new RangeError(`external layout: ${label}.terms[${index}] overflows u64`);
    value += amount;
  }
  return safeFormulaValue(value, label);
}
function boundedNumber(value: ExternalFieldValue, label: string): number {
  const integer = fieldInteger(value, label);
  if (integer > BigInt(MAX_SAFE)) throw new RangeError(`external layout: ${label} exceeds safe JavaScript integer range`);
  return Number(integer);
}

export function readExternalLayout(input: Uint8Array, descriptor: ExternalLayoutDescriptor): ExternalLayoutView {
  const layout = validateExternalLayout(descriptor);
  if (!(input instanceof Uint8Array)) throw new TypeError('external layout: input must be a Uint8Array');
  if (input.byteLength > EXTERNAL_MAX_ACCOUNT_BYTES) throw new RangeError('external layout: accessible allocation exceeds the account size limit');
  if (input.byteLength < layout.fixedSize) throw new RangeError(`external layout: ${layout.name} is shorter than its fixed header`);
  if (layout.allocation.kind === 'prefix' && input.byteLength > layout.allocation.maxLength) throw new RangeError(`external layout: ${layout.name} allocation exceeds its prefix maximum`);

  const fields: Record<string, ExternalFieldValue> = Object.create(null);
  for (const field of layout.fields) {
    const value = decodeField(input, field);
    if (scalar(field.type)) {
      const integer = fieldInteger(value, `field ${field.name}`);
      if (field.minimum !== undefined && integer < BigInt(field.minimum)) throw new RangeError(`external layout: field ${field.name} is below its minimum`);
      if (field.maximum !== undefined && integer > BigInt(field.maximum)) throw new RangeError(`external layout: field ${field.name} exceeds its maximum`);
    }
    fields[field.name] = value;
  }
  const checks = layout.checks;
  if (checks?.magic) {
    const actual = fields[checks.magic.field] as Uint8Array;
    if (!checks.magic.bytes.every((byte, index) => actual[index] === byte)) throw new RangeError(`external layout: ${layout.name} magic mismatch`);
  }
  if (checks?.version) {
    const actual = fields[checks.version.field]!;
    if (BigInt(actual as number | bigint) !== BigInt(checks.version.equals)) throw new RangeError(`external layout: ${layout.name} version mismatch`);
  }
  for (const name of checks?.reservedZero ?? []) {
    if ((fields[name] as Uint8Array).some(byte => byte !== 0)) throw new RangeError(`external layout: ${layout.name} reserved field ${name} is nonzero`);
  }

  const logicalSize = layout.logicalSize
    ? evaluateFormula(layout.logicalSize, fields, 'logicalSize')
    : layout.allocation.kind === 'exact' ? layout.fixedSize : input.byteLength;
  if (logicalSize < layout.fixedSize) throw new RangeError(`external layout: ${layout.name} logical size is shorter than its fixed header`);
  if (layout.allocation.kind === 'exact') {
    if (input.byteLength !== logicalSize) throw new RangeError(`external layout: ${layout.name} allocation does not equal its logical size`);
  } else {
    if (logicalSize > layout.allocation.maxLength) throw new RangeError(`external layout: ${layout.name} logical size exceeds its prefix maximum`);
    if (input.byteLength > logicalSize) throw new RangeError(`external layout: ${layout.name} accessible allocation exceeds its logical size`);
  }

  const windows: Record<string, Uint8Array> = Object.create(null);
  const windowInfo: Record<string, ExternalWindowInfo> = Object.create(null);
  const records: Record<string, ExternalRecordWindowView> = Object.create(null);
  const windowRanges: Array<{offset: number; length: number; name: string}> = [];
  for (const window of layout.windows) {
    let offset: number;
    let logicalLength: number;
    let recordSize: number | undefined;
    let logicalCount: number | undefined;
    let allowPrefix = false;
    if ('kind' in window && window.kind === 'bytes') {
      offset = evaluateFormula(window.offset, fields, `window ${window.name} offset`);
      logicalLength = evaluateFormula(window.length, fields, `window ${window.name} length`);
      if (logicalLength > window.maxLength) throw new RangeError(`external layout: window ${window.name} exceeds its maximum length`);
      allowPrefix = window.allowPrefix === true;
    } else if ('kind' in window && window.kind === 'records') {
      offset = window.offset;
      logicalCount = boundedNumber(fields[window.countField]!, `window ${window.name} count`);
      if (logicalCount > window.maxCount) throw new RangeError(`external layout: window ${window.name} exceeds its maximum record count`);
      recordSize = typeof window.recordSize === 'number'
        ? window.recordSize
        : boundedNumber(fields[window.recordSize.field]!, `window ${window.name} record size`);
      if (recordSize < 1 || ('maxRecordSize' in window && recordSize > window.maxRecordSize!)) throw new RangeError(`external layout: window ${window.name} record size is outside its bound`);
      const length = BigInt(logicalCount) * BigInt(recordSize);
      if (length > MAX_U64) throw new RangeError(`external layout: window ${window.name} length overflows u64`);
      logicalLength = safeFormulaValue(length, `window ${window.name} length`);
      allowPrefix = window.allowPrefix === true;
    } else {
      const offsetValue = fieldInteger(fields[window.offsetField]!, `window ${window.name} offset`);
      const lengthValue = fieldInteger(fields[window.lengthField]!, `window ${window.name} length`);
      offset = safeFormulaValue(offsetValue, `window ${window.name} offset`);
      logicalLength = safeFormulaValue(lengthValue, `window ${window.name} length`);
      if (logicalLength > window.maxLength) throw new RangeError(`external layout: window ${window.name} exceeds its maximum length`);
    }
    if (offset < layout.fixedSize) throw new RangeError(`external layout: window ${window.name} starts inside the fixed header`);
    if (logicalLength > logicalSize - offset) throw new RangeError(`external layout: window ${window.name} is outside the logical record`);
    for (const previous of windowRanges) {
      if (logicalLength !== 0 && previous.length !== 0 && offset < previous.offset + previous.length && previous.offset < offset + logicalLength) {
        throw new RangeError(`external layout: window ${window.name} overlaps window ${previous.name}`);
      }
    }
    windowRanges.push({offset, length: logicalLength, name: window.name});
    if (!allowPrefix && (offset > input.byteLength || logicalLength > input.byteLength - offset)) {
      throw new RangeError(`external layout: required window ${window.name} is truncated`);
    }
    const accessibleLength = offset >= input.byteLength ? 0 : Math.min(logicalLength, input.byteLength - offset);
    let accessibleWindow = input.subarray(Math.min(offset, input.byteLength), Math.min(offset, input.byteLength) + accessibleLength);
    if (recordSize !== undefined) {
      const count = Math.floor(accessibleLength / recordSize);
      accessibleWindow = accessibleWindow.subarray(0, count * recordSize);
      records[window.name] = Object.freeze({data: accessibleWindow, recordSize, count, logicalCount: logicalCount!});
    }
    windows[window.name] = accessibleWindow;
    windowInfo[window.name] = Object.freeze({offset, logicalLength, accessibleLength: accessibleWindow.byteLength});
  }
  return Object.freeze({layout: layout.name, byteLength: input.byteLength, logicalSize, fields: Object.freeze(fields), windows: Object.freeze(windows), windowInfo: Object.freeze(windowInfo), records: Object.freeze(records)});
}

export function readExternalField(input: Uint8Array, descriptor: ExternalLayoutDescriptor, name: string): ExternalFieldValue {
  const view = readExternalLayout(input, descriptor);
  if (!Object.hasOwn(view.fields, name)) throw new RangeError(`external layout: missing field ${name}`);
  return view.fields[name]!;
}

export function readExternalWindow(input: Uint8Array, descriptor: ExternalLayoutDescriptor, name: string): Uint8Array {
  const view = readExternalLayout(input, descriptor);
  if (!Object.hasOwn(view.windows, name)) throw new RangeError(`external layout: missing window ${name}`);
  return view.windows[name]!;
}

export function readExternalRecords(input: Uint8Array, descriptor: ExternalLayoutDescriptor, name: string): ExternalRecordWindowView {
  const view = readExternalLayout(input, descriptor);
  if (!Object.hasOwn(view.records, name)) throw new RangeError(`external layout: missing record window ${name}`);
  return view.records[name]!;
}
