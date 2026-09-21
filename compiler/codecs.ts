import { mangle } from './backend.ts';
import { wireLayouts, type RuntimeSchema } from './schema.ts';

export function emitCodecs(schema: RuntimeSchema): string {
  const sizes = wireLayouts(schema);
  const types = new Map(schema.types.map(t => [t.name, t]));
  const lines = ['/* Generated canonical wire codecs. Include the generated types first. */', '#pragma once'];
  // Dependency order is derived from the schema rather than array order.
  const done = new Set<string>();
  const emit = (name: string) => {
    if (done.has(name)) return;
    done.add(name);
    const t = types.get(name)!;
    if (t.kind === 'adt') t.variants.forEach(v => v.fields.forEach(f => emit(f.type)));
    const id = mangle(name), n = sizes.get(name)!;
    lines.push(`#define ${id}_WIRE_SIZE ${n}u`);
    lines.push(`static inline int ${id}_decode(const unsigned char *p, unsigned long long n, ${t.cType} *out) {`);
    lines.push(`  if (n != ${n}u) return 0;`);
    if (t.kind === 'u32') {
      lines.push('  *out = (bend_u32)p[0] | ((bend_u32)p[1] << 8) | ((bend_u32)p[2] << 16) | ((bend_u32)p[3] << 24);', ...(t.max!==undefined?[`  if (*out > ${t.max}u) return 0;`]:[]), '  return 1;');
    } else if (t.kind === 'bool') {
      lines.push('  if (p[0] > 1) return 0;', '  *out = p[0];', '  return 1;');
    } else {
      lines.push('  switch (p[0]) {');
      for (const v of t.variants) {
        lines.push(`  case ${v.tag}: {`);
        let offset = 1;
        for (const [i, f] of v.fields.entries()) {
          lines.push(`    ${types.get(f.type)!.cType} f${i};`);
          lines.push(`    if (!${mangle(f.type)}_decode(p + ${offset}, ${sizes.get(f.type)}, &f${i})) return 0;`);
          offset += sizes.get(f.type)!;
        }
        if (offset < n) lines.push(`    for (unsigned i = ${offset}; i < ${n}; ++i) if (p[i] != 0) return 0;`);
        lines.push(`    *out = ${v.cMaker}(${v.fields.map((_, i) => `f${i}`).join(', ')});`, '    return 1;', '  }');
      }
      lines.push('  default: return 0;', '  }');
    }
    lines.push('}');
    lines.push(`static inline int ${id}_encode(unsigned char *p, unsigned long long n, const ${t.cType} *value) {`);
    lines.push(`  if (n != ${n}u) return 0;`);
    if (t.kind === 'u32') {
      if(t.max!==undefined) lines.push(`  if (*value > ${t.max}u) return 0;`);
      lines.push('  for (unsigned i = 0; i < 4; ++i) p[i] = (unsigned char)(*value >> (8 * i));', '  return 1;');
    } else if (t.kind === 'bool') {
      lines.push('  if (*value > 1) return 0;', '  p[0] = (unsigned char)*value;', '  return 1;');
    } else {
      lines.push(`  for (unsigned i = 0; i < ${n}; ++i) p[i] = 0;`, '  switch (value->tag) {');
      for (const v of t.variants) {
        lines.push(`  case ${v.tag}:`, `    p[0] = ${v.tag};`);
        let offset = 1;
        v.fields.forEach((f, i) => {
          lines.push(`    if (!${mangle(f.type)}_encode(p + ${offset}, ${sizes.get(f.type)}, &value->as.c${v.tag}.f${i})) return 0;`);
          offset += sizes.get(f.type)!;
        });
        lines.push('    return 1;');
      }
      lines.push('  default: return 0;', '  }');
    }
    lines.push('}');
  };
  schema.types.forEach(t => emit(t.name));
  return lines.join('\n') + '\n';
}
