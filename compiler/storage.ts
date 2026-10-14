import crypto from 'node:crypto';
import { mangle } from './backend.ts';
import { wireLayouts, type RuntimeSchema, type TypeSchema } from './schema.ts';
import { emitEffects, effectKind, effectCount } from './effects.ts';
import { emitMultiStorage } from './multi-storage.ts';
import { emitCollectionStorage, type CollectionOptions } from './collection-storage.ts';

export type StorageOptions = { stateAccounts: string[] } | { collection: CollectionOptions };
export function emitStorage(schema: RuntimeSchema, root: string): ReturnType<typeof emitSingleStorage>;
export function emitStorage(schema: RuntimeSchema, root: string, options: StorageOptions): ReturnType<typeof emitSingleStorage> | ReturnType<typeof emitMultiStorage> | ReturnType<typeof emitCollectionStorage>;
export function emitStorage(schema: RuntimeSchema, root: string, options?: StorageOptions) {
  if(options && 'collection' in options) {
    if(Object.keys(options).join(',')!=='collection')throw new Error('Unknown storage options');
    return emitCollectionStorage(schema,root,options.collection);
  }
  const single = emitSingleStorage(schema, root);
  if (!options) return single;
  if (Object.keys(options).join(',') !== 'stateAccounts') throw new Error('Unknown storage options');
  return emitMultiStorage(schema, root, options.stateAccounts, single.interface);
}

export function storageHeader(schema: RuntimeSchema, state: string) {
  const types = new Map(schema.types.map(t => [t.name, t]));
  const reachable = new Map<string, unknown>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    const t = types.get(name)!;
    reachable.set(name, t.kind === 'adt' ? { name, kind: t.kind,
      variants: t.variants.map(v => ({ name: v.name, tag: v.tag, fields: v.fields })) }
      : { name, kind: t.kind, ...(t.max === undefined ? {} : { max: t.max }) });
    if (t.kind === 'adt') t.variants.forEach(v => v.fields.forEach(f => visit(f.type)));
  };
  visit(state);
  const hash = crypto.createHash('sha256').update(JSON.stringify([...reachable.values()])).digest();
  return [66, 68, 83, 49, ...hash.subarray(0, 16)];
}

