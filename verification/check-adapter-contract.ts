import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {prepareBend} from '../scripts/build.ts';

// Implementation-linked ABI 1 adapter contract check. Real adapters are
// emitted with the ordinary artifact writer, read back from disk together with
// their include closure, and handed to verification/adapter_contract.py. The
// report is published only if every fixture verifies, every mutated artifact
// is rejected for its expected reason and every behavior-preserving variant
// is accepted. See docs/adapter-assurance.md for the contract.
const driverHashAtStart = crypto.createHash('sha256').update(fs.readFileSync(import.meta.path)).digest('hex');
const reportPath = 'build/adapter-contract-refinement.json';
const pendingPath = reportPath + '.pending';
fs.rmSync(pendingPath, {force:true});
fs.rmSync(reportPath, {force:true});
const interpreterTests = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'tests/adapter-interpreter.py'],
  {encoding:'utf8', timeout:120_000});
assert.ifError(interpreterTests.error);
assert.equal(interpreterTests.status, 0, interpreterTests.stderr || interpreterTests.stdout);
prepareBend();
const {Backend, checkedProgram} = await import('../compiler/backend.ts');
const {writeArtifacts} = await import('../compiler/artifacts.ts');
const directory = 'build/adapter-contract';
fs.mkdirSync(directory, {recursive:true});

