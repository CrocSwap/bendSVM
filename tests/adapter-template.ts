import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { emitStorage } from '../compiler/storage.ts';

// A regression audit of the emitted ABI 1 control-flow skeleton. This checks
// the generated text, not C semantics or the SBF binary.
type EffectKind = 'none' | 'token' | 'cpi';
function audit(c: string, effects: EffectKind) {
  const start = c.indexOf('u64 entrypoint(const u8 *input) {');
  assert(start >= 0, 'missing ABI 1 entrypoint');
  const body = c.slice(start);
  const stages = [
    'p = read_account(p,&accounts[i]);',
    'if (equal_key(accounts[i].key,accounts[j].key)) return 6;',
    'if (!equal_key(state.owner, program) || state.executable) return 3;',
    'if (!state.writable) return 5;',
    'if (state.size != ',
    'if (!state.signer) return 7;',
    'if (state.data[i]) return 4;',
    '_decode(empty,',
    'if (state.data[i] != header[i]) return 4;',
    '_decode(state.data + ',
  ];
  let position = 0;
  for (const stage of stages) {
    const next = body.indexOf(stage, position);
    assert(next >= position, `missing or reordered adapter stage: ${stage}`);
    position = next + stage.length;
  }
  const sequence = [
    '_decode(ix + 1,',
    'sol_get_clock_sysvar(&clock)',
    ' outcome = ',
    'if (outcome.tag == ',
    'if (outcome.tag != ',
    '_encode(encoded,',
    ...(effects === 'none' ? [] : ['bend_extract_effects(',
      effects === 'cpi' ? 'bend_invoke_validate(' : 'bend_transfer_validate(',
      effects === 'cpi' ? 'bend_invoke_execute(' : 'bend_transfer_execute(']),
    '__builtin_memcpy(state.data, header,',
    '__builtin_memcpy(state.data + ',
    'sol_set_return_data(encoded,',
    'return 0;',
  ];
  for (const stage of sequence) {
    const next = body.indexOf(stage, position);
    assert(next >= position, `missing or reordered adapter stage: ${stage}`);
    position = next + stage.length;
  }
  if (effects === 'none') {
    assert(!body.includes('bend_transfer_execute('));
    assert(!body.includes('bend_invoke_execute('));
  }
}

function auditMulti(c: string, count: number, effects: boolean) {
  const start=c.indexOf('u64 entrypoint(const u8 *input) {');
  assert(start>=0,'missing ABI 2 entrypoint');
  const body=c.slice(start);
  const root=body.indexOf(' outcome=');
  const execution=effects?body.indexOf('bend_transfer_execute('):root;
  assert(root>=0 && execution>=0,'missing ABI 2 transition or effect execution');
  for(let i=1;i<count;++i) {
    const check=`if(!equal_key(state${i}.data+20,state0.key)) return 4;`;
    const write=`__builtin_memcpy(state${i}.data+20,state0.key,32);`;
    const checkAt=body.indexOf(check),writeAt=body.indexOf(write);
    assert(checkAt>body.indexOf(`if (state${i}.size != `) && checkAt<root,
      `missing or reordered ABI 2 primary binding check for field ${i}`);
    assert(writeAt>execution && writeAt<body.indexOf(`__builtin_memcpy(state${i}.data+52,encoded${i},`),
      `missing or reordered ABI 2 primary binding write for field ${i}`);
  }
}

function auditCollection(c: string, effects: EffectKind) {
  const start = c.indexOf('static u64 bend_collection_run(');
  const end = c.indexOf('__attribute__((visibility("default"))) u64 entrypoint(', start);
  assert(start >= 0 && end > start, 'missing ABI 3 helper or entrypoint');
  const body = c.slice(start, end);
  const stages = [
    'if(!equal_key(state->owner,program)||state->executable)return 3;',
    'if(!state->writable)return 5;',
    'if(state->size!=',
    'if(!state->signer)return 7;',
    'if(state->data[i])return 4;',
    '_decode(state->data+20,',
    'bend_collection_open(',
    '_decode(ix+1,',
    'sol_get_clock_sysvar(&clock)',
    ' selection=',
    'bend_collection_select(',
    ' result=',
    'bend_collection_plan(',
    '_encode(encoded_state,',
    ...(effects === 'none' ? [] : [
      'bend_extract_effects(',
      effects === 'cpi' ? 'bend_invoke_validate(' : 'bend_transfer_validate(',
      effects === 'cpi' ? 'bend_invoke_execute(' : 'bend_transfer_execute(',
    ]),
    'bend_collection_commit(',
    '__builtin_memcpy(state->data,state_header,20);',
    '__builtin_memcpy(state->data+20,encoded_state,',
    'sol_set_return_data(encoded_state,',
  ];
  let position = 0;
  for (const stage of stages) {
    const next = body.indexOf(stage, position);
    assert(next >= position, `missing or reordered ABI 3 stage: ${stage}`);
    position = next + stage.length;
  }
  const entry = c.slice(end);
  assert(entry.includes('if(equal_key(accounts[i].key,accounts[j].key))return 6;'),
    'missing ABI 3 account alias guard');
  assert(entry.includes('return bend_collection_run('), 'missing ABI 3 helper call');
}

