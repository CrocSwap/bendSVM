import {
  validateExternalLayout,
  type ExternalFieldDescriptor,
  type ExternalLayoutDescriptor,
  type ExternalScalarType,
  type ExternalSizeFormula,
  type ExternalWindowDescriptor,
  type ValidatedExternalLayout,
} from '../sdk/external-layout.ts';

export {validateExternalLayout};
export type {ExternalEndian, ExternalFieldDescriptor, ExternalFieldType, ExternalFormulaWindowDescriptor, ExternalLayoutDescriptor, ExternalLayoutView, ExternalRecordWindowDescriptor, ExternalRecordWindowView, ExternalScalarType, ExternalSizeFormula, ExternalSizeTerm, ExternalSpanWindowDescriptor, ExternalWindowDescriptor, ExternalWindowInfo, ValidatedExternalLayout} from '../sdk/external-layout.ts';

function cSize(field: ExternalFieldDescriptor): number {
  switch (field.type) {
    case 'u8': return 1;
    case 'u16': return 2;
    case 'u32': return 4;
    case 'u64': return 8;
    case 'key32': return 32;
    case 'bytes': return field.length!;
  }
}
function cFieldType(type: ExternalScalarType): string {
  switch (type) {
    case 'u8': return 'uint8_t';
    case 'u16': return 'uint16_t';
    case 'u32': return 'uint32_t';
    case 'u64': return 'uint64_t';
  }
}
function u64(value: number): string { return `UINT64_C(${value})`; }
function cWindow(window: ExternalWindowDescriptor): {name: string; allowPrefix: boolean; kind: 'span' | 'bytes' | 'records'} {
  if ('kind' in window) return {name: window.name, allowPrefix: window.allowPrefix === true, kind: window.kind};
  return {name: window.name, allowPrefix: false, kind: 'span'};
}
function emitFormula(lines: string[], formula: ExternalSizeFormula, name: string, prefix: string): string {
  const result = `${prefix}_${name}_value`;
  lines.push(`  uint64_t ${result} = ${u64(formula.base)};`);
  formula.terms.forEach((term, index) => {
    const amount = `${prefix}_${name}_term_${index}`;
    if (term.kind === 'ceil_divide') {
      lines.push(`  uint64_t ${amount};`, `  if (!bend_external_checked_ceil_divide_u64((uint64_t)next.field_${term.field}, ${u64(term.by)}, &${amount})) return 0;`);
    } else {
      const multiplier = 'byField' in term ? `(uint64_t)next.field_${term.byField}` : u64(term.by);
      lines.push(`  uint64_t ${amount};`, `  if (!bend_external_checked_multiply_u64((uint64_t)next.field_${term.field}, ${multiplier}, &${amount})) return 0;`);
    }
    lines.push(`  if (!bend_external_checked_add_u64(${result}, ${amount}, &${result})) return 0;`);
  });
  return result;
}

