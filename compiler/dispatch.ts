import { mangle } from './backend.ts';
import { wireLayouts, type RuntimeSchema } from './schema.ts';

// A generic typed-call interface, usable by stateless programs and test clients.
// Stateful account programs can also use the same generated per-type codecs.
export function emitDispatcher(schema: RuntimeSchema): string {
  const sizes = wireLayouts(schema);
  const types = new Map(schema.types.map(t => [t.name, t]));
  if (!schema.exports.length || schema.exports.length > 256) throw new Error('Expected 1..256 exports');
  const lines = ['/* Generated typed-call dispatcher. */', '#pragma once',
    'static inline int bend_wire_dispatch(const unsigned char *input, unsigned long long length,',
    '    unsigned char *output, unsigned long long capacity, unsigned long long *written) {',
    '  *written = 0;', '  if (length == 0) return 0;', '  switch (input[0]) {'];
  for (const [opcode, exp] of schema.exports.entries()) {
    const inputSize = 1 + exp.args.reduce((n, type) => n + sizes.get(type)!, 0);
    if (inputSize > 1024) throw new Error(`Instruction exceeds 1024 bytes: ${exp.name}`);
    const resultSize = sizes.get(exp.result)!;
    lines.push(`  case ${opcode}: {`, `    if (length != ${inputSize} || capacity < ${resultSize}) return 0;`);
    let offset = 1;
    exp.args.forEach((type, i) => {
      lines.push(`    ${types.get(type)!.cType} a${i};`,
        `    if (!${mangle(type)}_decode(input + ${offset}, ${sizes.get(type)}, &a${i})) return 0;`);
      offset += sizes.get(type)!;
    });
    lines.push(`    ${types.get(exp.result)!.cType} result = ${exp.cName}(${exp.args.map((_, i) => `a${i}`).join(', ')});`,
      `    if (!${mangle(exp.result)}_encode(output, ${resultSize}, &result)) return 0;`,
      `    *written = ${resultSize};`, '    return 1;', '  }');
  }
  lines.push('  default: return 0;', '  }', '}', '');
  return lines.join('\n');
}