export async function testAdapterTemplate() {
  for (const [source, effects] of [
    ['tests/storage.bend', 'none'],
    ['tests/settlement.bend', 'token'],
    ['tests/cpi.bend', 'cpi'],
  ] as const) {
    const emitted = new Backend(await checkedBook(source)).emit(['process']);
    const c = emitStorage(emitted.schema, 'process').c;
    audit(c, effects);
    const mutations = [
      ['owner guard', 'if (!equal_key(state.owner, program) || state.executable) return 3;'],
      ['writable guard', 'if (!state.writable) return 5;'],
      ['initialization signature', 'if (!state.signer) return 7;'],
      ['state decoding', '_decode(state.data + '],
      ['state commit', '__builtin_memcpy(state.data, header,'],
      ...(effects === 'none' ? [] : [
        ['effect validation', effects === 'cpi' ? 'bend_invoke_validate(' : 'bend_transfer_validate('],
        ['effect execution', effects === 'cpi' ? 'bend_invoke_execute(' : 'bend_transfer_execute('],
      ] as const),
    ] as const;
    for (const [name, text] of mutations) {
      assert(c.includes(text), `${source}: missing mutation target ${name}`);
      assert.throws(() => audit(c.replace(text, `/* removed ${name} */`), effects),
        /missing or reordered/, `${source}: audit accepted missing ${name}`);
    }
  }
  for(const [source,layoutFile,effects] of [
    ['tests/multi-storage.bend','tests/multi-storage.layout.json',false],
    ['tests/multi-token-2.bend','tests/multi-token-2.layout.json',true],
  ] as const) {
    const emitted=new Backend(await checkedBook(source)).emit(['process']);
    const layout=JSON.parse(fs.readFileSync(layoutFile,'utf8'));
    const generated=emitStorage(emitted.schema,'process',layout);
    assert('stateAccounts' in generated.interface,'expected ABI 2 adapter');
    const c=generated.c,count=generated.interface.stateAccounts.length;
    auditMulti(c,count,effects);
    for(let i=1;i<count;++i) {
      for(const text of [
        `if(!equal_key(state${i}.data+20,state0.key)) return 4;`,
        `__builtin_memcpy(state${i}.data+20,state0.key,32);`,
      ]) {
        assert(c.includes(text),'missing ABI 2 mutation target');
        assert.throws(()=>auditMulti(c.replace(text,'/* removed binding */'),count,effects),
          /missing or reordered ABI 2/, 'ABI 2 audit accepted a missing instance binding');
      }
    }
  }
  for (const [source, layoutFile, effects] of [
    ['tests/collection-store.bend', 'tests/collection-store.json', 'none'],
    ['tests/collection-cpi.bend', 'tests/collection-cpi.json', 'cpi'],
  ] as const) {
    const emitted = new Backend(await checkedBook(source)).emit(['process', 'select']);
    const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
    const c = emitStorage(emitted.schema, 'process', layout).c;
    auditCollection(c, effects);
    for (const stage of [
      'bend_collection_open(', 'bend_collection_select(', 'bend_collection_plan(',
      '_encode(encoded_state,', 'bend_collection_commit(',
      ...(effects === 'none' ? [] : ['bend_invoke_validate(', 'bend_invoke_execute(']),
    ]) {
      const at = c.indexOf(stage, c.indexOf('static u64 bend_collection_run('));
      assert(at >= 0, `missing ABI 3 mutation target: ${stage}`);
      const mutated = c.slice(0, at) + '/* removed ABI 3 stage */' + c.slice(at + stage.length);
      assert.throws(() => auditCollection(mutated, effects),
        /missing or reordered ABI 3/, `ABI 3 audit accepted missing ${stage}`);
    }
  }
  console.log('ABI 1/2/3 generated adapter order, binding and negative mutations passed');
}

if (import.meta.main) await testAdapterTemplate();