// An interface description only: business rules are always the checked root.
// The same adapter supports either pure state transitions or bounded token
// effects. Account handling and CPI contain no application-specific branches.
export function emitSingleStorage(schema: RuntimeSchema, root: string) {
  const sizes = wireLayouts(schema);
  const types = new Map(schema.types.map(t => [t.name, t]));
  const fn = schema.exports.find(f => f.name === root);
  if (!fn || fn.args.length !== 3) throw new Error('Storage root requires (context, state, instruction)');
  const record = (name: string, fields: string[]) => {
    const t = types.get(name);
    if (t?.kind !== 'adt' || t.variants.length !== 1 ||
        t.variants[0].fields.map(f => f.name).join(',') !== fields.join(',')) {
      throw new Error(`Invalid storage record: ${name}; expected ${fields.join(',')}`);
    }
    return t.variants[0];
  };
  const scalar = (name: string, kind: TypeSchema['kind']) => {
    if (types.get(name)?.kind !== kind) throw new Error(`Expected ${kind}: ${name}`);
  };
  const [context, state, instruction] = fn.args;
  const ctx = record(context, ['actor', 'signed', 'slot']);
  const key = record(ctx.fields[0].type, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  key.fields.forEach(f => scalar(f.type, 'u32'));
  scalar(ctx.fields[1].type, 'bool');
  const slot = record(ctx.fields[2].type, ['lo', 'hi']);
  slot.fields.forEach(f => scalar(f.type, 'u32'));
  const result = types.get(fn.result);
  if (result?.kind !== 'adt' || result.variants.length !== 2) throw new Error('Storage result requires Accepted/Rejected');
  const accepted = result.variants.find(v => v.name.split('.').at(-1) === 'Accepted');
  const rejected = result.variants.find(v => v.name.split('.').at(-1) === 'Rejected');
  if (!accepted || ![1,2].includes(accepted.fields.length) || accepted.fields[0].name !== 'state' || accepted.fields[0].type !== state ||
      !rejected || rejected.fields.length !== 1 || rejected.fields[0].name !== 'code') throw new Error('Invalid storage result fields');
  const effects = accepted.fields[1];
  if (effects && effects.name !== 'effects') throw new Error('Expected effects field');
  const effectCode = effects ? emitEffects(schema,effects.type) : '';
  const cpi = effects && effectKind(schema,effects.type)==='cpi-v1';
  const effectSlots = effects ? effectCount(schema,effects.type) : 0;
  scalar(rejected.fields[0].type, 'u32');
  // Hash only the reachable state layout. Changes to function code do not
  // invalidate storage; changes to its type names, fields or tags do.
  const header = storageHeader(schema, state);
  const n = sizes.get(state)!, ixn = sizes.get(instruction)!;
  const stateType = types.get(state)!.cType, ixType = types.get(instruction)!.cType;
  const c = `/* Generated shared state adapter, ABI version 1. */
#include "solana_min.h"
${effectCode}
typedef struct { u64 slot; long long epoch_start_timestamp; u64 epoch;
  u64 leader_schedule_epoch; long long unix_timestamp; } BendClock;
_Static_assert(sizeof(BendClock) == 40, "Clock ABI");
extern u64 sol_get_clock_sysvar(void *);
__attribute__((visibility("default")))
u64 entrypoint(const u8 *input) {
  u64 count = read_le(input, 8);
  if (${effects ? 'count < 4 || count > 12' : 'count != 2'}) return 1;
  Account accounts[${effects ? 12 : 2}];
  const u8 *p = input + 8;
  for (unsigned i = 0; i < count; ++i) {
    p = read_account(p,&accounts[i]);
    if (!p) return 6;
    for (unsigned j = 0; j < i; ++j) if (equal_key(accounts[i].key,accounts[j].key)) return 6;
  }
  Account state = accounts[0], actor = accounts[1];
  u64 length = read_le(p, 8);
  const u8 *ix = p + 8;
  const u8 *program = ix + length;
  if (length != ${ixn + 1} || ix[0] > 1) return 2;
  ${effects ? `u8 bump; u64 setup = ${cpi?'bend_invoke_custody':'bend_custody'}(accounts,program,&bump); if (setup) return setup;` : ''}
  if (!equal_key(state.owner, program) || state.executable) return 3;
  if (!state.writable) return 5;
  if (state.size != ${header.length + n}) return 4;
  const u8 header[${header.length}] = {${header.join(',')}};
  ${stateType} before;
  if (ix[0] == 0) {
    /* Only the signing state address may initialize an all-zero allocation. */
    if (!state.signer) return 7;
    for (unsigned i = 0; i < ${header.length + n}; ++i) if (state.data[i]) return 4;
    const u8 empty[${n}] = {0};
    if (!${mangle(state)}_decode(empty, ${n}, &before)) return 4;
  } else {
    for (unsigned i = 0; i < ${header.length}; ++i) if (state.data[i] != header[i]) return 4;
    if (!${mangle(state)}_decode(state.data + ${header.length}, ${n}, &before)) return 4;
  }
  ${ixType} instruction;
  if (!${mangle(instruction)}_decode(ix + 1, ${ixn}, &instruction)) return 2;
  BendClock clock;
  if (sol_get_clock_sysvar(&clock)) return 8;
  ${types.get(context)!.cType} context = ${ctx.cMaker}(
    ${key.cMaker}(${key.fields.map((_, i) => `(u32)read_le(actor.key + ${4 * i}, 4)`).join(', ')}),
    actor.signer, ${slot.cMaker}((u32)clock.slot, (u32)(clock.slot >> 32)));
  ${result.cType} outcome = ${fn.cName}(context, before, instruction);
  if (outcome.tag == ${rejected.tag}) {
    u32 code = outcome.as.c${rejected.tag}.f0;
    return code <= 0xfffffeffu ? 256ULL + code : 9;
  }
  if (outcome.tag != ${accepted.tag}) return 9;
  u8 encoded[${n}];
  if (!${mangle(state)}_encode(encoded, ${n}, &outcome.as.c${accepted.tag}.f0)) return 9;
  ${effects ? `${cpi?'BendInvoke':'BendTransfer'} transfers[${effectSlots}];
  if (!bend_extract_effects(&outcome.as.c${accepted.tag}.f1,transfers)) return 9;
  for (unsigned i = 0; i < ${effectSlots}; ++i) {
    u64 error = ${cpi?'bend_invoke_validate':'bend_transfer_validate'}(&transfers[i],accounts,(unsigned)count);
    ${cpi?'if (transfers[i].active) for (unsigned j=0;j<transfers[i].count && j<8;++j) if (transfers[i].metas[j].index==0 && transfers[i].metas[j].writable) return 22;':''}
    if (error) return error;
  }
  for (unsigned i = 0; i < ${effectSlots}; ++i) {
    if (${cpi?'bend_invoke_execute':'bend_transfer_execute'}(&transfers[i],accounts,(unsigned)count,bump)) return 18;
  }` : ''}
  /* Encoding succeeded and all effects completed; commit disjoint local bytes. */
  __builtin_memcpy(state.data, header, ${header.length});
  __builtin_memcpy(state.data + ${header.length}, encoded, ${n});
  sol_set_return_data(encoded, ${n});
  return 0;
}
`;
  return { c, interface: { version: 1, root, state, instruction, header,
    stateBytes: header.length + n, instructionBytes: ixn + 1,
    modes: { initialize: 0, transition: 1 }, accounts: effects ? ['state','actor',cpi?'program':'tokenProgram','custody','remaining...'] : ['state', 'actor'],
    effects: effects ? effectKind(schema,effects.type) : 'none',
    ...(effectSlots > 2 ? {effectSlots} : {}) } };
}