export function generateExternalLayoutC(input: ExternalLayoutDescriptor): string {
  const layout: ValidatedExternalLayout = validateExternalLayout(input);
  const prefix = `bend_external_${layout.name}`;
  const lines = [
    '#include "bend_external_view.h"',
    '/* Caller supplies immutable readable data and a writable, aligned out object.',
    ' * Overlapping input/output ranges are rejected. Returned const views borrow the input;',
    ' * keep the input alive and unchanged for this call and do not retain views.',
    ' * Failure leaves *out byte-for-byte unchanged. */',
    '',
    `struct ${prefix}_view {`,
    '  size_t logical_size;',
    '  size_t accessible_size;',
  ];
  for (const field of layout.fields) {
    if (field.type === 'bytes' || field.type === 'key32') {
      lines.push(`  struct { const uint8_t *data; size_t length; } field_${field.name};`);
    } else lines.push(`  ${cFieldType(field.type)} field_${field.name};`);
  }
  for (const window of layout.windows) {
    if ('kind' in window && window.kind === 'records') {
      lines.push(`  struct { const uint8_t *data; size_t length; size_t count; size_t logical_count; size_t record_size; } window_${window.name};`);
    } else lines.push(`  struct { const uint8_t *data; size_t length; size_t logical_length; } window_${window.name};`);
  }
  lines.push('};', '', `static inline int ${prefix}_read(const uint8_t *data, size_t data_len, struct ${prefix}_view *out) {`, '  if (data == NULL || out == NULL) return 0;', '  if (data_len > BEND_EXTERNAL_MAX_ACCOUNT_BYTES) return 0;', `  if (!bend_external_buffers_disjoint(data, data_len, out, sizeof(*out))) return 0;`, `  if (data_len < (size_t)${u64(layout.fixedSize)}) return 0;`);
  if (layout.allocation.kind === 'prefix') lines.push(`  if (data_len > (size_t)${u64(layout.allocation.maxLength)}) return 0;`);
  else if (!layout.logicalSize) lines.push(`  if (data_len != (size_t)${u64(layout.fixedSize)}) return 0;`);
  lines.push(`  struct ${prefix}_view next;`, '  memset(&next, 0, sizeof(next));');

  for (const field of layout.fields) {
    const offset = `(size_t)${u64(field.offset)}`;
    if (field.type === 'bytes' || field.type === 'key32') {
      lines.push(`  next.field_${field.name}.data = data + ${offset};`, `  next.field_${field.name}.length = (size_t)${u64(cSize(field))};`);
    } else if (field.type === 'u8') lines.push(`  next.field_${field.name} = data[${offset}];`);
    else lines.push(`  next.field_${field.name} = (${cFieldType(field.type)})bend_external_load_${field.type}(data + ${offset}, ${field.endian === 'big' ? '1' : '0'});`);
    if (field.minimum !== undefined) lines.push(`  if ((uint64_t)next.field_${field.name} < ${u64(field.minimum)}) return 0;`);
    if (field.maximum !== undefined) lines.push(`  if ((uint64_t)next.field_${field.name} > ${u64(field.maximum)}) return 0;`);
  }

  const fieldMap = new Map(layout.fields.map(field => [field.name, field]));
  if (layout.checks?.magic) {
    const field = fieldMap.get(layout.checks.magic.field)!;
    lines.push(`  if (!bend_external_bytes_equal(data + (size_t)${u64(field.offset)}, (const uint8_t[]){${layout.checks.magic.bytes.map(byte => `0x${byte.toString(16).padStart(2, '0')}`).join(', ')}}, (size_t)${u64(cSize(field))})) return 0;`);
  }
  if (layout.checks?.version) lines.push(`  if ((uint64_t)next.field_${layout.checks.version.field} != ${u64(layout.checks.version.equals)}) return 0;`);
  for (const name of layout.checks?.reservedZero ?? []) {
    const field = fieldMap.get(name)!;
    lines.push(`  if (!bend_external_bytes_all_zero(data + (size_t)${u64(field.offset)}, (size_t)${u64(cSize(field))})) return 0;`);
  }

  let logicalSizeVar: string;
  if (layout.logicalSize) logicalSizeVar = emitFormula(lines, layout.logicalSize, 'logical_size', prefix);
  else if (layout.allocation.kind === 'prefix') {
    logicalSizeVar = `${prefix}_logical_size_value`;
    lines.push(`  uint64_t ${logicalSizeVar} = (uint64_t)data_len;`);
  } else {
    logicalSizeVar = `${prefix}_logical_size_value`;
    lines.push(`  uint64_t ${logicalSizeVar} = ${u64(layout.fixedSize)};`);
  }
  lines.push(`  if (${logicalSizeVar} < ${u64(layout.fixedSize)} || ${logicalSizeVar} > (uint64_t)BEND_EXTERNAL_MAX_ACCOUNT_BYTES) return 0;`);
  if (layout.allocation.kind === 'exact') lines.push(`  if ((uint64_t)data_len != ${logicalSizeVar}) return 0;`);
  else {
    lines.push(`  if (${logicalSizeVar} > ${u64(layout.allocation.maxLength)}) return 0;`);
    lines.push(`  if ((uint64_t)data_len > ${logicalSizeVar}) return 0;`);
  }
  lines.push(`  next.logical_size = (size_t)${logicalSizeVar};`, '  next.accessible_size = data_len;');

  const checkedWindows: Array<{offset: string; length: string}> = [];
  for (const window of layout.windows) {
    const {kind, name, allowPrefix} = cWindow(window);
    const offset = `${prefix}_${name}_offset`;
    const length = `${prefix}_${name}_length`;
    const safeOffset = `${offset}_safe`;
    const accessibleOffset = `${offset}_accessible`;
    const accessibleLength = `${length}_accessible`;
    if (kind === 'span') {
      const span = window as Extract<ExternalWindowDescriptor, {offsetField: string}>;
      lines.push(`  uint64_t ${offset} = (uint64_t)next.field_${span.offsetField};`, `  uint64_t ${length} = (uint64_t)next.field_${span.lengthField};`);
    } else if (kind === 'records') {
      const rows = window as Extract<ExternalWindowDescriptor, {kind: 'records'}>;
      const count = `${prefix}_${name}_count`;
      const size = `${prefix}_${name}_record_size`;
      lines.push(`  uint64_t ${offset} = ${u64(rows.offset)};`, `  uint64_t ${count} = (uint64_t)next.field_${rows.countField};`, `  if (${count} > ${u64(rows.maxCount)}) return 0;`);
      if (typeof rows.recordSize === 'number') lines.push(`  uint64_t ${size} = ${u64(rows.recordSize)};`);
      else lines.push(`  uint64_t ${size} = (uint64_t)next.field_${rows.recordSize.field};`, `  if (${size} > ${u64(rows.maxRecordSize!)}) return 0;`);
      lines.push(`  uint64_t ${length};`, `  if (!bend_external_checked_multiply_u64(${count}, ${size}, &${length})) return 0;`);
    } else {
      const bytes = window as Extract<ExternalWindowDescriptor, {kind: 'bytes'}>;
      const offsetValue = emitFormula(lines, bytes.offset, `${name}_offset`, prefix);
      const lengthValue = emitFormula(lines, bytes.length, `${name}_length`, prefix);
      lines.push(`  uint64_t ${offset} = ${offsetValue};`, `  uint64_t ${length} = ${lengthValue};`);
    }
    const maxLength = kind === 'records'
      ? ((window as Extract<ExternalWindowDescriptor, {kind: 'records'}>).maxCount * ('maxRecordSize' in window ? window.maxRecordSize! : (window as Extract<ExternalWindowDescriptor, {kind: 'records'}>).recordSize as number))
      : ('maxLength' in window ? window.maxLength : 0);
    lines.push(`  size_t ${safeOffset}, ${accessibleOffset}, ${accessibleLength};`);
    lines.push(`  if (!bend_external_checked_window((size_t)${logicalSizeVar}, data_len, ${offset}, ${length}, ${u64(layout.fixedSize)}, ${u64(maxLength)}, ${allowPrefix ? 1 : 0}, &${safeOffset}, &${accessibleOffset}, &${accessibleLength})) return 0;`);
    for (const previous of checkedWindows) lines.push(`  if (bend_external_windows_overlap(${safeOffset}, (size_t)${length}, ${previous.offset}, ${previous.length})) return 0;`);
    const pointer = `${prefix}_${name}_pointer`;
    lines.push(`  const uint8_t *${pointer} = ${safeOffset} > data_len ? NULL : data + ${accessibleOffset};`);
    lines.push(`  next.window_${name}.data = ${pointer};`, `  next.window_${name}.length = ${accessibleLength};`);
    if (kind === 'records') {
      const rows = window as Extract<ExternalWindowDescriptor, {kind: 'records'}>;
      const size = `${prefix}_${name}_record_size`;
      const count = `${prefix}_${name}_count`;
      lines.push(`  next.window_${name}.record_size = (size_t)${size};`, `  next.window_${name}.logical_count = (size_t)${count};`, `  next.window_${name}.count = ${size} == 0 ? 0 : ${accessibleLength} / (size_t)${size};`, `  next.window_${name}.length = next.window_${name}.count * next.window_${name}.record_size;`);
    } else lines.push(`  next.window_${name}.logical_length = (size_t)${length};`);
    checkedWindows.push({offset: safeOffset, length: `(size_t)${length}`});
  }
  lines.push('  *out = next;', '  return 1;', '}', '');
  return lines.join('\n');
}
