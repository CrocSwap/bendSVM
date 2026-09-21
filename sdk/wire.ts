import { wireLayouts, type RuntimeSchema } from '../compiler/schema.ts';

export type WireValue = number | boolean | { constructor: string; fields: Record<string, WireValue> };

// Client codec consumes the emitted interface, never C structure layouts.
export function wireCodec(schema: RuntimeSchema) {
  const sizes = wireLayouts(schema);
  const types = new Map(schema.types.map(t => [t.name, t]));
  function encode(type: string, value: WireValue): Uint8Array {
    const t = types.get(type); if (!t) throw new Error(`Unknown wire type: ${type}`);
    const out = new Uint8Array(sizes.get(type)!);
    if (t.kind === 'u32') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > (t.max??0xffffffff)) throw new Error('Expected u32');
      new DataView(out.buffer).setUint32(0, value, true);
    } else if (t.kind === 'bool') {
      if (typeof value !== 'boolean') throw new Error('Expected bool');
      out[0] = Number(value);
    } else {
      if (typeof value !== 'object' || value === null) throw new Error(`Expected ${type} constructor`);
      const variant = t.variants.find(v => v.name === value.constructor);
      if (!variant || !value.fields || typeof value.fields !== 'object') throw new Error(`Invalid ${type} constructor`);
      if (Object.keys(value.fields).length !== variant.fields.length ||
          variant.fields.some(f => !Object.hasOwn(value.fields, f.name))) throw new Error('Incorrect constructor fields');
      out[0] = variant.tag;
      let offset = 1;
      for (const f of variant.fields) {
        const bytes = encode(f.type, value.fields[f.name]); out.set(bytes, offset); offset += bytes.length;
      }
    }
    return out;
  }
  function decode(type: string, input: Uint8Array): WireValue {
    const t = types.get(type); if (!t) throw new Error(`Unknown wire type: ${type}`);
    if (input.length !== sizes.get(type)) throw new Error(`Incorrect wire size: ${type}`);
    if (t.kind === 'u32') {
      const value=new DataView(input.buffer,input.byteOffset,4).getUint32(0,true);
      if(value>(t.max??0xffffffff))throw new Error('Invalid bounded integer');
      return value;
    }
    if (t.kind === 'bool') {
      if (input[0] > 1) throw new Error('Invalid bool');
      return input[0] === 1;
    }
    const variant = t.variants[input[0]]; if (!variant) throw new Error(`Invalid tag: ${type}`);
    const fields: Record<string, WireValue> = Object.create(null);
    let offset = 1;
    for (const f of variant.fields) {
      const size = sizes.get(f.type)!;
      fields[f.name] = decode(f.type, input.subarray(offset, offset + size)); offset += size;
    }
    if (input.subarray(offset).some(v => v !== 0)) throw new Error('Nonzero wire padding');
    return { constructor: variant.name, fields };
  }
  function call(name: string, args: WireValue[]): Uint8Array {
    const opcode = schema.exports.findIndex(f => f.name === name);
    if (opcode < 0 || opcode > 255) throw new Error(`Unknown export: ${name}`);
    const exp = schema.exports[opcode];
    if (args.length !== exp.args.length) throw new Error('Incorrect argument count');
    const bytes = args.map((arg, i) => encode(exp.args[i], arg));
    const out = new Uint8Array(1 + bytes.reduce((sum, b) => sum + b.length, 0));
    if (out.length > 1024) throw new Error('Instruction exceeds 1024 bytes');
    out[0] = opcode;
    let offset = 1;
    for (const b of bytes) { out.set(b, offset); offset += b.length; }
    return out;
  }
  function reply(name: string, input: Uint8Array): WireValue {
    const exp = schema.exports.find(f => f.name === name);
    if (!exp) throw new Error(`Unknown export: ${name}`);
    return decode(exp.result, input);
  }
  return { sizes, encode, decode, call, reply };
}
