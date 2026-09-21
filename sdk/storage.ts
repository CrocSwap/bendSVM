import { wireCodec, type WireValue } from './wire.ts';
import type { RuntimeSchema } from '../compiler/schema.ts';
import type { emitSingleStorage } from '../compiler/storage.ts';

export type StorageInterface = ReturnType<typeof emitSingleStorage>['interface'];

// Account metadata belongs to the transaction, not to the encoded instruction.
// Context is populated from the runtime and is never accepted from this client.
export function storageCodec(schema: RuntimeSchema, layout: StorageInterface) {
  const codec = wireCodec(schema);
  const root = schema.exports.find(f => f.name === layout.root);
  if (layout.version !== 1 || !root || root.args.length !== 3 ||
      root.args[1] !== layout.state || root.args[2] !== layout.instruction ||
      layout.header.length !== 20 || layout.header.some(b => !Number.isInteger(b) || b < 0 || b > 255) ||
      codec.sizes.get(layout.state)! + layout.header.length !== layout.stateBytes ||
      codec.sizes.get(layout.instruction)! + 1 !== layout.instructionBytes ||
      layout.modes.initialize !== 0 || layout.modes.transition !== 1) throw new Error('Invalid storage interface');
  function instruction(value: WireValue, mode: 'initialize' | 'transition' = 'transition') {
    if (mode !== 'initialize' && mode !== 'transition') throw new Error('Invalid storage mode');
    const bytes = codec.encode(layout.instruction, value);
    const out = new Uint8Array(layout.instructionBytes);
    out[0] = layout.modes[mode]; out.set(bytes, 1); return out;
  }
  function account(data: Uint8Array) {
    if (data.length !== layout.stateBytes || layout.header.some((b, i) => data[i] !== b)) {
      throw new Error('Invalid storage account header/size');
    }
    return codec.decode(layout.state, data.subarray(layout.header.length));
  }
  return { instruction, account, reply: (data: Uint8Array) => codec.decode(layout.state, data) };
}