// Pure, two- and three-slot token, single and paired two-slot CPI adapters,
// then every other checked program that is emitted with the ABI 1 adapter:
// token-v2 issuance, the four-slot effect vector and the example applications.
const selections: [string,string,string][] = [
  ['pure','tests/storage.bend','process'],
  ['token-2','tests/settlement.bend','process'],
  ['token-3','tests/token-three.bend','process'],
  ['cpi-2','tests/cpi.bend','process'],
  ['cpi-pair','tests/cpi-pair.bend','process'],
  ['issuance-3','tests/token-issuance.bend','process'],
  ['effect-vector-4','tests/effect-buffer.bend','process'],
  ['vault','examples/vault/PROOF.bend','vault.process'],
  ['vesting','examples/vesting/PROOF.bend','vesting.process'],
  ['exchange','examples/exchange/PROOF.bend','exchange.process'],
  ['amm','examples/amm/PROOF.bend','amm.process'],
  ['batch','examples/batch/PROOF.bend','batch.process'],
];
type Fixture = {name:string; source:string; root:string; adapter:string; files:Record<string,string>; schema:any; interface:any};
const hash = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = new Set<string>();
const fixtures: Fixture[] = [];
const recorded: any[] = [];
for (const [name, source, root] of selections) {
  const checked = await checkedProgram(source);
  const emitted = new Backend(checked.book).emit([root]);
  const stem = `${directory}/${name}`;
  for (const suffix of ['.c','.h','.wire.h','.schema.json','.interface.json']) fs.rmSync(stem+suffix, {force:true});
  writeArtifacts(stem, emitted, root);
  // Everything below is read back from the written artifacts. The include
  // closure is resolved as the build does: artifact directory, then runtime/.
  const files: Record<string,string> = {}, paths: Record<string,string> = {};
  const pending = [`${name}.c`];
  while (pending.length) {
    const file = pending.pop()!;
    if (file in files) continue;
    const found = [path.join(directory, file), path.join('runtime', file)].find(p => fs.existsSync(p));
    assert(found, `${name}: unresolved include ${file}`);
    files[file] = fs.readFileSync(found, 'utf8'); paths[file] = found;
    for (const m of files[file].matchAll(/^[ \t]*#[ \t]*include[ \t]*["<]([^">\n]+)[">]/gm)) pending.push(m[1]);
  }
  const iface = JSON.parse(fs.readFileSync(stem+'.interface.json','utf8'));
  assert.equal(iface.version, 1, `${name}: expected the ABI 1 adapter`);
  fixtures.push({name, source, root, adapter:`${name}.c`, files,
    schema:JSON.parse(fs.readFileSync(stem+'.schema.json','utf8')), interface:iface});
  for (const file of [...checked.files, source, stem+'.schema.json', stem+'.interface.json', ...Object.values(paths)]) inputs.add(file);
  recorded.push({fixture:name, source, root, interface:iface, schemaSha256:hash(stem+'.schema.json'),
    interfaceSha256:hash(stem+'.interface.json'), artifacts:Object.fromEntries(Object.entries(paths).map(([k,v])=>[k,{path:v,sha256:hash(v)}])),
    sourceDependencies:Object.fromEntries([...new Set(checked.files)].map(f=>[path.relative(process.cwd(),path.resolve(f)),hash(f)]))});
}

// ---- Variants of the written artifacts ------------------------------------------
// Every mutation rewrites text read back from disk and must be rejected for the
// stated reason: `semantic` means the mutated C was parsed and executed and Z3
// produced a counterexample to the named entrypoint check; `grammar` means
// rejection by parsing, dependency conformance or the extraction structural
// checker, without an entrypoint solver counterexample.
type Kind = 'semantic' | 'grammar';
type Variant = {name:string; fixture:string; files:Record<string,string>; kind?:Kind; expected?:string; exactly?:string[]};
const mutations: Variant[] = [], equivalents: Variant[] = [];
const once = (text:string, pattern:RegExp|string, replacement:string|((...m:string[])=>string), label:string) => {
  const found = typeof pattern === 'string' ? text.split(pattern).length - 1
    : (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
  assert.equal(found, 1, `mutation target must occur exactly once: ${label}`);
  return text.replace(pattern as any, replacement as any);
};
const fixture = (name:string) => fixtures.find(f => f.name === name)!;
// Text-level rejections are cheap and run on all three adapter kinds; most
// semantic mutants run on the pure and token adapters, a core set also on CPI.
const ANY = ['pure','token-2'], ALL = ['pure','token-2','cpi-2'], EFFECTS = ['token-2','token-3','cpi-2','effect-vector-4'];
const TWO = ['token-2','cpi-2'], CPI = ['cpi-2','cpi-pair'];
type Edit = (c:string, f:Fixture) => string;
function mutate(name:string, on:string[], kind:Kind, expected:string, edit:Edit, file?:string, exactly?:string[]) {
  for (const id of on) {
    const f = fixture(id), target = file === 'wire' ? `${id}.wire.h` : file ?? f.adapter;
    const text = edit(f.files[target], f);
    assert.notEqual(text, f.files[target], `${id}: mutation did not change the artifact: ${name}`);
    mutations.push({name, fixture:id, files:{[target]:text}, kind, expected, ...(exactly ? {exactly} : {})});
  }
}
function equivalent(name:string, on:string[], edit:Edit) {
  for (const id of on) {
    const f = fixture(id), text = edit(f.files[f.adapter], f);
    assert.notEqual(text, f.files[f.adapter], `${id}: variant did not change the artifact: ${name}`);
    equivalents.push({name, fixture:id, files:{[f.adapter]:text}});
  }
}
const n = (f:Fixture) => f.interface.stateBytes - 20;
const slots = (f:Fixture) => f.interface.effects === 'none' ? 0 : f.interface.effectSlots ?? 2;
const headerDecl = /(const u8 header\[20\] = \{[\d,]+\};\n)/;
const encodeCheck = /(  if \(!\w+_encode\(encoded, \d+, &outcome\.as\.c\d+\.f0\)\) return 9;\n)/;
const storedDecode = /if \(!(\w+_decode\(state\.data \+ 20, \d+, &before\))\) return 4;/;
const emptyDecode = /if \(!(\w+_decode\(empty, \d+, &before\))\) return 4;/;
const ixDecode = /  if \(!(\w+_decode\(ix \+ 1, \d+, &instruction\))\) return 2;\n/;
const clockCheck = /  if \((sol_get_clock_sysvar\(&clock\))\) return 8;\n/;
const rootCall = /(  \S+ outcome = (\w+\(context, before, instruction\));\n)/;
const validateLoop = /for \(unsigned i = 0; i < (\d+); \+\+i\) \{(\s*u64 error = )/;
const executeLoop = /for \(unsigned i = 0; i < (\d+); \+\+i\) \{(\s*if \(bend_\w+_execute)/;
const executeCall = /if \((bend_(?:transfer|invoke)_execute\(&transfers\[i\],accounts,\(unsigned\)count,bump\))\) return 18;/;
const headerWrite = /  __builtin_memcpy\(state\.data, header, 20\);\n/;
const payloadWrite = /  __builtin_memcpy\(state\.data \+ 20, encoded, \d+\);\n/;
const returnData = /  sol_set_return_data\(encoded, \d+\);\n/;
const ROOT = 'root-precondition-and-arguments', COMMIT = 'commit-only-on-success', EXACT = 'exact-commit-and-return-data';
const ORDER = 'effect-slot-order-and-validation-before-execution', IFF = 'success-iff-contract';
const MAP = 'rejection-mapping', WIDTH = 'helper-code-width', PINNED = 'pinned-precedence-return-code';

// Early commit.
mutate('early-commit: header written before the transition', ALL, 'semantic', COMMIT, c =>
  once(c, headerDecl, '$1  __builtin_memcpy(state.data, header, 20);\n', 'header'));
mutate('early-commit: payload written before effects are validated and executed', TWO, 'semantic', COMMIT, (c, f) =>
  once(c, encodeCheck, `$1  __builtin_memcpy(state.data + 20, encoded, ${n(f)});\n`, 'encode'));
mutate('early-commit: return data set before effects', TWO, 'semantic', COMMIT, (c, f) =>
  once(c, encodeCheck, `$1  sol_set_return_data(encoded, ${n(f)});\n`, 'encode'));
mutate('early-commit: state committed inside the execution loop', EFFECTS, 'semantic', COMMIT, (c, f) =>
  once(c, executeCall, `$&\n    __builtin_memcpy(state.data + 20, encoded, ${n(f)});`, 'execute'));
// Missing guards.
mutate('guard: account count upper bound', ALL, 'semantic', 'bounds: accounts[', c =>
  once(c, /if \(count (?:!= 2|< 4 \|\| count > 12)\) return 1;/, m => m.includes('!=') ? 'if (count < 2) return 1;' : 'if (count < 4) return 1;', 'count'));
mutate('guard: account count lower bound', TWO, 'semantic', 'helper: receives an account the loader parser did not fill', c =>
  once(c, 'if (count < 4 || count > 12) return 1;', 'if (count < 3 || count > 12) return 1;', 'count'));
mutate('guard: duplicate keys', ALL, 'semantic', ROOT, c =>
  once(c, 'for (unsigned j = 0; j < i; ++j) if (equal_key(accounts[i].key,accounts[j].key)) return 6;', '', 'alias'));
mutate('guard: duplicate keys compared with the first two accounts only', TWO, 'semantic', ROOT, c =>
  once(c, 'for (unsigned j = 0; j < i; ++j) if (equal_key(accounts[i]', 'for (unsigned j = 0; j < i && j < 2; ++j) if (equal_key(accounts[i]', 'alias'));
mutate('guard: alias marker', ALL, 'semantic', 'account: read of an account the loader parser did not fill', c =>
  once(c, '    if (!p) return 6;\n', '', 'marker'));
mutate('guard: instruction length', ANY, 'semantic', 'bounds: instruction read within the instruction length', c =>
  once(c, /length != \d+ \|\| /, '', 'length'));
mutate('guard: mode byte', ANY, 'semantic', ROOT, c => once(c, ' || ix[0] > 1', '', 'mode'));
mutate('guard: state owner', ANY, 'semantic', ROOT, c => once(c, '!equal_key(state.owner, program) || ', '', 'owner'));
mutate('guard: state owner compared with the state key', ANY, 'semantic', ROOT, c =>
  once(c, '!equal_key(state.owner, program)', '!equal_key(state.owner, state.key)', 'owner'));
mutate('guard: executable', ANY, 'semantic', ROOT, c => once(c, ' || state.executable', '', 'executable'));
mutate('guard: writable', ALL, 'semantic', ROOT, c => once(c, '  if (!state.writable) return 5;\n', '', 'writable'));
mutate('guard: state size', ALL, 'semantic', 'bounds: state data read within the account size', c =>
  once(c, /  if \(state\.size != \d+\) return 4;\n/, '', 'size'));
mutate('guard: state size one byte short', ANY, 'semantic', 'bounds: state data', (c, f) =>
  once(c, /if \(state\.size != \d+\) return 4;/, `if (state.size != ${f.interface.stateBytes - 1}) return 4;`, 'size'));
mutate('guard: initialization signer', ALL, 'semantic', ROOT, c => once(c, '    if (!state.signer) return 7;\n', '', 'signer'));
mutate('guard: initialization signer taken from the actor', ANY, 'semantic', ROOT, c =>
  once(c, 'if (!state.signer) return 7;', 'if (!actor.signer) return 7;', 'signer'));
mutate('guard: zero allocation', ANY, 'semantic', ROOT, c =>
  once(c, /    for \(unsigned i = 0; i < \d+; \+\+i\) if \(state\.data\[i\]\) return 4;\n/, '', 'zero'));
mutate('guard: zero allocation one byte short', ANY, 'semantic', ROOT, (c, f) =>
  once(c, /for \(unsigned i = 0; i < \d+; \+\+i\) if \(state\.data\[i\]\) return 4;/,
    `for (unsigned i = 0; i < ${f.interface.stateBytes - 1}; ++i) if (state.data[i]) return 4;`, 'zero'));
mutate('guard: stored header', ANY, 'semantic', ROOT, c =>
  once(c, /    for \(unsigned i = 0; i < 20; \+\+i\) if \(state\.data\[i\] != header\[i\]\) return 4;\n/, '', 'header'));
mutate('guard: stored header one byte short', ANY, 'semantic', ROOT, c =>
  once(c, 'for (unsigned i = 0; i < 20; ++i) if (state.data[i] != header[i]) return 4;',
    'for (unsigned i = 0; i < 19; ++i) if (state.data[i] != header[i]) return 4;', 'header'));
mutate('guard: header constant', ANY, 'semantic', ROOT, c => once(c, 'header[20] = {66,68,83,49,', 'header[20] = {66,68,83,50,', 'header'));
mutate('guard: duplicate key reports success', ANY, 'semantic', IFF, c =>
  once(c, 'accounts[j].key)) return 6;', 'accounts[j].key)) return 0;', 'alias'));
mutate('accounts: last account record not parsed', TWO, 'semantic', 'loader: instruction located after exactly `count` accounts', c =>
  once(c, 'for (unsigned i = 0; i < count; ++i) {', 'for (unsigned i = 0; i + 1 < count; ++i) {', 'accounts'));
mutate('accounts: actor record not parsed', ['pure'], 'semantic', 'uninitialized: read of accounts[1]', c =>
  once(c, 'for (unsigned i = 0; i < count; ++i) {', 'for (unsigned i = 0; i + 1 < count; ++i) {', 'accounts'));
mutate('accounts: count overwritten after the bound check', TWO, 'semantic', 'loader: instruction located after exactly `count` accounts', c =>
  once(c, '  if (count < 4 || count > 12) return 1;\n', '  if (count < 4 || count > 12) return 1;\n  count = 5;\n', 'count'));
mutate('mode: read from the first payload byte', ANY, 'semantic', ROOT, c => once(c, 'if (ix[0] == 0) {', 'if (ix[1] == 0) {', 'mode'));
mutate('instruction: decoded from the mode byte', ANY, 'semantic', ROOT, c => once(c, '_decode(ix + 1,', '_decode(ix + 0,', 'decode'));
// Ignored failures.
mutate('ignored-error: stored state decode', ALL, 'semantic', 'uninitialized: helper output', c => once(c, storedDecode, '$1;', 'decode'));
mutate('ignored-error: empty state decode', ANY, 'semantic', 'uninitialized: helper output', c => once(c, emptyDecode, '$1;', 'decode'));
mutate('ignored-error: instruction decode', ANY, 'semantic', 'uninitialized: helper output', c => once(c, ixDecode, '  $1;\n', 'decode'));
mutate('missing-decode: instruction never decoded', ANY, 'semantic', 'uninitialized: read of instruction', c => once(c, ixDecode, '', 'decode'));
mutate('ignored-error: clock', ALL, 'semantic', 'uninitialized: helper output', c => once(c, clockCheck, '  $1;\n', 'clock'));
mutate('ignored-error: custody setup', TWO, 'semantic', 'uninitialized: helper output', c => once(c, ' if (setup) return setup;', '', 'setup'));
mutate('ignored-error: state encode', ALL, 'semantic', 'uninitialized: helper output', c =>
  once(c, /if \(!(\w+_encode\(encoded, \d+, &outcome\.as\.c\d+\.f0\))\) return 9;/, '$1;', 'encode'));
mutate('ignored-error: effect extraction', TWO, 'semantic', 'effects: slot read without successful extraction', c =>
  once(c, /if \(!(bend_extract_effects\([^;]*\))\) return 9;/, '$1;', 'extract'));
mutate('ignored-error: effect validation', EFFECTS, 'semantic', ORDER, c => once(c, '    if (error) return error;\n', '', 'validate'));
mutate('ignored-error: effect execution', EFFECTS, 'semantic', ORDER, c => once(c, ') return 18;', ') {}', 'execute'));
mutate('ignored-error: unknown outcome tag', ALL, 'semantic', 'union: outcome field read while another variant is active', c =>
  once(c, /  if \(outcome\.tag != \d+\) return 9;\n/, '', 'tag'));
mutate('ignored-error: unknown outcome tag reported as success', ANY, 'semantic', IFF, c =>
  once(c, /if \(outcome\.tag != (\d+)\) return 9;/, 'if (outcome.tag != $1) return 0;', 'tag'));
mutate('ignored-error: rejection treated as unknown outcome', ANY, 'semantic', MAP, c =>
  once(c, /  if \(outcome\.tag == \d+\) \{[\s\S]*?\n  \}\n/, '', 'rejection'));
// Root call discipline.
mutate('root: called twice', ALL, 'semantic', ROOT, c => once(c, rootCall, '$1  outcome = $2;\n', 'root'));
mutate('root: called before the instruction is decoded', ANY, 'semantic', 'uninitialized: read of instruction', c => {
  const line = c.match(ixDecode)![0];
  return once(once(c, ixDecode, '', 'decode'), rootCall, `$1${line}`, 'root');
});
mutate('root: called before the Clock result is checked', ANY, 'semantic', 'uninitialized: helper output', c =>
  once(once(c, clockCheck, '  u64 status = $1;\n', 'clock'), rootCall, '$1  if (status) return 8;\n', 'root'));
// Effect ordering.
mutate('effects: executed before validated', ['token-2','token-3'], 'semantic', ORDER, c =>
  once(c, /(  for \(unsigned i = 0; i < \d+; \+\+i\) \{\n    u64 error[\s\S]*?\n  \}\n)(  for \(unsigned i = 0; i < \d+; \+\+i\) \{\n    if \(bend_transfer_execute[\s\S]*?\n  \}\n)/, '$2$1', 'loops'));
mutate('effects: every slot validates slot 0', EFFECTS, 'semantic', ORDER, c =>
  once(c, '_validate(&transfers[i]', '_validate(&transfers[0]', 'validate'));
mutate('effects: slots validated and executed in one loop', EFFECTS, 'semantic', ORDER, c =>
  once(c, /if \(error\) return error;\s*\}\s*for \(unsigned i = 0; i < \d+; \+\+i\) \{/, 'if (error) return error;', 'loops'));
mutate('effects: last slot not validated', EFFECTS, 'semantic', ORDER, (c, f) =>
  once(c, validateLoop, `for (unsigned i = 0; i < ${slots(f) - 1}; ++i) {$2`, 'validate'));
mutate('effects: first slot not validated', EFFECTS, 'semantic', ORDER, (c, f) =>
  once(c, validateLoop, `for (unsigned i = 1; i < ${slots(f)}; ++i) {$2`, 'validate'));
mutate('effects: last slot not executed', EFFECTS, 'semantic', EXACT, (c, f) =>
  once(c, executeLoop, `for (unsigned i = 0; i < ${slots(f) - 1}; ++i) {$2`, 'execute'));
mutate('effects: first slot not executed', EFFECTS, 'semantic', ORDER, (c, f) =>
  once(c, executeLoop, `for (unsigned i = 1; i < ${slots(f)}; ++i) {$2`, 'execute'));
mutate('effects: every slot executes slot 0', EFFECTS, 'semantic', ORDER, c =>
  once(c, /(bend_\w+_execute\(&transfers\[)i(\],accounts)/, '$10$2', 'execute'));
mutate('effects: validation reads one slot beyond the array', EFFECTS, 'semantic', 'bounds: transfers[', (c, f) =>
  once(c, validateLoop, `for (unsigned i = 0; i < ${slots(f) + 1}; ++i) {$2`, 'validate'));
mutate('effects: effect array one slot short', EFFECTS, 'semantic', 'bounds: ', (c, f) =>
  once(c, /(Bend(?:Transfer|Invoke) transfers\[)\d+\];/, `$1${slots(f) - 1}];`, 'array'));
mutate('effects: validation sees half the accounts', TWO, 'semantic', ORDER, c =>
  once(c, /(_validate\(&transfers\[i\],accounts,)\(unsigned\)count\)/, '$1(unsigned)(count >> 1))', 'validate'));
mutate('effects: execution sees one account too many', TWO, 'semantic', 'helper: receives an account the loader parser did not fill', c =>
  once(c, /(_execute\(&transfers\[i\],accounts,)\(unsigned\)count,/, '$1(unsigned)count + 1u,', 'execute'));
mutate('effects: execution uses an uninitialized bump', TWO, 'semantic', 'uninitialized: read of', c =>
  once(once(c, 'u8 bump;', 'u8 bump; u8 other;', 'bump'), /,bump\)\) return 18;/, ',other)) return 18;', 'execute'));
mutate('cpi: state account may be passed writable', CPI, 'semantic', ORDER, c => once(c, 'return 22;', '{}', 'cpi'));
mutate('cpi: writable-state scan stops one meta early', CPI, 'semantic', ORDER, c => once(c, ' && j<8;', ' && j<7;', 'cpi'));
mutate('cpi: writable-state scan checks account 1', CPI, 'semantic', ORDER, c => once(c, '.index==0 &&', '.index==1 &&', 'cpi'));
mutate('cpi: writable-state scan only on slot 0', CPI, 'semantic', ORDER, c =>
  once(c, 'if (transfers[i].active) for', 'if (i == 0 && transfers[i].active) for', 'cpi'));
mutate('cpi: writable-state scan reads a ninth meta', CPI, 'semantic', 'bounds: metas[8]', c => once(c, ' && j<8;', ' && j<9;', 'cpi'));
// Context construction.
mutate('context: second key word read from offset 0', ANY, 'semantic', ROOT, c => once(c, 'read_le(actor.key + 4, 4)', 'read_le(actor.key + 0, 4)', 'key'));
mutate('context: last key word read from offset 27', ANY, 'semantic', ROOT, c => once(c, 'read_le(actor.key + 28, 4)', 'read_le(actor.key + 27, 4)', 'key'));
mutate('context: last key word read with two bytes', ALL, 'semantic', ROOT, c => once(c, 'read_le(actor.key + 28, 4)', 'read_le(actor.key + 28, 2)', 'key'));
mutate('context: last key word read past the key', ANY, 'semantic', 'bounds: read_le of key bytes', c =>
  once(c, 'read_le(actor.key + 28, 4)', 'read_le(actor.key + 29, 4)', 'key'));
mutate('context: first key word truncated to a byte', ANY, 'semantic', ROOT, c => once(c, '(u32)read_le(actor.key + 0, 4)', '(u8)read_le(actor.key + 0, 4)', 'key'));
mutate('context: key taken from the state account', ANY, 'semantic', ROOT, c => once(c, 'read_le(actor.key + 12, 4)', 'read_le(state.key + 12, 4)', 'key'));
mutate('context: actor is the third account', TWO, 'semantic', ROOT, c => once(c, 'actor = accounts[1];', 'actor = accounts[2];', 'actor'));
mutate('context: signer taken from the state account', ANY, 'semantic', ROOT, c => once(c, /\n    actor\.signer, /, '\n    state.signer, ', 'signer'));
mutate('context: slot high word shifted by 31', ALL, 'semantic', ROOT, c => once(c, '(u32)(clock.slot >> 32)', '(u32)(clock.slot >> 31)', 'slot'));
mutate('context: slot high word repeats the low word', ANY, 'semantic', ROOT, c => once(c, '(u32)(clock.slot >> 32)', '(u32)clock.slot', 'slot'));
mutate('context: slot low word truncated to a byte', ANY, 'semantic', ROOT, c => once(c, '((u32)clock.slot,', '((u8)clock.slot,', 'slot'));
mutate('context: slot shifted after truncation', ANY, 'semantic', 'undefined: shift of a 32-bit value by 32', c =>
  once(c, '(u32)(clock.slot >> 32)', '((u32)clock.slot >> 32)', 'slot'));
// Return mapping.
mutate('return: rejection offset 255', ALL, 'semantic', MAP, c => once(c, '256ULL + code', '255ULL + code', 'map'));
mutate('return: rejection range check dropped', ALL, 'semantic', MAP, c => once(c, 'code <= 0xfffffeffu', 'code <= 0xffffffffu', 'map'));
mutate('return: rejection code truncated to a byte', ANY, 'semantic', MAP, c => once(c, '256ULL + code', '256ULL + (u8)code', 'map'));
mutate('return: out-of-range rejection returns 8', ANY, 'semantic', MAP, c => once(c, '256ULL + code : 9', '256ULL + code : 8', 'map'));
mutate('return: rejection code held in a byte', ANY, 'semantic', MAP, c => once(c, /u32 code = outcome/, 'u8 code = outcome', 'map'));
mutate('return: success reports 1', ANY, 'semantic', IFF, c => once(c, /  return 0;\n\}/, '  return 1;\n}', 'return'));
mutate('return: clock failure reports success', ANY, 'semantic', IFF, c => once(c, /\) return 8;/, ') return 0;', 'clock'));
// Helper codes must be tested and returned in all 64 bits.
mutate('truncated-error: custody setup tested in 32 bits', TWO, 'semantic', 'uninitialized: helper output', c => once(c, 'if (setup) return setup;', 'if ((u32)setup) return setup;', 'setup'));
mutate('truncated-error: custody setup returned in 32 bits', TWO, 'semantic', WIDTH, c => once(c, 'if (setup) return setup;', 'if (setup) return (u32)setup;', 'setup'));
mutate('truncated-error: custody setup stored in 32 bits', TWO, 'semantic', 'uninitialized: helper output', c => once(c, 'u64 setup = ', 'u32 setup = ', 'setup'));
mutate('truncated-error: effect validation tested in 32 bits', EFFECTS, 'semantic', ORDER, c => once(c, 'if (error) return error;', 'if ((u32)error) return error;', 'validate'));
mutate('truncated-error: effect validation returned in 32 bits', EFFECTS, 'semantic', WIDTH, c => once(c, 'if (error) return error;', 'if (error) return (u32)error;', 'validate'));
mutate('truncated-error: effect validation stored in 32 bits', EFFECTS, 'semantic', ORDER, c => once(c, 'u64 error = ', 'u32 error = ', 'validate'));
mutate('truncated-error: effect execution tested in 32 bits', EFFECTS, 'semantic', ORDER, c => once(c, executeCall, 'if ((u32)$1) return 18;', 'execute'));
mutate('truncated-error: clock result tested in 32 bits', ANY, 'semantic', 'uninitialized: helper output', c =>
  once(c, 'if (sol_get_clock_sysvar(&clock)) return 8;', 'if ((u32)sol_get_clock_sysvar(&clock)) return 8;', 'clock'));
mutate('truncated-error: account count narrowed before the bound', TWO, 'semantic', 'bounds: accounts[', c =>
  once(c, 'if (count < 4 || count > 12) return 1;', 'if ((u32)count < 4 || (u32)count > 12) return 1;', 'count'));
// Committed bytes and return data.
mutate('commit: header omitted', ANY, 'semantic', EXACT, c => once(c, headerWrite, '', 'header'));
mutate('commit: payload omitted', ANY, 'semantic', EXACT, c => once(c, payloadWrite, '', 'payload'));
mutate('commit: return data omitted', ANY, 'semantic', EXACT, c => once(c, returnData, '', 'return data'));
mutate('commit: header one byte short', ANY, 'semantic', EXACT, c => once(c, headerWrite, '  __builtin_memcpy(state.data, header, 19);\n', 'header'));
mutate('commit: payload one byte short', ALL, 'semantic', EXACT, (c, f) =>
  once(c, payloadWrite, `  __builtin_memcpy(state.data + 20, encoded, ${n(f) - 1});\n`, 'payload'));
mutate('commit: payload written at offset 19', ANY, 'semantic', EXACT, (c, f) =>
  once(c, payloadWrite, `  __builtin_memcpy(state.data + 19, encoded, ${n(f)});\n`, 'payload'));
mutate('commit: payload written past the account', ANY, 'semantic', 'bounds: state data write within the account size', (c, f) =>
  once(c, payloadWrite, `  __builtin_memcpy(state.data + 21, encoded, ${n(f)});\n`, 'payload'));
mutate('commit: payload written over the header', ANY, 'semantic', EXACT, (c, f) =>
  once(c, payloadWrite, `  __builtin_memcpy(state.data + 20, encoded, ${n(f)});\n  __builtin_memcpy(state.data, encoded, ${Math.min(n(f), 20)});\n`, 'payload'));
mutate('commit: return data one byte short', ALL, 'semantic', EXACT, (c, f) => once(c, returnData, `  sol_set_return_data(encoded, ${n(f) - 1});\n`, 'return data'));
mutate('commit: return data taken from the header', TWO, 'semantic', EXACT, (c, f) => once(c, returnData, `  sol_set_return_data(header, ${n(f)});\n`, 'return data'));
mutate('commit: return data set twice', ANY, 'semantic', EXACT, c => once(c, returnData, m => m + m, 'return data'));
mutate('commit: encoder supplied incorrect length', ANY, 'semantic', IFF, (c, f) =>
  once(c, /(_encode\(encoded, )\d+(, &outcome)/, `$1${n(f) + 1}$2`, 'encode'));
// A change of precedence only: every order-independent claim still holds.
mutate('precedence: writable checked before owner', ALL, 'semantic', PINNED, c =>
  once(c, /(  if \(!equal_key\(state\.owner, program\) \|\| state\.executable\) return 3;\n)(  if \(!state\.writable\) return 5;\n)/, '$2$1', 'guards'),
  undefined, ['claim: pinned-precedence-return-code']);
mutate('precedence: instruction decoded before the state', ANY, 'semantic', 'pinned-precedence', c => {
  const line = c.match(ixDecode)![0], declaration = c.match(/  \S+ instruction;\n/)![0];
  return once(once(once(c, ixDecode, '', 'decode'), declaration, '', 'declaration'), /(  \S+ before;\n)/, `$1${declaration}${line}`, 'before');
}, undefined, ['claim: pinned-precedence-return-code', 'claim: pinned-precedence-event-trace']);
// Text outside the reviewed grammar is refused, not interpreted.
mutate('grammar: direct byte write to the state account', ALL, 'grammar', 'syntax: ', c => once(c, headerDecl, '$1  state.data[0] = 1;\n', 'header'));
mutate('grammar: commit copied from account data', ALL, 'grammar', 'memcpy: source is not a local byte array', c =>
  once(c, headerDecl, '$1  __builtin_memcpy(state.data, state.data + 20, 1);\n', 'header'));
mutate('grammar: write into the actor account', ALL, 'grammar', 'memcpy: destination is not the state account data', c =>
  once(c, headerDecl, '$1  __builtin_memcpy(actor.data, header, 20);\n', 'header'));
mutate('grammar: write through write_le', ALL, 'grammar', 'call to unreviewed function', c =>
  once(c, headerDecl, '$1  write_le(state.data, 0, 4);\n', 'header'));
mutate('grammar: unreviewed syscall', ALL, 'grammar', 'call to unreviewed function', c =>
  once(c, headerDecl, '$1  sol_log_64_(0, 0, 0, 0, 0);\n', 'header'));
mutate('grammar: while loop', ALL, 'grammar', 'syntax: ', c => once(c, headerDecl, '$1  while (count) { return 0; }\n', 'header'));
mutate('grammar: goto', ALL, 'grammar', 'syntax: ', c => once(c, headerDecl, '$1  goto done;\n', 'header'));
mutate('grammar: root call inside a condition', ALL, 'grammar', 'effectful call', c =>
  once(c, rootCall, '$1  if (count > 1 && $2.tag) return 9;\n', 'root'));
mutate('grammar: shadowed state account', ALL, 'grammar', 'redeclared', c =>
  once(c, headerDecl, '$1  { Account state = accounts[1]; if (!state.writable) return 5; }\n', 'header'));
mutate('grammar: function inserted before the entrypoint', ALL, 'grammar', 'syntax: ', c =>
  once(c, 'typedef struct { u64 slot;', 'static u64 extra(void) { return 0; }\ntypedef struct { u64 slot;', 'prelude'));
mutate('grammar: function appended after the entrypoint', ALL, 'grammar', 'text after the entrypoint', c => c + 'static u64 extra(void) { return 0; }\n');
mutate('grammar: helper redefined through a macro-like wrapper', TWO, 'grammar', 'syntax: ', c =>
  once(c, 'typedef struct { u64 slot;', 'static u64 wrapped(u64 x) { return (u32)x; }\ntypedef struct { u64 slot;', 'prelude'));
mutate('grammar: entrypoint attribute changed', ALL, 'grammar', 'Clock declaration or entrypoint header', c =>
  once(c, '__attribute__((visibility("default")))', '__attribute__((visibility("default"), naked))', 'attribute'));
mutate('grammar: Clock layout changed', ALL, 'grammar', 'Clock declaration or entrypoint header', c =>
  once(c, 'typedef struct { u64 slot; long long epoch_start_timestamp;', 'typedef struct { u32 pad; u64 slot; long long epoch_start_timestamp;', 'clock'));
mutate('grammar: effect extraction sets return data', TWO, 'grammar', 'effect extraction: unexpected identifier', c =>
  once(c, /(static inline int bend_extract_effects\([^)]*\) \{\n)/, '$1  sol_set_return_data((const u8 *)value, 1);\n', 'extract'));
mutate('grammar: octal length', ALL, 'grammar', 'octal constant', c => once(c, 'header, 20);', 'header, 020);', 'header'));
// Preprocessing must not be able to hide or rewrite code.
const afterIncludes = (c:string, text:string) => once(c, '#include "solana_min.h"\n', `#include "solana_min.h"\n${text}`, 'includes');
mutate('preprocessor: macro rewrites return', ALL, 'grammar', 'preprocessing: ', c => afterIncludes(c, '#define return return 0;\n'));
mutate('preprocessor: macro disables a guard', ALL, 'grammar', 'preprocessing: ', c => afterIncludes(c, '#define equal_key(a,b) 1\n'));
mutate('preprocessor: conditional removes a guard', ALL, 'grammar', 'preprocessing: ', c =>
  once(c, '  if (!state.writable) return 5;\n', '#if 0\n  if (!state.writable) return 5;\n#endif\n', 'writable'));
mutate('preprocessor: spliced comment swallows a guard', ALL, 'grammar', 'preprocessing: backslash', c =>
  once(c, '  if (!state.writable) return 5;\n', '  // checked below \\\n  if (!state.writable) return 5;\n', 'writable'));
mutate('preprocessor: trigraph splice swallows a guard', ALL, 'grammar', 'preprocessing: trigraph', c =>
  once(c, '  if (!state.writable) return 5;\n', '  // checked below ??/\n  if (!state.writable) return 5;\n', 'writable'));
mutate('preprocessor: digraph directive', ALL, 'grammar', 'preprocessing: ', c => afterIncludes(c, '%:define return return 0;\n'));
mutate('preprocessor: carriage return hides code in a comment', ALL, 'grammar', 'preprocessing: control', c =>
  once(c, '  if (!state.writable) return 5;\n', '  //\r return 0;\n  if (!state.writable) return 5;\n', 'writable'));
mutate('preprocessor: directive after a comment', ALL, 'grammar', 'preprocessing: ', c => afterIncludes(c, '/**/#define return return 0;\n'));
mutate('preprocessor: directive opened inside a comment', ALL, 'grammar', 'preprocessing: ', c =>
  afterIncludes(c, '/*\n#include "solana_min.h"\n*/\n'));
mutate('preprocessor: extra include', ALL, 'grammar', 'preprocessing: includes', c => afterIncludes(c, '#include "cpi_abi.h"\n'));
mutate('preprocessor: include after code', ALL, 'grammar', 'preprocessing: ', c =>
  once(c, '  if (!state.writable) return 5;\n', '#include "solana_min.h"\n  if (!state.writable) return 5;\n', 'writable'));
mutate('preprocessor: pragma operator', ALL, 'grammar', 'syntax: ', c => once(c, headerDecl, '$1  _Pragma("pack(1)")\n', 'header'));
mutate('preprocessor: character literal', ALL, 'grammar', 'lexical: ', c => once(c, 'ix[0] > 1', "ix[0] > '\"'", 'mode'));
mutate('preprocessor: preprocessing number', ALL, 'grammar', 'lexical: ', c => once(c, 'code <= 0xfffffeffu', 'code <= 0xfffffe+1u', 'map'));
mutate('preprocessor: dependency macro rewrites the alias check', ALL, 'grammar', 'preprocessing: dependency macro', c =>
  c + '#define equal_key(a, b) 0\n', 'solana_min.h');
mutate('preprocessor: generated header macro rewrites return', ALL, 'grammar', 'preprocessing: dependency macro', c =>
  c + '#define return return 0;\n', 'wire');
mutate('preprocessor: dependency conditional', ALL, 'grammar', 'unsupported directive', c => c + '#ifdef X\n#endif\n', 'solana_min.h');
mutate('preprocessor: dependency macro hidden by a splice', ALL, 'grammar', 'line splice', c => c + '#def\\\nine return return 0;\n', 'solana_min.h');
mutate('dependency: loader parser accepts alias markers', ALL, 'grammar', 'differs from the reviewed text', c =>
  once(c, 'if (p[0] != 255) return (const u8 *)0;', 'if (p[0] == 0) return (const u8 *)0;', 'read_account'), 'solana_min.h');
mutate('dependency: equal_key always unequal', ALL, 'grammar', 'differs from the reviewed text', c =>
  once(c, 'if (left != right) return 0;', 'if (left == right) return 0;', 'key equality'), 'solana_min.h');
mutate('preprocessor: changed wire include search path', ['pure'], 'grammar', 'preprocessing: includes', (c, f) =>
  once(c, `#include "${f.name}.wire.h"`, `#include <${f.name}.wire.h>`, 'include'));
mutate('preprocessor: changed wire include search path', ['token-2','cpi-2'], 'grammar', 'lexical: unrecognized C token', (c, f) =>
  once(c, `#include "${f.name}.wire.h"`, `#include <${f.name}.wire.h>`, 'include'));
mutate('dependency: read_le drops the high bytes', ALL, 'grammar', 'differs from the reviewed text', c =>
  once(c, 'v |= (u64)p[i] << (8 * i);', 'v |= (u32)p[i] << (8 * i);', 'read_le'), 'solana_min.h');
mutate('dependency: validation helper returns 32 bits', ['token-2'], 'grammar', 'differs from the reviewed text', c =>
  once(c, 'static inline u64 bend_transfer_validate(', 'static inline u32 bend_transfer_validate(', 'validate'), 'token.h');
mutate('dependency: state decoder signature changed', ALL, 'grammar', 'differs from the reviewed text', c =>
  once(c, /(static inline int bend_State(?:_\w+)?_decode\(const unsigned char \*p, unsigned long long n, )/, '$1const ', 'decode'), 'wire');
// Extraction is checked separately from the entrypoint's symbolic summaries.
// These mutate real helper bodies; success must fail closed before interpreting
// the entrypoint. Native differential tests complement this structural gate.
const EXTRACT = ['token-2','token-3','issuance-3','effect-vector-4','cpi-2','cpi-pair'];
const TOKEN_EXTRACT = ['token-2','token-3','issuance-3','effect-vector-4'];
mutate('extraction: missing whole-output zero initialization', EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/\*out\s*=\s*\(Bend(?:Transfer|Invoke)\)\{0\};/, ''));
mutate('extraction: nonzero default fields', EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/(\*out\s*=\s*\(Bend(?:Transfer|Invoke)\)\{)0(\};)/, '$11$2'));
mutate('extraction: fixed-address write', EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/(\*out\s*=\s*\(Bend(?:Transfer|Invoke)\)\{0\};)/, '$1 *(u64 *)0x400000060ULL = 0;'));
mutate('extraction: write beyond the single output object', EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/(\*out\s*=\s*\(Bend(?:Transfer|Invoke)\)\{0\};)/, '$1 (&out[0])[99].active = 1;'));
mutate('extraction: active opcode changed', EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/out->active\s*=\s*1;/, 'out->active = 7;'));
mutate('extraction: first key limb shifted out of bounds', EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/(write_le\(out->(?:mint_key|program_key)\+)0,/, '$132,'));
mutate('extraction: key limb omitted', EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/write_le\(out->(?:mint_key|program_key)\+28,[^;]+;/, ''));
mutate('extraction: key write widened', EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/(write_le\(out->(?:mint_key|program_key)\+0,[^;]+,)\s*4\);/, '$1 8);'));
mutate('extraction: amount high limb shifted by 31', TOKEN_EXTRACT, 'grammar', 'extraction', c =>
  c.replace(' << 32)', ' << 31)'));
mutate('extraction: source uses destination field', TOKEN_EXTRACT, 'grammar', 'extraction', c =>
  c.replace(/(out->source = value->[^;]*\.)f0;/, '$1f1;'));
mutate('extraction: authority constraint removed', TOKEN_EXTRACT, 'grammar', 'extraction', c =>
  c.replace('out->authority <= 1', 'out->authority <= 2'));
mutate('extraction: second slot initialized through first slot', ['token-2','token-3','issuance-3','cpi-2','cpi-pair'], 'grammar', 'extraction', c =>
  c.replace('&out[1]', '&out[0]'));
mutate('extraction: second slot failure ignored', ['token-2','cpi-2','cpi-pair'], 'grammar', 'extraction', c =>
  c.replace(/&&\s*bend_extract_effect\(&value->as\.c0\.f1,&out\[1\]\)/, ''));
mutate('extraction: vector capacity check weakened', ['effect-vector-4'], 'grammar', 'extraction', c =>
  c.replace('value->as.c0.f0 > 4u', 'value->as.c0.f0 > 5u'));
mutate('extraction: vector inactive slot not zeroed', ['effect-vector-4'], 'grammar', 'extraction', c =>
  c.replace('out[3] = (BendTransfer){0};', ''));
mutate('extraction: vector active length uses inclusive bound', ['effect-vector-4'], 'grammar', 'extraction', c =>
  c.replace('3u < value->as.c0.f0', '3u <= value->as.c0.f0'));
mutate('extraction: recipient bound omitted', ['issuance-3','effect-vector-4'], 'grammar', 'extraction', c =>
  c.replace('out->destination_bound <= 1', 'out->destination_bound <= 2'));
mutate('extraction: initialization flag reads mint index', ['issuance-3','effect-vector-4'], 'grammar', 'extraction', c =>
  c.replace(/(out->initialize = value->as\.c\d+\.)f5;/, '$1f1;'));
mutate('extraction: CPI final data word dropped', CPI, 'grammar', 'extraction', c =>
  c.replace(/write_le\(out->data\+60,[^;]+;/, ''));
mutate('extraction: CPI meta index copied from writable', CPI, 'grammar', 'extraction', c =>
  c.replace(/(out->metas\[7\]\.index=value->[^;]*\.)f0;/, '$1f2;'));
mutate('extraction: CPI meta signer copied from writable', CPI, 'grammar', 'extraction', c =>
  c.replace(/(out->metas\[7\]\.signer=value->[^;]*\.)f3;/, '$1f2;'));
mutate('extraction: CPI meta key limb omitted', CPI, 'grammar', 'extraction', c =>
  c.replace(/write_le\(out->metas\[7\]\.key\+28,[^;]+;/, ''));
mutate('extraction: write_le uses wrong byte stride', EXTRACT, 'grammar', 'extraction', c =>
  once(c, 'p[i] = (u8)(v >> (8 * i));', 'p[i] = (u8)(v >> (4 * i));', 'write_le'), 'solana_min.h');
mutate('extraction: token key buffer too short', TOKEN_EXTRACT, 'grammar', 'extraction', c =>
  once(c, 'mint_key[32]', 'mint_key[16]', 'key buffer'), 'token.h');
mutate('extraction: CPI meta array too short', CPI, 'grammar', 'dependencies: bend_cpi.h differs from the reviewed text', c =>
  once(c, 'BendInvokeMeta metas[8]', 'BendInvokeMeta metas[7]', 'meta array'), 'bend_cpi.h');

for (const name of ['token-2','cpi-2']) {
  mutate('extraction: macro changes native field width after its assertion', [name], 'grammar', 'macro replacement must be a single integer literal', c =>
    once(c, '_Static_assert(sizeof(bend_u32) == 4, "Requires 32-bit unsigned int");',
      '_Static_assert(sizeof(bend_u32) == 4, "Requires 32-bit unsigned int");\n#define bend_u32 unsigned long long\n',
      'native scalar width'), `${name}.h`);
}

mutate('extraction: nested native include search path changed', ['token-2','cpi-2'], 'grammar', '.wire.h differs from the reviewed text near', (c, f) =>
  once(c, `#include "${f.name}.h"`, `#include <${f.name}.h>`, 'native include'), 'wire');

// Dependency audits must reject reviewed declarations hidden in dead text.
mutate('dependency decoy: read_le in a macro body', ['pure','token-2'], 'grammar',
  'macro replacement must be a single integer literal', c =>
    once(c, /static inline u64 read_le\([^}]+}/, original =>
      '#define BEND_REVIEWED_READ_LE ' + original.replace(/\s+/g, ' ') + '\n' +
      original.replace('p[i]', 'p[n - 1 - i]'), 'read_le decoy'), 'solana_min.h');
mutate('dependency decoy: Account typedef at block scope', ['pure','token-2'], 'grammar',
  'solana_min.h differs from the reviewed text', c =>
    once(c, /typedef struct \{\s*const u8 \*key;[\s\S]+?} Account;/, original =>
      'static inline void bend_unused_account(void) { ' + original + ' }\n' +
      original.replace('u64 size;', 'u32 size;'), 'Account decoy'), 'solana_min.h');

// A comment is a comment: the guard really is gone, and the model finds it.
mutate('decoy: guard moved into a block comment', ALL, 'semantic', ROOT, c =>
  once(c, '  if (!state.writable) return 5;\n', '  /* if (!state.writable) return 5; */\n', 'writable'));
mutate('decoy: guard follows a line comment', ANY, 'semantic', ROOT, c =>
  once(c, '  if (!state.writable) return 5;\n', '  // if (!state.writable) return 5;\n', 'writable'));
mutate('decoy: string literal holding a comment opener', ALL, 'grammar', 'Clock declaration or entrypoint header', c =>
  once(once(c, '"Clock ABI"', '"Clock ABI /*"', 'string'), '  if (!state.writable) return 5;\n', '  if (!state.writable) return 5; /* */\n', 'writable'));

// Behavior-preserving rewrites must still verify: the comparison is semantic,
// not a comparison of text.
equivalent('32-bit rejection addition cannot wrap below the range check', ANY, c => once(c, '256ULL + code', '256u + code', 'map'));
equivalent('commented-out early commit and return', ANY, c =>
  once(c, headerDecl, '$1  /* __builtin_memcpy(state.data, header, 20); return 0; */ // sol_set_return_data(header, 20);\n', 'header'));
equivalent('initialization decodes the zeroed account payload', ANY, c =>
  once(c, /(_decode\()empty(, \d+, &before\))/, '$1state.data + 20$2', 'decode'));
equivalent('account-count disjuncts exchanged', TWO, c => once(c, 'count < 4 || count > 12', 'count > 12 || count < 4', 'count'));
equivalent('explicit comparisons with zero', TWO, c =>
  once(once(c, 'if (error) return error;', 'if (error != 0) return error;', 'validate'), 'if (setup) return setup;', 'if (setup != 0ULL) return setup;', 'setup'));
equivalent('mode tested as nonzero after the range check', ANY, c => once(c, 'if (ix[0] == 0) {', 'if (!ix[0]) {', 'mode'));
equivalent('account count passed through a byte after the bound check', TWO, c => c.replaceAll('(unsigned)count', '(u8)count'));
equivalent('payload committed before the header', ANY, c =>
  once(c, /(  __builtin_memcpy\(state\.data, header, 20\);\n)(  __builtin_memcpy\(state\.data \+ 20, encoded, \d+\);\n)/, '$2$1', 'commit'));
equivalent('program id located with the checked instruction length', TWO, (c, f) =>
  once(c, 'const u8 *program = ix + length;', `const u8 *program = ix + ${f.interface.instructionBytes};`, 'program'));
equivalent('transition mode tested explicitly', ANY, c =>
  once(c, '  } else {\n    for (unsigned i = 0; i < 20', '  } else if (ix[0] == 1) {\n    for (unsigned i = 0; i < 20', 'mode'));
equivalent('narrowed account-count test followed by a full-width test', TWO, c =>
  once(c, 'if (count < 4 || count > 12) return 1;', 'if ((u32)count < 4 || (u32)count > 12) return 1; if (count > 12) return 1;', 'count'));
equivalent('reflowed whitespace', ANY, c => c.replace(/\n  (?=\S)/g, '\n\t').replace(/ == /g, '=='));

// Dependency signatures must retain the exact size-selected decoder storage.
mutate('codec annotation: wrong instruction decoder storage', ALL, 'grammar',
  '.wire.h differs from the reviewed text near', (c, f) => {
    const name = f.files[f.adapter].match(/if \(!(\w+_decode)\(ix \+ 1,/)! [1];
    const outlined = `static __attribute__((noinline)) inline int ${name}(`;
    const inline = `static inline int ${name}(`;
    return c.includes(outlined) ? once(c, outlined, inline, name) : once(c, inline, outlined, name);
  }, 'wire');
mutate('codec annotation: unknown instruction decoder attribute', ['cpi-2'], 'grammar',
  'dependencies: cpi-2.wire.h: unsupported attribute', (c, f) => {
    const name = f.files[f.adapter].match(/if \(!(\w+_decode)\(ix \+ 1,/)! [1];
    return once(c, `static __attribute__((noinline)) inline int ${name}(`,
      `static __attribute__((always_inline)) inline int ${name}(`, name);
  }, 'wire');

const payload = `${directory}/inputs.json`;
fs.writeFileSync(payload, JSON.stringify({fixtures, mutations, equivalents}));
// Bind the run to the files present before invoking either checker. A live
// edit must fail publication instead of being hashed as though it was tested.
const expectedInputHashes = Object.fromEntries([...new Set([...inputs, payload,
  'verification/check-adapter-contract.ts', 'verification/adapter_contract.py',
  'verification/adapter_contract_c.py', 'verification/adapter_contract_sym.py',
  'verification/effect_extraction.py', 'verification/effect_extraction_probes.py', 'tests/adapter-interpreter.py',
  'compiler/storage.ts', 'compiler/effects.ts', 'compiler/cpi-effects.ts', 'compiler/codecs.ts', 'compiler/schema.ts',
  'compiler/backend.ts', 'compiler/tagged-sum-ir.ts', 'compiler/artifacts.ts', 'docs/adapter-assurance.md'])]
  .map(file => [path.relative(process.cwd(), path.resolve(file)), hash(file)]).sort());
const extractionProbePath = `${directory}/extraction-probes.json`;
const extractionProbes = spawnSync(process.env.PYTHON ?? 'python3',
  ['-B', 'verification/effect_extraction_probes.py', payload, extractionProbePath],
  {encoding:'utf8', timeout:120_000});
assert.ifError(extractionProbes.error);
assert.equal(extractionProbes.status, 0, extractionProbes.stderr || extractionProbes.stdout);
const extractionProbeReport = JSON.parse(fs.readFileSync(extractionProbePath, 'utf8'));
assert.deepEqual(extractionProbeReport.totals, {fixtures:12, equivalents:9, negatives:148, syntheticVectors:2});
const started = Date.now();
const result = spawnSync(process.env.PYTHON ?? 'python3', ['-B', 'verification/adapter_contract.py', payload, pendingPath],
  {encoding:'utf8', maxBuffer:1 << 26, timeout:3_600_000});
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr || result.stdout);
// Validate the report before publishing it; nothing below trusts a summary flag alone.
const report = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
assert.equal(report.passed, true);
assert.equal(report.z3, '5.1.0');
assert.deepEqual(report.fixtures.map((f:any) => f.fixture), selections.map(s => s[0]));
for (const f of report.fixtures) {
  const written = fixture(f.fixture);
  assert.equal(f.adapterSha256, crypto.createHash('sha256').update(written.files[written.adapter]).digest('hex'));
  assert(f.claims.length === 10 && f.claims.every((c:any) => c.result === 'unsat'), `${f.fixture}: claims`);
  assert(f.witnesses.length > 0 && f.witnesses.every((w:any) => w.result === 'sat'), `${f.fixture}: witnesses`);
  assert(f.negativeModels.length > 0 && f.negativeModels.every((m:any) => m.result === 'sat' && m.counterexample), `${f.fixture}: negative models`);
  assert.equal(f.effectSlots, slots(written));
  assert.equal(f.extraction.passed, true);
  assert.equal(f.extraction.kind, written.interface.effects);
  assert.equal(f.extraction.adapterSha256, f.adapterSha256);
  if (f.effectSlots) {
    assert.equal(f.extraction.extraction, 'checked');
    assert.equal(f.extraction.plural.slots, f.effectSlots);
    assert(f.extraction.single.paths > 0 && f.extraction.plural.paths > 0);
    for (const name of f.extraction.dependencies.includeClosure) {
      assert.equal(f.extraction.dependencies.sha256[name],
        crypto.createHash('sha256').update(written.files[name]).digest('hex'));
    }
  } else assert.equal(f.extraction.extraction, 'none');
}
assert.equal(report.mutations.length, mutations.length);
report.mutations.forEach((m:any, i:number) => {
  const expected = mutations[i];
  assert(m.name === expected.name && m.fixture === expected.fixture && m.kind === expected.kind, `mutation ${expected.name}`);
  const reasons = [m.reason, ...(m.failed ?? [])];
  assert(reasons.some((r:string) => r.includes(expected.expected!)), `mutation ${expected.name}: ${reasons}`);
  if (expected.exactly) assert.deepEqual(m.failed, expected.exactly, `mutation ${expected.name}`);
  if (m.kind === 'semantic') assert(m.counterexample && Object.keys(m.counterexample).length, `mutation ${expected.name}: no counterexample`);
});
assert.deepEqual(report.equivalentVariants.map((e:any) => [e.name, e.fixture]), equivalents.map(e => [e.name, e.fixture]));
assert.equal(report.totals.mutations, report.totals.grammarRejections + report.totals.semanticRejections);
report.recorded = recorded;
report.extractionCheckerTests = {path:extractionProbePath, sha256:hash(extractionProbePath), totals:extractionProbeReport.totals};
for (const [file, digest] of Object.entries(expectedInputHashes)) {
  assert.equal(hash(file), digest, `input changed while checking: ${file}`);
  if (file in report.inputs) assert.equal(report.inputs[file], digest, `child input hash: ${file}`);
}
assert.equal(hash('verification/check-adapter-contract.ts'), driverHashAtStart, 'driver changed while checking');
report.inputs = {...report.inputs, ...expectedInputHashes};
report.toolchain = {bun:process.versions.bun,
  bend:spawnSync('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD'], {encoding:'utf8'}).stdout.trim()};
report.seconds = Math.round((Date.now() - started) / 1000);
fs.writeFileSync(pendingPath, JSON.stringify(report, null, 2) + '\n');
fs.renameSync(pendingPath, reportPath);
process.stdout.write(result.stdout);
console.log(`Report: ${reportPath}`);
