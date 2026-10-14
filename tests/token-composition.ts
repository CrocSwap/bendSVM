import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Backend, checkedProgram } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import type { RuntimeSchema } from '../compiler/schema.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';

/*
 * Native composition gate: compile the complete generated program.c and call
 * its real Solana adapter entrypoint with loader-format accounts and wire
 * instructions. The actual generated codecs, root, custody setup, extraction,
 * runtime/token.h validation, execution and commit all run under ASan/UBSan.
 *
 * The oracle below is derived from the abstract effect/account contract. It
 * never reads generated C or runtime output to make expectations. Only
 * syscalls are mocked: PDA derivation, invoke_signed, Clock and return data.
 * This is finite host-native integration evidence. It does not establish
 * formal correctness, token-program semantics, SBF behavior or transaction
 * rollback. CPI mocks do not mutate token state between effect slots.
 */

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'build/token-composition-native');
const SOURCE = path.join(OUT, 'fixtures/token-composition.bend');
const HARNESS = 'tests/token-composition-harness.h';
const PREFIX = Buffer.from([0x62, 0x65, 0x6e, 0x64]);
const TOKEN_ID = Buffer.from([6,221,246,225,215,101,161,147,217,203,225,70,206,235,121,172,
  28,180,133,237,95,91,55,145,58,140,245,133,126,255,0,169]);
// Fixed conformance vector for this fixture's State{count: U32} storage ABI.
// Checked against the schema-derived header separately; the oracle does not
// obtain its expected bytes from generated C.
const FIXTURE_STATE_HEADER = Buffer.from([66,68,83,49,221,125,178,182,92,106,193,102,
  210,115,173,108,109,11,159,128]);
const U64_MAX = (1n << 64n) - 1n;
const FLAGS = ['-std=c11', '-O1', '-g', '-fno-omit-frame-pointer', '-fsanitize=address,undefined',
  '-fno-sanitize-recover=all', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function'];
const ASAN_ENV = { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1:allocator_may_return_null=0',
  UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };

type Recipient = { kind: 'actor' | 'custody' } | { kind: 'explicit'; key: Buffer };
type Transfer = { kind: 'Transfer' | 'BoundTransfer'; source: number; destination: number; mint: number; mintKey: Buffer;
  recipient: Recipient; authority: 'actor' | 'custody'; amount: bigint; sourceKey?: Buffer; destinationKey?: Buffer; fresh?: boolean };
type Effect = { kind: 'None' }
  | { kind: 'CheckMint'; mint: number; mintKey: Buffer }
  | Transfer
  | { kind: 'Mint'; destination: number; mint: number; mintKey: Buffer; recipient: Recipient; amount: bigint; initialize: boolean }
  | { kind: 'Burn'; source: number; mint: number; mintKey: Buffer; amount: bigint };
type Account = { key: Buffer; owner: Buffer; data: Buffer; size: bigint; lamports: bigint; rentEpoch: bigint;
  signer: number; writable: number; executable: number };
type Scenario = { id: number; name: string; mode: number; rootReject?: number;
  effects: [Effect, Effect, Effect]; accounts: Account[];
  program: Buffer; pdaKey: Buffer; pdaBump: number; pdaError: bigint; invokeError: bigint };
type BendValue = number | boolean | { c: string; f?: Record<string, BendValue> };

const sha = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const dec = (n: bigint) => n.toString(10);
const key = (tag: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (tag * 43 + i * 17 + Math.floor(i / 8) * 29) & 255));
const clone = (b: Buffer) => Buffer.from(b);
const same = (a: Buffer, b: Buffer) => a.equals(b);
const ZERO_KEY = Buffer.alloc(32);
const EXPLICIT = key(220);
const PROGRAM_ID = key(200);
const isExecutable = (e: Effect) => e.kind === 'Transfer' || e.kind === 'BoundTransfer' || e.kind === 'Mint' || e.kind === 'Burn';

function putLe(b: Buffer, at: number, value: bigint | number, n: number) {
  let v = typeof value === 'bigint' ? value : BigInt(value >>> 0);
  for (let i = 0; i < n; ++i) { b[at + i] = Number(v & 255n); v >>= 8n; }
}
function getLe(b: Buffer, at: number, n: number): bigint {
  let v = 0n;
  for (let i = 0; i < n; ++i) v |= BigInt(b[at + i]) << BigInt(i * 8);
  return v;
}
function accountSet(accounts: Account[], index: number, options: Partial<Account> & { tokenOwner?: Buffer; mintKey?: Buffer;
  amount?: bigint; delegateOption?: number; closeOption?: number; state?: number }) {
  const a = accounts[index];
  if (options.key) a.key = clone(options.key);
  if (options.owner) a.owner = clone(options.owner);
  if (options.size !== undefined) a.size = options.size;
  if (options.lamports !== undefined) a.lamports = options.lamports;
  if (options.rentEpoch !== undefined) a.rentEpoch = options.rentEpoch;
  if (options.signer !== undefined) a.signer = options.signer;
  if (options.writable !== undefined) a.writable = options.writable;
  if (options.executable !== undefined) a.executable = options.executable;
  if (options.tokenOwner || options.mintKey || options.amount !== undefined || options.state !== undefined ||
      options.delegateOption !== undefined || options.closeOption !== undefined) {
    a.data.fill(0);
    (options.mintKey ?? accounts[6].key).copy(a.data, 0);
    (options.tokenOwner ?? accounts[1].key).copy(a.data, 32);
    putLe(a.data, 64, options.amount ?? 123n, 8);
    putLe(a.data, 72, options.delegateOption ?? 0, 4);
    a.data[108] = options.state ?? 1;
    putLe(a.data, 109, 0, 4);
    putLe(a.data, 129, options.closeOption ?? 0, 4);
  }
}
function setMint(accounts: Account[], supply: bigint) {
  const a = accounts[6];
  a.owner = clone(TOKEN_ID); a.size = 82n; a.writable = 1; a.executable = 0; a.data.fill(0);
  putLe(a.data, 0, 1, 4); accounts[3].key.copy(a.data, 4); putLe(a.data, 36, supply, 8);
  a.data[44] = 9; a.data[45] = 1; putLe(a.data, 46, 0, 4);
}
function newAccounts(): Account[] {
  const accounts = Array.from({ length: 8 }, (_, i): Account => ({ key: key(i + 1), owner: key(60 + i),
    data: Buffer.alloc(165), size: 165n, lamports: 101n + BigInt(i) * 1009n, rentEpoch: 700n + BigInt(i) * 31n,
    signer: i === 1 ? 1 : 0, writable: i === 1 ? 0 : 1, executable: 0 }));
  accounts[0].owner = clone(PROGRAM_ID); accounts[0].size = 25n; accounts[0].signer = 1; accounts[0].writable = 1;
  accounts[2].key = clone(TOKEN_ID); accounts[2].executable = 1;
  accounts[3].writable = 0;
  setMint(accounts, 37n);
  for (const i of [4, 5, 7]) accountSet(accounts, i, { owner: clone(TOKEN_ID), tokenOwner: accounts[1].key });
  return accounts;
}
function scenario(name: string, effects: [Effect, Effect, Effect], prepare: (a: Account[]) => void = () => {}): Scenario {
  const accounts = newAccounts(); prepare(accounts);
  return { id: -1, name, mode: 0, effects, accounts, program: clone(PROGRAM_ID), pdaKey: clone(accounts[3].key),
    pdaBump: 0, pdaError: 0n, invokeError: 0n };
}
const mintKey = (a: Account[]) => clone(a[6].key);
const none = (): Effect => ({ kind: 'None' });
const checkMint = (a: Account[]): Effect => ({ kind: 'CheckMint', mint: 6, mintKey: mintKey(a) });
function transfer(a: Account[], options: Partial<Omit<Transfer, 'kind' | 'mintKey'>> & { kind?: 'Transfer' | 'BoundTransfer' } = {}): Transfer {
  return { kind: options.kind ?? 'Transfer', source: options.source ?? 4, destination: options.destination ?? 5, mint: 6,
    mintKey: mintKey(a), recipient: options.recipient ?? { kind: 'actor' }, authority: options.authority ?? 'actor',
    amount: options.amount ?? 0x1_0000_0005n, ...(options.sourceKey ? { sourceKey: clone(options.sourceKey) } : {}),
    ...(options.destinationKey ? { destinationKey: clone(options.destinationKey) } : {}), ...(options.fresh ? { fresh: true } : {}) };
}
function makeScenarios(): Scenario[] {
  const out: Scenario[] = [];
  out.push(scenario('none-checkmint-no-cpi', [none(), { kind: 'CheckMint', mint: 6, mintKey: mintKey(newAccounts()) }, none()]));

  const all = scenario('transfer-mint-burn-full-u64', [none(), none(), none()]);
  const allMint = mintKey(all.accounts);
  all.effects = [
    { kind: 'Transfer', source: 4, destination: 5, mint: 6, mintKey: allMint,
      recipient: { kind: 'explicit', key: clone(EXPLICIT) }, authority: 'actor', amount: U64_MAX },
    { kind: 'Mint', destination: 7, mint: 6, mintKey: clone(allMint), recipient: { kind: 'explicit', key: clone(EXPLICIT) },
      amount: 0x0123456789abcdefn, initialize: true },
    { kind: 'Burn', source: 4, mint: 6, mintKey: clone(allMint), amount: 0x8000000000000001n },
  ];
  accountSet(all.accounts, 4, { tokenOwner: all.accounts[1].key });
  accountSet(all.accounts, 5, { tokenOwner: EXPLICIT }); accountSet(all.accounts, 7, { tokenOwner: EXPLICIT });
  setMint(all.accounts, 0n); out.push(all);

  const fresh = scenario('bound-transfer-fresh-custody', [none(), none(), none()]);
  fresh.effects = [transfer(fresh.accounts, { kind: 'BoundTransfer', authority: 'custody', recipient: { kind: 'custody' },
    sourceKey: fresh.accounts[4].key, destinationKey: fresh.accounts[5].key, fresh: true, amount: 0x100000000000001n }), none(), none()];
  accountSet(fresh.accounts, 4, { tokenOwner: fresh.accounts[3].key });
  accountSet(fresh.accounts, 5, { tokenOwner: fresh.accounts[3].key, amount: 0n, delegateOption: 0, closeOption: 0 });
  out.push(fresh);

  const actor = scenario('transfer-recipient-actor-custody-authority', [none(), none(), none()]);
  actor.effects = [transfer(actor.accounts, { authority: 'custody', recipient: { kind: 'actor' }, amount: 0x100000000n }), none(), none()];
  accountSet(actor.accounts, 4, { tokenOwner: actor.accounts[3].key });
  accountSet(actor.accounts, 5, { tokenOwner: actor.accounts[1].key }); out.push(actor);

  const custody = scenario('transfer-recipient-custody', [none(), none(), none()]);
  custody.effects = [transfer(custody.accounts, { authority: 'custody', recipient: { kind: 'custody' }, amount: 7n }), none(), none()];
  accountSet(custody.accounts, 4, { tokenOwner: custody.accounts[3].key });
  accountSet(custody.accounts, 5, { tokenOwner: custody.accounts[3].key }); out.push(custody);

  const sourceOwner = scenario('transfer-reject-source-owner', [none(), none(), none()]);
  sourceOwner.effects = [transfer(sourceOwner.accounts), none(), none()];
  accountSet(sourceOwner.accounts, 4, { owner: key(222) }); out.push(sourceOwner);

  const sourceExecutable = scenario('transfer-reject-source-executable', [none(), none(), none()]);
  sourceExecutable.effects = [transfer(sourceExecutable.accounts), none(), none()];
  accountSet(sourceExecutable.accounts, 4, { executable: 1 }); out.push(sourceExecutable);

  const tokenState = scenario('transfer-reject-token-state', [none(), none(), none()]);
  tokenState.effects = [transfer(tokenState.accounts), none(), none()];
  accountSet(tokenState.accounts, 4, { state: 0 }); out.push(tokenState);

  const mintOwner = scenario('transfer-reject-mint-owner', [none(), none(), none()]);
  mintOwner.effects = [transfer(mintOwner.accounts), none(), none()];
  mintOwner.accounts[6].owner = key(222); out.push(mintOwner);

  const mintExecutable = scenario('transfer-reject-mint-executable', [none(), none(), none()]);
  mintExecutable.effects = [transfer(mintExecutable.accounts), none(), none()];
  mintExecutable.accounts[6].executable = 1; out.push(mintExecutable);

  const mintState = scenario('transfer-reject-mint-state', [none(), none(), none()]);
  mintState.effects = [transfer(mintState.accounts), none(), none()];
  mintState.accounts[6].data[45] = 0; out.push(mintState);

  const tokenMint = scenario('transfer-reject-token-mint-binding', [none(), none(), none()]);
  tokenMint.effects = [transfer(tokenMint.accounts), none(), none()];
  accountSet(tokenMint.accounts, 4, { mintKey: key(223) }); out.push(tokenMint);

  const effectMint = scenario('transfer-reject-effect-mint-key', [none(), none(), none()]);
  const wrongEffectMint = transfer(effectMint.accounts); wrongEffectMint.mintKey = key(224);
  effectMint.effects = [wrongEffectMint, none(), none()]; out.push(effectMint);

  const rejectOwner = scenario('reject-last-validation-before-any-execution', [none(), none(), none()]);
  rejectOwner.effects = [transfer(rejectOwner.accounts), checkMint(rejectOwner.accounts),
    transfer(rejectOwner.accounts, { destination: 7, recipient: { kind: 'actor' } })];
  accountSet(rejectOwner.accounts, 4, { tokenOwner: rejectOwner.accounts[1].key });
  accountSet(rejectOwner.accounts, 5, { tokenOwner: rejectOwner.accounts[1].key });
  accountSet(rejectOwner.accounts, 7, { tokenOwner: EXPLICIT }); out.push(rejectOwner);

  const rejectIndex = scenario('reject-abstract-index-before-execution', [none(), none(), none()]);
  rejectIndex.effects = [transfer(rejectIndex.accounts, { destination: 99 }), none(), none()]; out.push(rejectIndex);

  const wrongAuthority = scenario('transfer-source-authority-missing', [transfer(newAccounts()), none(), none()]);
  accountSet(wrongAuthority.accounts, 4, { tokenOwner: EXPLICIT }); out.push(wrongAuthority);

  const wrongCustodyAuthority = scenario('transfer-custody-authority-missing', [none(), none(), none()]);
  wrongCustodyAuthority.effects = [transfer(wrongCustodyAuthority.accounts, { authority: 'custody' }), none(), none()];
  out.push(wrongCustodyAuthority);

  const missingSigner = scenario('transfer-actor-authority-without-signer', [none(), none(), none()]);
  missingSigner.effects = [transfer(missingSigner.accounts), none(), none()];
  missingSigner.accounts[1].signer = 0; out.push(missingSigner);

  const readonlySource = scenario('transfer-readonly-source', [none(), none(), none()]);
  readonlySource.effects = [transfer(readonlySource.accounts), none(), none()];
  readonlySource.accounts[4].writable = 0; out.push(readonlySource);

  const badBinding = scenario('bound-transfer-wrong-source-binding', [none(), none(), none()]);
  badBinding.effects = [transfer(badBinding.accounts, { kind: 'BoundTransfer', sourceKey: EXPLICIT }), none(), none()];
  out.push(badBinding);

  const staleFresh = scenario('bound-transfer-fresh-destination-not-empty', [none(), none(), none()]);
  staleFresh.effects = [transfer(staleFresh.accounts, { kind: 'BoundTransfer', authority: 'custody',
    recipient: { kind: 'custody' }, sourceKey: staleFresh.accounts[4].key,
    destinationKey: staleFresh.accounts[5].key, fresh: true }), none(), none()];
  accountSet(staleFresh.accounts, 4, { tokenOwner: staleFresh.accounts[3].key });
  accountSet(staleFresh.accounts, 5, { tokenOwner: staleFresh.accounts[3].key, amount: 3n }); out.push(staleFresh);

  const mintSupply = scenario('mint-initialize-requires-zero-supply', [none(), none(), none()]);
  mintSupply.effects = [{ kind: 'Mint', destination: 7, mint: 6, mintKey: mintKey(mintSupply.accounts),
    recipient: { kind: 'explicit', key: clone(EXPLICIT) }, amount: 5n, initialize: true }, none(), none()];
  accountSet(mintSupply.accounts, 7, { tokenOwner: EXPLICIT }); setMint(mintSupply.accounts, 1n); out.push(mintSupply);

  const mintAuthority = scenario('mint-requires-custody-mint-authority', [none(), none(), none()]);
  mintAuthority.effects = [{ kind: 'Mint', destination: 7, mint: 6, mintKey: mintKey(mintAuthority.accounts),
    recipient: { kind: 'explicit', key: clone(EXPLICIT) }, amount: 5n, initialize: false }, none(), none()];
  accountSet(mintAuthority.accounts, 7, { tokenOwner: EXPLICIT });
  mintAuthority.accounts[1].key.copy(mintAuthority.accounts[6].data, 4); out.push(mintAuthority);

  const burnSigner = scenario('burn-owner-requires-actor-signer', [none(), none(), none()]);
  burnSigner.effects = [{ kind: 'Burn', source: 4, mint: 6, mintKey: mintKey(burnSigner.accounts), amount: 5n }, none(), none()];
  burnSigner.accounts[1].signer = 0; out.push(burnSigner);

  const badTokenProgram = scenario('custody-rejects-wrong-token-program', [none(), none(), none()]);
  badTokenProgram.accounts[2].key = key(220); out.push(badTokenProgram);

  const nonExecutableTokenProgram = scenario('custody-rejects-nonexecutable-token-program', [none(), none(), none()]);
  nonExecutableTokenProgram.accounts[2].executable = 0; out.push(nonExecutableTokenProgram);

  const custodyMismatch = scenario('custody-pda-key-mismatch', [none(), none(), none()]);
  custodyMismatch.pdaKey = key(221); out.push(custodyMismatch);

  const pdaFailure = scenario('custody-pda-syscall-failure', [none(), none(), none()]);
  pdaFailure.pdaError = 123n; out.push(pdaFailure);

  const invokeFailure = scenario('token-cpi-syscall-failure', [none(), none(), none()]);
  invokeFailure.effects = [transfer(invokeFailure.accounts), none(), none()];
  invokeFailure.invokeError = 77n; out.push(invokeFailure);

  const rootRejected = scenario('root-rejected-outcome', [none(), none(), none()]);
  rootRejected.rootReject = 42; out.push(rootRejected);

  const transitionHeader = scenario('transition-rejects-missing-state-header', [none(), none(), none()]);
  transitionHeader.mode = 1; out.push(transitionHeader);

  const invalidMode = scenario('rejects-invalid-instruction-mode', [none(), none(), none()]);
  invalidMode.mode = 2; out.push(invalidMode);

  for (const count of [17, 0xffffffff]) {
    const transition = scenario(`transition-count-${count}`, [none(), none(), none()]);
    transition.mode = 1;
    transition.accounts[0].signer = 0; // Existing state does not require init authorization.
    FIXTURE_STATE_HEADER.copy(transition.accounts[0].data);
    transition.accounts[0].data[20] = 0;
    transition.accounts[0].data.writeUInt32LE(count, 21);
    out.push(transition);
  }
  const stateCases: [string, (a: Account) => void][] = [
    ['owner', a => a.owner = key(240)],
    ['executable', a => a.executable = 1],
    ['writable', a => a.writable = 0],
    ['init-signer', a => a.signer = 0],
    ['init-nonzero', a => a.data[24] = 1],
    ['init-dirty-header', a => a.data[0] = 1],
    ['short-size', a => a.size = 24n],
    ['long-size', a => a.size = 26n],
  ];
  for (const [name, edit] of stateCases) {
    const invalid = scenario(`state-reject-${name}`, [none(), none(), none()]);
    edit(invalid.accounts[0]); out.push(invalid);
  }
  const wrongSchema = scenario('state-reject-wrong-schema-hash', [none(), none(), none()]);
  wrongSchema.mode=1; FIXTURE_STATE_HEADER.copy(wrongSchema.accounts[0].data);
  wrongSchema.accounts[0].data[7]^=1; out.push(wrongSchema);
  const invalidTag = scenario('state-reject-noncanonical-transition', [none(), none(), none()]);
  invalidTag.mode = 1; FIXTURE_STATE_HEADER.copy(invalidTag.accounts[0].data);
  invalidTag.accounts[0].data[20] = 1; out.push(invalidTag);

  return out.map((x, id) => ({ ...x, id, pdaBump: (0xA7 + id * 19) & 0xff }));
}
const SCENARIOS = makeScenarios();

function effectDescription(e: Effect): unknown {
  const recipient = (r: Recipient) => r.kind === 'explicit' ? { kind: r.kind, key: hex(r.key) } : { kind: r.kind };
  switch (e.kind) {
    case 'None': return { kind: e.kind };
    case 'CheckMint': return { kind: e.kind, mint: e.mint, mintKey: hex(e.mintKey) };
    case 'Transfer': case 'BoundTransfer': return { kind: e.kind, source: e.source, destination: e.destination, mint: e.mint,
      mintKey: hex(e.mintKey), recipient: recipient(e.recipient), authority: e.authority, amount: dec(e.amount),
      sourceKey: e.sourceKey ? hex(e.sourceKey) : null, destinationKey: e.destinationKey ? hex(e.destinationKey) : null,
      fresh: !!e.fresh };
    case 'Mint': return { kind: e.kind, destination: e.destination, mint: e.mint, mintKey: hex(e.mintKey),
      recipient: recipient(e.recipient), amount: dec(e.amount), initialize: e.initialize };
    case 'Burn': return { kind: e.kind, source: e.source, mint: e.mint, mintKey: hex(e.mintKey), amount: dec(e.amount) };
  }
}

// ---- Generated Bend input values ------------------------------------------
function keyValue(k: Buffer): BendValue {
  return { c: 'Key', f: Object.fromEntries('abcdefgh'.split('').map((n, i) => [n, k.readUInt32LE(i * 4)])) };
}
function amountValue(a: bigint): BendValue {
  return { c: 'U64', f: { lo: Number(a & 0xffffffffn), hi: Number((a >> 32n) & 0xffffffffn) } };
}
function recipientValue(r: Recipient): BendValue {
  if (r.kind === 'explicit') return { c: 'ToOwner', f: { key: keyValue(r.key) } };
  return { c: r.kind === 'actor' ? 'ToActor' : 'ToCustody' };
}
function transferValue(e: Transfer): Record<string, BendValue> {
  return { source: e.source, destination: e.destination, mint: e.mint, mint_key: keyValue(e.mintKey),
    recipient: recipientValue(e.recipient), amount: amountValue(e.amount), authority: { c: e.authority === 'actor' ? 'Actor' : 'Custody' } };
}
function effectValue(e: Effect): BendValue {
  switch (e.kind) {
    case 'None': return { c: 'None' };
    case 'CheckMint': return { c: 'CheckMint', f: { mint: e.mint, mint_key: keyValue(e.mintKey) } };
    case 'Transfer': return { c: 'Transfer', f: transferValue(e) };
    case 'BoundTransfer': return { c: 'BoundTransfer', f: { transfer: { c: 'TransferDetails', f: transferValue(e) },
      source: e.sourceKey ? { c: 'Exact', f: { key: keyValue(e.sourceKey) } } : { c: 'Any' },
      destination: e.destinationKey ? { c: 'Exact', f: { key: keyValue(e.destinationKey) } } : { c: 'Any' },
      fresh_destination: !!e.fresh } };
    case 'Mint': return { c: 'Mint', f: { destination: e.destination, mint: e.mint, mint_key: keyValue(e.mintKey),
      recipient: recipientValue(e.recipient), amount: amountValue(e.amount), initialize: e.initialize } };
    case 'Burn': return { c: 'Burn', f: { source: e.source, mint: e.mint, mint_key: keyValue(e.mintKey), amount: amountValue(e.amount) } };
  }
}
function short(v: { name: string; sourceName?: string }) { return (v.sourceName ?? v.name).split('.').at(-1)!; }
function adt(schema: RuntimeSchema, name: string) {
  const t = schema.types.find(x => x.name === name);
  assert(t?.kind === 'adt', `expected generated Bend data type ${name}`); return t;
}
function wireValue(schema: RuntimeSchema, type: string, value: BendValue): WireValue {
  const t = schema.types.find(x => x.name === type); assert(t, `unknown generated Bend type ${type}`);
  if (t.kind !== 'adt') {
    assert(typeof value !== 'object', `expected scalar wire value for ${type}`);
    return value as WireValue;
  }
  assert(typeof value === 'object', `expected constructor wire value for ${type}`);
  const variant = t.variants.find(v => short(v) === value.c); assert(variant, `missing ${value.c} variant in ${type}`);
  const fields = value.f ?? {};
  assert.deepEqual(Object.keys(fields).sort(), variant.fields.map(f => f.name).sort(), `${value.c} fields`);
  return { constructor: variant.name, fields: Object.fromEntries(variant.fields.map(f =>
    [f.name, wireValue(schema, f.type, fields[f.name])])) };
}
function instructionValue(s: Scenario): BendValue {
  if (s.rootReject !== undefined) return { c: 'Reject', f: { code: s.rootReject } };
  return { c: 'Run', f: { effects: { c: 'Effects', f: { first: effectValue(s.effects[0]),
    second: effectValue(s.effects[1]), third: effectValue(s.effects[2]) } } } };
}
function fixtureSource() {
  return `import ../../../sdk/context.bend as Sol
import ../../../sdk/issuance.bend as Token

type State is Data:
  State{count: U32}

type Instruction is Data:
  Run{effects: Token.Effects}
  Reject{code: U32}

type Outcome is Data:
  Accepted{state: State, effects: Token.Effects}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state instruction:
    case State{count} Run{effects}:
      Accepted{State{U32.add(count, 1)}, effects}
    case State{count} Reject{code}:
      Rejected{code}
`;
}

function schemaDerivedStorageHeader(schema: RuntimeSchema, state: string): Buffer {
  const types = new Map(schema.types.map(t => [t.name, t]));
  const reachable = new Map<string, unknown>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    const type = types.get(name); assert(type, `missing state-reachable schema type ${name}`);
    reachable.set(name, type.kind === 'adt' ? { name, kind: type.kind,
      variants: type.variants.map(v => ({ name: v.name, tag: v.tag, fields: v.fields })) }
      : { name, kind: type.kind, ...(type.max === undefined ? {} : { max: type.max }) });
    if (type.kind === 'adt') type.variants.forEach(v => v.fields.forEach(f => visit(f.type)));
  };
  visit(state);
  const digest = crypto.createHash('sha256').update(JSON.stringify([...reachable.values()])).digest();
  return Buffer.from([66, 68, 83, 49, ...digest.subarray(0, 16)]);
}

// ---- Abstract contract oracle ---------------------------------------------
function transferHeader(e: Effect) {
  const o = { active: 0, source: 0, destination: 0, mint: 0, authority: 0, recipient: 0,
    mintKey: ZERO_KEY, recipientKey: ZERO_KEY, amount: 0n, initialize: 0, sourceBound: 0,
    destinationBound: 0, fresh: 0, sourceKey: ZERO_KEY, destinationKey: ZERO_KEY };
  const putRecipient = (r: Recipient) => {
    o.recipient = r.kind === 'actor' ? 0 : r.kind === 'custody' ? 1 : 2;
    if (r.kind === 'explicit') o.recipientKey = r.key;
  };
  if (e.kind === 'Transfer' || e.kind === 'BoundTransfer') {
    o.active = 1; o.source = e.source; o.destination = e.destination; o.mint = e.mint; o.mintKey = e.mintKey;
    o.authority = e.authority === 'actor' ? 0 : 1; putRecipient(e.recipient); o.amount = e.amount;
    if (e.kind === 'BoundTransfer') {
      if (e.sourceKey) { o.sourceBound = 1; o.sourceKey = e.sourceKey; }
      if (e.destinationKey) { o.destinationBound = 1; o.destinationKey = e.destinationKey; }
      o.fresh = Number(!!e.fresh);
    }
  } else if (e.kind === 'CheckMint') { o.active = 2; o.mint = e.mint; o.mintKey = e.mintKey; }
  else if (e.kind === 'Mint') {
    o.active = 3; o.authority = 1; o.destination = e.destination; o.mint = e.mint; o.mintKey = e.mintKey;
    putRecipient(e.recipient); o.amount = e.amount; o.initialize = Number(e.initialize);
  } else if (e.kind === 'Burn') { o.active = 4; o.source = e.source; o.mint = e.mint; o.mintKey = e.mintKey; o.amount = e.amount; }
  return o;
}
function u32Bytes(v: number) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; }
function u64Bytes(v: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; }
function validIndex(i: number, mint: number, count: number) { return i >= 4 && i < count && i !== mint; }
function ownerKey(r: Recipient, a: Account[]) { return r.kind === 'actor' ? a[1].key : r.kind === 'custody' ? a[3].key : r.key; }
function expectedValidation(e: Effect, a: Account[], count: number): number {
  if (e.kind === 'None') return 0;
  const t = transferHeader(e);
  if (t.active === 0) return 0;
  if (t.mint < 4 || t.mint >= count) return 12;
  const mint = a[t.mint];
  if (!same(mint.owner, a[2].key) || mint.executable) return 13;
  if (mint.size !== 82n || mint.data[45] !== 1) return 14;
  if (!same(mint.key, t.mintKey)) return 15;
  if (e.kind === 'CheckMint') return 0;
  if (e.kind === 'Mint' || e.kind === 'Burn') {
    // The abstract effect contract binds mint and burn authority selectors.
    if ((e.kind === 'Mint' && t.authority !== 1) || (e.kind === 'Burn' && t.authority !== 0)) return 9;
    if (!mint.writable) return 5;
    if (getLe(mint.data, 0, 4) !== 1n || !same(mint.data.subarray(4, 36), a[3].key) || getLe(mint.data, 46, 4) !== 0n) return 23;
    if (e.kind === 'Mint' && e.initialize && getLe(mint.data, 36, 8) !== 0n) return 24;
    const index = e.kind === 'Mint' ? e.destination : e.source;
    if (!validIndex(index, t.mint, count)) return 12;
    const token = a[index]; if (!token.writable) return 5;
    if (!same(token.owner, a[2].key) || token.executable) return 13;
    if (token.size !== 165n || (token.data[108] !== 1 && token.data[108] !== 2) || getLe(token.data, 109, 4) !== 0n) return 14;
    if (!same(token.data.subarray(0, 32), mint.key)) return 15;
    if (e.kind === 'Burn') return a[1].signer && same(token.data.subarray(32, 64), a[1].key) ? 0 : 16;
    if (!same(token.data.subarray(32, 64), ownerKey(e.recipient, a))) return 17;
    return 0;
  }
  if (e.kind !== 'Transfer' && e.kind !== 'BoundTransfer') return 9;
  if (!validIndex(t.source, t.mint, count) || !validIndex(t.destination, t.mint, count) || t.source === t.destination) return 12;
  const src = a[t.source], dst = a[t.destination];
  if (!src.writable || !dst.writable) return 5;
  if (!same(src.owner, a[2].key) || !same(dst.owner, a[2].key) || src.executable || dst.executable) return 13;
  if (src.size !== 165n || dst.size !== 165n || (src.data[108] !== 1 && src.data[108] !== 2) ||
      (dst.data[108] !== 1 && dst.data[108] !== 2) || getLe(src.data, 109, 4) !== 0n || getLe(dst.data, 109, 4) !== 0n) return 14;
  if (!same(src.data.subarray(0, 32), mint.key) || !same(dst.data.subarray(0, 32), mint.key)) return 15;
  if (e.kind === 'BoundTransfer') {
    if (Number(!!e.sourceKey) > 1 || Number(!!e.destinationKey) > 1 || Number(!!e.fresh) > 1) return 9;
    if ((e.sourceKey && !same(src.key, e.sourceKey)) || (e.destinationKey && !same(dst.key, e.destinationKey))) return 25;
    if (e.fresh && (getLe(dst.data, 64, 8) !== 0n || getLe(dst.data, 72, 4) !== 0n ||
        getLe(dst.data, 129, 4) !== 0n || !same(dst.data.subarray(32, 64), a[3].key))) return 26;
  }
  if ((t.authority !== 0 && t.authority !== 1) || t.recipient > 2) return 9;
  const authority = t.authority ? a[3].key : a[1].key;
  if ((!t.authority && !a[1].signer) || !same(src.data.subarray(32, 64), authority)) return 16;
  return same(dst.data.subarray(32, 64), ownerKey(e.recipient, a)) ? 0 : 17;
}

function infoOracle(a: Account) {
  return { key: hex(a.key), owner: hex(a.owner), lamports: dec(a.lamports), dataLength: dec(a.size), rentEpoch: dec(a.rentEpoch),
    signer: Number(!!a.signer), writable: Number(!!a.writable), executable: Number(!!a.executable), keyPointerOk: 1,
    lamportsPointerOk: 1, dataPointerOk: 1, ownerPointerOk: 1 };
}
function expectedCall(s: Scenario, e: Effect) {
  const t = transferHeader(e), a = s.accounts;
  const metaFields = e.kind === 'Transfer' || e.kind === 'BoundTransfer' ? [
    [t.source, 1, 0], [t.mint, 0, 0], [t.destination, 1, 0], [t.authority ? 3 : 1, 0, 1],
  ] : e.kind === 'Mint' ? [[t.mint, 1, 0], [t.destination, 1, 0], [3, 0, 1]] : [[t.source, 1, 0], [t.mint, 1, 0], [1, 0, 1]];
  const metas = metaFields.map(([index, writable, signer]) => ({ index, writable, signer, keyPointerOk: 1, key: hex(a[index].key) }));
  const opcode = e.kind === 'Transfer' || e.kind === 'BoundTransfer' ? 12 : e.kind === 'Mint' ? 14 : 15;
  const data = Buffer.alloc(16); data[0] = opcode; putLe(data, 1, t.amount, 8); data[9] = a[t.mint].data[44];
  const signerCount = e.kind === 'Mint' ? 1 : (e.kind === 'Transfer' || e.kind === 'BoundTransfer') && t.authority ? 1 : 0;
  const seeds = [{ length: '4', data: hex(PREFIX) }, { length: '32', data: hex(a[0].key) },
    { length: '1', data: hex(Buffer.from([s.pdaBump])) }];
  return { rawInfoCount: s.accounts.length, rawMetaCount: String(metas.length), rawSignerCount: signerCount,
    infoCount: s.accounts.length, metaCount: metas.length, programPointerOk: 1, accountsPointerPresent: 1, dataPointerPresent: 1,
    signerCount, signerSeedCount: 3, instructionLength: '10', syscallError: dec(s.invokeError), program: hex(a[2].key),
    data: hex(data), signerSeeds: seeds, metas, infos: a.map(infoOracle) };
}
function expectedScenario(s: Scenario, stateHeader: Buffer) {
  const events: string[] = [], calls: unknown[] = [];
  let result = 0, pda: unknown = null, clockCalls = 0, returnCalls = 0;
  const stateBefore = Buffer.from(s.accounts[0].data.subarray(0, Number(s.accounts[0].size)));
  const count = s.mode === 1 ? Number(getLe(stateBefore, 21, 4)) : 0;
  const expectedReturn = hex(Buffer.concat([Buffer.from([0]), u32Bytes((count + 1) >>> 0)]));
  const tokenProgramOk = same(s.accounts[2].key, TOKEN_ID) && !!s.accounts[2].executable;
  if (s.mode < 0 || s.mode > 1) result = 2;
  else if (!tokenProgramOk) result = 10;
  else {
    events.push('P');
    pda = { seedCount: 2, error: dec(s.pdaError), program: hex(s.program),
      key: s.pdaError ? hex(ZERO_KEY) : hex(s.pdaKey), bump: s.pdaError ? 0 : s.pdaBump,
      seeds: [{ length: '4', data: hex(PREFIX) }, { length: '32', data: hex(s.accounts[0].key) }] };
    if (s.pdaError || !same(s.pdaKey, s.accounts[3].key)) result = 11;
    else {
      if (!same(s.accounts[0].owner, s.program) || s.accounts[0].executable) result = 3;
      else if (!s.accounts[0].writable) result = 5;
      else if (s.accounts[0].size !== 25n) result = 4;
      else if (s.mode === 0 && !s.accounts[0].signer) result = 7;
      else if (s.mode === 1 && stateBefore[20] !== 0) result = 4;
      else if (s.mode === 1 && !stateBefore.subarray(0, stateHeader.length).equals(stateHeader)) result = 4;
      else if (s.mode === 0 && stateBefore.some(byte => byte !== 0)) result = 4;
      else {
        events.push('K'); clockCalls = 1;
        if (s.rootReject !== undefined) result = s.rootReject <= 0xfffffeff ? 256 + s.rootReject : 9;
        else {
          for (const effect of s.effects) {
            const error = expectedValidation(effect, s.accounts, s.accounts.length);
            if (error) { result = error; break; }
          }
          if (!result) for (const effect of s.effects) {
            if (!isExecutable(effect)) continue;
            events.push(`I${calls.length}`); calls.push(expectedCall(s, effect));
            if (s.invokeError) { result = 18; break; }
          }
          if (!result) { events.push('R'); returnCalls = 1; }
        }
      }
    }
  }
  const stateData = result ? stateBefore : Buffer.concat([stateHeader, Buffer.from(expectedReturn, 'hex')]);
  return { id: s.id, rc: String(result), clockCalls, returnCalls,
    returnData: result ? null : expectedReturn, stateUnchanged: Number(stateData.equals(stateBefore)),
    stateData: hex(stateData), pdaCalls: pda ? 1 : 0, pda, invokeCalls: calls.length, events, calls };
}

function encodeLoaderInput(s: Scenario, schema: RuntimeSchema, instructionType: string) {
  const codec = wireCodec(schema);
  const instruction = codec.encode(instructionType, wireValue(schema, instructionType, instructionValue(s)));
  const instructionLength = 1 + instruction.length;
  const accountAdvance = (size: number) => (Math.ceil((88 + size + 10240) / 8) * 8) + 8;
  const total = 8 + s.accounts.reduce((n, a) => n + accountAdvance(Number(a.size)), 0) + 8 + instructionLength + 32;
  const input = Buffer.alloc(total);
  input.writeBigUInt64LE(BigInt(s.accounts.length), 0);
  let p = 8;
  for (const a of s.accounts) {
    const size = Number(a.size);
    input[p] = 255; input[p + 1] = Number(!!a.signer); input[p + 2] = Number(!!a.writable); input[p + 3] = Number(!!a.executable);
    a.key.copy(input, p + 8); a.owner.copy(input, p + 40);
    input.writeBigUInt64LE(a.lamports, p + 72); input.writeBigUInt64LE(a.size, p + 80);
    a.data.copy(input, p + 88, 0, Math.min(size, a.data.length));
    const rentAt = Math.ceil((88 + size + 10240) / 8) * 8;
    input.writeBigUInt64LE(a.rentEpoch, p + rentAt);
    p += accountAdvance(size);
  }
  input.writeBigUInt64LE(BigInt(instructionLength), p); p += 8;
  input[p] = s.mode; input.set(instruction, p + 1); input.set(s.program, p + instructionLength);
  assert.equal(p + instructionLength + 32, input.length, `${s.name}: serialized loader byte count`);
  return input;
}
function encodeScenario(s: Scenario, schema: RuntimeSchema, instructionType: string) {
  const loader = encodeLoaderInput(s, schema, instructionType);
  const frame = Buffer.alloc(61);
  frame.writeBigUInt64LE(BigInt(loader.length), 0); frame.writeBigUInt64LE(s.pdaError, 8);
  frame.writeBigUInt64LE(s.invokeError, 16); s.pdaKey.copy(frame, 24); frame[56] = s.pdaBump;
  frame.writeUInt32LE(s.id, 57);
  return Buffer.concat([frame, loader]);
}
function firstDifference(want: unknown, got: unknown, at = '$'): { path: string; expected: unknown; observed: unknown } | undefined {
  if (want === got) return undefined;
  if (typeof want !== typeof got || want === null || got === null || typeof want !== 'object') return { path: at, expected: want, observed: got };
  if (Array.isArray(want) !== Array.isArray(got)) return { path: at, expected: want, observed: got };
  const wk = Object.keys(want as object), gk = Object.keys(got as object);
  if (wk.length !== gk.length || wk.some(k => !gk.includes(k))) return { path: `${at}.$keys`, expected: wk, observed: gk };
  for (const k of wk) {
    const d = firstDifference((want as Record<string, unknown>)[k], (got as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return undefined;
}

type Mutation = { name: string; target: 'program' | 'runtime'; from: string; to: string };
const MUTATIONS: Mutation[] = [
  { name:'transition-header-only-magic', target:'program',
    from:'for (unsigned i = 0; i < 20; ++i) if (state.data[i] != header[i]) return 4;',
    to:'for (unsigned i = 0; i < 4; ++i) if (state.data[i] != header[i]) return 4;' },
  { name:'init-zero-check-only-payload', target:'program',
    from:'for (unsigned i = 0; i < 25; ++i) if (state.data[i]) return 4;',
    to:'for (unsigned i = 20; i < 25; ++i) if (state.data[i]) return 4;' },

  { name: 'transition-decodes-zero-state', target: 'program',
    from: 'if (!bend_State_decode(state.data + 20, 5, &before)) return 4;',
    to: 'const u8 zero_state[5] = {0}; if (!bend_State_decode(zero_state, 5, &before)) return 4;' },
  { name: 'state-owner-executable-check-dropped', target: 'program',
    from: 'if (!equal_key(state.owner, program) || state.executable) return 3;', to: 'if (0) return 3;' },
  { name: 'state-writable-check-dropped', target: 'program',
    from: 'if (!state.writable) return 5;', to: 'if (0) return 5;' },
  { name: 'state-size-check-dropped', target: 'program',
    from: 'if (state.size != 25) return 4;', to: 'if (0) return 4;' },
  { name: 'state-init-signer-check-dropped', target: 'program',
    from: 'if (!state.signer) return 7;', to: 'if (0) return 7;' },
  { name: 'state-init-zero-check-dropped', target: 'program',
    from: 'for (unsigned i = 0; i < 25; ++i) if (state.data[i]) return 4;',
    to: '/* deliberately accepts dirty initialization */' },

  { name: 'generated-state-header-commit-dropped', target: 'program',
    from: '__builtin_memcpy(state.data, header, 20);', to: '/* deliberate header commit omission */' },
  { name: 'generated-state-payload-commit-dropped', target: 'program',
    from: '__builtin_memcpy(state.data + 20, encoded, 5);', to: '/* deliberate payload commit omission */' },
  { name: 'extract-transfer-authority-flipped', target: 'program', from: 'out->authority = value->as.c1.f6.tag;',
    to: 'out->authority = 1u - value->as.c1.f6.tag;' },
  { name: 'extract-recipient-rotated', target: 'program', from: 'out->recipient = value->as.c1.f4.tag;',
    to: 'out->recipient = (value->as.c1.f4.tag + 1u) % 3u;' },
  { name: 'extract-destination-uses-source-index', target: 'program', from: 'out->destination = value->as.c1.f1;',
    to: 'out->destination = value->as.c1.f0;' },
  { name: 'executor-state-seed-uses-actor', target: 'runtime',
    from: 'BendSeed seeds[3] = {{prefix,4},{a[0].key,32},{&bump,1}};',
    to: 'BendSeed seeds[3] = {{prefix,4},{a[1].key,32},{&bump,1}};' },
  { name: 'executor-token-recipient-uses-source', target: 'runtime',
    from: 'metas[2]=(BendAccountMeta){a[t->destination].key,1,0};',
    to: 'metas[2]=(BendAccountMeta){a[t->source].key,1,0};' },
  { name: 'executor-amount-byte-mutated', target: 'runtime', from: 'write_le(data+1,t->amount,8);',
    to: 'write_le(data+1,t->amount ^ 1u,8);' },
  { name: 'executor-mint-selector-routed-to-burn', target: 'runtime',
    from: '} else if (t->active == 3) {', to: '} else if (t->active == 4) {' },
  { name: 'custody-pda-key-check-dropped', target: 'runtime',
    from: 'return equal_key(key, accounts[3].key) ? 0 : 11;', to: 'return 0;' },
  { name: 'token-program-check-dropped', target: 'runtime',
    from: 'if (!bend_token_program(&accounts[2])) return 10;', to: 'if (0) return 10;' },
  { name: 'transfer-authority-and-signer-check-dropped', target: 'runtime',
    from: 'if ((!t->authority && !a[1].signer) || !equal_key(src->data+32,authority)) return 16;',
    to: 'if (!equal_key(authority,authority)) return 16;' },
  { name: 'transfer-writable-check-dropped', target: 'runtime',
    from: 'if (!src->writable || !dst->writable) return 5;', to: 'if (0) return 5;' },
  { name: 'bound-account-key-check-dropped', target: 'runtime',
    from: 'if ((t->source_bound && !equal_key(src->key,t->source_key)) ||\n      (t->destination_bound && !equal_key(dst->key,t->destination_key))) return 25;', to: 'if (0) return 25;' },
  { name: 'fresh-destination-check-dropped', target: 'runtime',
    from: 'if (t->fresh_destination && (read_le(dst->data+64,8) != 0 ||\n      read_le(dst->data+72,4) != 0 || read_le(dst->data+129,4) != 0 ||\n      !equal_key(dst->data+32,a[3].key))) return 26;', to: 'if (0) return 26;' },
  { name: 'burn-owner-and-signer-check-dropped', target: 'runtime',
    from: 'if (!a[1].signer || !equal_key(token->data+32,a[1].key)) return 16;', to: 'if (0) return 16;' },
  { name: 'mint-initialization-supply-check-dropped', target: 'runtime',
    from: 'if (t->active == 3 && t->initialize && read_le(mint->data+36,8) != 0) return 24;', to: 'if (0) return 24;' },
  { name: 'mint-custody-authority-check-dropped', target: 'runtime',
    from: 'if (read_le(mint->data,4) != 1 || !equal_key(mint->data+4,a[3].key) ||\n        read_le(mint->data+46,4) != 0) return 23;',
    to: 'if (read_le(mint->data+46,4) != 0) return 23;' },
  { name: 'generated-adapter-token-validation-bypassed', target: 'program',
    from: 'u64 error = bend_transfer_validate(&transfers[i],accounts,(unsigned)count);', to: 'u64 error = 0;' },
];
function replaceExactly(source: string, from: string, to: string, name: string) {
  const at = source.indexOf(from);
  assert(at >= 0 && source.indexOf(from, at + from.length) < 0, `${name}: mutation anchor must occur exactly once`);
  const changed = source.slice(0, at) + to + source.slice(at + from.length);
  assert.notEqual(changed, source, `${name}: mutation changes source`); return changed;
}

function writeRuntimeCopy(dir: string, replacement?: { from: string; to: string; name: string }) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['solana_min.h', 'cpi_abi.h', 'token.h']) {
    let text = fs.readFileSync(path.join(ROOT, 'runtime', file), 'utf8');
    if (file === 'token.h' && replacement) text = replaceExactly(text, replacement.from, replacement.to, replacement.name);
    fs.writeFileSync(path.join(dir, file), text);
  }
  return sha(fs.readFileSync(path.join(dir, 'token.h')));
}
function makeUnit(dir: string, programC: string, name: string) {
  fs.writeFileSync(path.join(dir, 'program.c'), programC);
  fs.writeFileSync(path.join(dir, `${name}.unit.c`), `#include "program.c"\n#include "token-composition-harness.h"\n`);
  return path.join(dir, `${name}.unit.c`);
}
function compile(cc: string, source: string, dir: string, runtimeDir: string, artifactDir: string, binary: string) {
  const args = [...FLAGS, `-I${dir}`, `-I${runtimeDir}`, `-I${artifactDir}`, `-I${path.join(ROOT, 'tests')}`,
    source, '-o', binary];
  const p = spawnSync(cc, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 26 });
  fs.writeFileSync(`${binary}.compile.stdout`, p.stdout ?? ''); fs.writeFileSync(`${binary}.compile.stderr`, p.stderr ?? '');
  fs.writeFileSync(`${binary}.compile.json`, JSON.stringify({ args, status: p.status, signal: p.signal, error: p.error?.message }, null, 2) + '\n');
  assert(!p.error && p.status === 0, `native compile failed for ${path.basename(binary)} (${p.error?.message ?? p.status})\n${(p.stderr ?? '').slice(0, 5000)}`);
  return { args, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}
function execute(binary: string, input: Buffer, stem: string, expectedRows: number) {
  const p = spawnSync(binary, [], { input, encoding: 'utf8', env: ASAN_ENV, timeout: 180_000, maxBuffer: 1 << 28 });
  const stdout = p.stdout ?? '', stderr = p.stderr ?? '';
  fs.writeFileSync(`${stem}.stdout.jsonl`, stdout); fs.writeFileSync(`${stem}.stderr.txt`, stderr);
  fs.writeFileSync(`${stem}.run.json`, JSON.stringify({ status: p.status, signal: p.signal, error: p.error?.message,
    inputSha256: sha(input), stdoutSha256: sha(stdout), stderrSha256: sha(stderr) }, null, 2) + '\n');
  const diagnosticKind = /AddressSanitizer|UndefinedBehaviorSanitizer|runtime error:|LeakSanitizer|MemorySanitizer/i.test(stderr)
    ? 'sanitizer/UB evidence' : p.error || p.status !== 0 || p.signal ? 'abnormal process exit' :
      stderr ? 'unexpected stderr' : 'clean execution';
  assert(!p.error && p.status === 0 && !p.signal, `native run incomplete for ${path.basename(binary)}; ` +
    `classification=${diagnosticKind} (${p.error?.message ?? p.status}, signal=${p.signal ?? '-'})\n${stderr.slice(0, 5000)}`);
  assert.equal(stderr, '', `${path.basename(binary)} emitted ${diagnosticKind}\n${stderr}`);
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.at(-1), 'done', `${path.basename(binary)} did not complete the entire scenario matrix`);
  const rows = lines.slice(0, -1).map((line, i) => {
    try { return JSON.parse(line) as Record<string, unknown>; }
    catch (e) { throw new Error(`invalid JSON output row ${i}: ${String(e)}\n${line.slice(0, 1000)}`); }
  });
  assert.equal(rows.length, expectedRows, `${path.basename(binary)} output ${rows.length}/${expectedRows} scenarios`);
  return { rows, stdout, stderr, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) };
}
function sourceHashes(files: string[]) { return Object.fromEntries(files.map(file => [file, sha(fs.readFileSync(path.join(ROOT, file)))])); }
function assertInputsStable(files: string[], start: Record<string, string>) {
  assert.deepEqual(sourceHashes(files), start, 'an input source changed while the gate ran; refusing a success report');
}
function abstractAccountDigest(s: Scenario) {
  return sha(Buffer.concat(s.accounts.flatMap(a => [a.key, a.owner, a.data, u64Bytes(a.size), u64Bytes(a.lamports),
    u64Bytes(a.rentEpoch), u32Bytes(a.signer), u32Bytes(a.writable), u32Bytes(a.executable)])));
}
export async function testTokenComposition() {
  const rootReport = path.join(OUT, 'report.json');
  const historyDir = path.join(OUT, 'history');
  fs.mkdirSync(OUT, { recursive: true });
  if (fs.existsSync(rootReport)) {
    const old = fs.readFileSync(rootReport);
    const oldMeta = (() => { try { return JSON.parse(old.toString()) as { runId?: string }; } catch { return {}; } })();
    fs.mkdirSync(historyDir, { recursive: true });
    const archive = path.join(historyDir, `${oldMeta.runId ?? 'prior'}-${sha(old).slice(0, 16)}.json`);
    if (!fs.existsSync(archive)) fs.writeFileSync(archive, old);
    fs.rmSync(rootReport, { force: true });
  }
  fs.rmSync(`${rootReport}.tmp`, { force: true });
  const inputFiles = [...new Set([
    'tests/token-composition.ts', HARNESS, ...fs.readdirSync('compiler').filter(f => f.endsWith('.ts')).map(f => path.join('compiler', f)),
    '.deps/bend/bend2/bend.ts', 'scripts/build.ts', 'package.json', 'package-lock.json',
    'runtime/token.h', 'runtime/cpi_abi.h', 'runtime/solana_min.h', 'sdk/context.bend', 'sdk/effects.bend',
    'sdk/issuance.bend', 'sdk/math.bend', 'sdk/wire.ts', 'docs/interfaces.md',
  ])].sort();
  const initialHashes = sourceHashes(inputFiles);
  const bendDir = path.resolve('.deps/bend');
  const bendCommitRun = spawnSync('git', ['-C', bendDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const bendStatusRun = spawnSync('git', ['-C', bendDir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(bendCommitRun.status, 0, 'pinned Bend checkout is unavailable');
  assert.equal((bendCommitRun.stdout ?? '').trim(), '7561656155a4285c1e4ccfcb3505ab59524de973', 'unexpected Bend dependency commit');
  assert.equal(bendStatusRun.status, 0, 'cannot inspect Bend checkout status');
  assert.equal((bendStatusRun.stdout ?? '').trim(), '', 'shared Bend checkout is dirty; refusing to use or change it');

  const cc = process.env.CC ?? 'clang';
  const ccVersion = spawnSync(cc, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert(!ccVersion.error && ccVersion.status === 0, `cannot query native C compiler: ${ccVersion.error?.message ?? ccVersion.status}`);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const inputFingerprint = sha(JSON.stringify({ initialHashes, scenarios: SCENARIOS.map(s => ({ name: s.name,
    effects: s.effects.map(effectDescription), accounts: abstractAccountDigest(s) })) }));
  const runId = `${timestamp}-${inputFingerprint.slice(0, 16)}`;
  const RUN = path.join(OUT, 'runs', runId);
  const fixtureDir = path.dirname(SOURCE);
  const artifactDir = path.join(RUN, 'fixture');
  fs.mkdirSync(fixtureDir, { recursive: true }); fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(SOURCE, fixtureSource());
  const checked = await checkedProgram(SOURCE);
  const emitted = new Backend(checked.book).emit(['process']);
  const artifactStem = path.join(artifactDir, 'program');
  writeArtifacts(artifactStem, emitted, 'process');
  const programC = fs.readFileSync(`${artifactStem}.c`, 'utf8');
  const schema = JSON.parse(fs.readFileSync(`${artifactStem}.schema.json`, 'utf8')) as RuntimeSchema;
  const iface = JSON.parse(fs.readFileSync(`${artifactStem}.interface.json`, 'utf8')) as {
    effects?: string; effectSlots?: number; instruction: string; state: string; header: number[]; stateBytes: number;
  };
  assert.equal(iface.effects, 'token-v2'); assert.equal(iface.effectSlots ?? 2, 3);
  assert(programC.includes('u64 entrypoint(const u8 *input)'), 'test compiles the emitted adapter entrypoint');
  assert(programC.includes('bend_transfer_validate(&transfers[i],accounts,(unsigned)count)'),
    'generated token entrypoint includes real transfer validation');
  const outcomeFn = schema.exports.find(e => e.name === 'process'); assert(outcomeFn, 'generated fixture has process export');
  const outcome = adt(schema, outcomeFn.result);
  const accepted = outcome.variants.find(v => short(v) === 'Accepted'); assert(accepted, 'generated fixture has Accepted variant');
  const effectsType = accepted.fields.find(f => f.name === 'effects')?.type; assert(effectsType, 'generated Accepted.effects field');
  const effectsAdt = adt(schema, effectsType); const effectType = effectsAdt.variants[0].fields[0].type;
  const effectAdt = adt(schema, effectType);
  assert.equal(effectAdt.variants.map(short).join(','), 'None,Transfer,CheckMint,Mint,Burn,BoundTransfer');
  assert.deepEqual(iface.header, [...schemaDerivedStorageHeader(schema, iface.state)],
    'independent schema traversal derives the exact managed state header');
  const codec = wireCodec(schema);
  const expectedReturn = hex(codec.encode(iface.state, wireValue(schema, iface.state, { c: 'State', f: { count: 1 } })));
  assert.deepEqual(schemaDerivedStorageHeader(schema, iface.state), FIXTURE_STATE_HEADER,
    'fixed State-count storage-header conformance vector');
  const stateHeader = Buffer.from(FIXTURE_STATE_HEADER);
  assert.equal(stateHeader.length + Buffer.from(expectedReturn, 'hex').length, iface.stateBytes,
    'independent state header and wire payload fill the complete allocation');
  const encodedRows = SCENARIOS.map(s => encodeScenario(s, schema, iface.instruction));
  const encoded = Buffer.concat(encodedRows);
  fs.writeFileSync(path.join(RUN, 'scenarios.input.bin'), encoded);
  const expected = SCENARIOS.map(s => expectedScenario(s, stateHeader));
  fs.writeFileSync(path.join(RUN, 'oracle.expected.json'), JSON.stringify(expected, null, 2) + '\n');
  const runtimeDir = path.join(RUN, 'runtime-original'); const runtimeHash = writeRuntimeCopy(runtimeDir);
  const originalUnit = makeUnit(artifactDir, programC, 'original');
  const originalBinary = path.join(artifactDir, 'original-native');
  const compileResult = compile(cc, originalUnit, artifactDir, runtimeDir, artifactDir, originalBinary);
  const originalRun = execute(originalBinary, encoded, path.join(RUN, 'original'), SCENARIOS.length);
  for (let i = 0; i < SCENARIOS.length; ++i) {
    const diff = firstDifference(expected[i], originalRun.rows[i]);
    assert.equal(diff, undefined, `${SCENARIOS[i].name}: composed original differs from independent contract oracle at ${JSON.stringify(diff)}`);
  }
  const noneIndex = SCENARIOS.findIndex(s => s.name === 'none-checkmint-no-cpi');
  const noneObserved = originalRun.rows[noneIndex] as any;
  assert.equal(noneObserved.pdaCalls, 1, 'generated entrypoint runs custody setup even for None/CheckMint-only effects');
  assert.equal(noneObserved.invokeCalls, 0); assert.equal(noneObserved.returnCalls, 1);
  const rejectIndex = SCENARIOS.findIndex(s => s.name === 'reject-last-validation-before-any-execution');
  const rejected = originalRun.rows[rejectIndex] as any;
  assert.deepEqual(rejected.events, ['P', 'K'], 'a later validation failure returns before any execution syscall');
  assert.equal(rejected.invokeCalls, 0); assert.equal(rejected.stateUnchanged, 1);
  for (const [name, code] of [
    ['root-rejected-outcome', '298'], ['transition-rejects-missing-state-header', '4'],
    ['rejects-invalid-instruction-mode', '2'],
    ['transition-count-17', '0'], ['transition-count-4294967295', '0'],
    ['state-reject-owner', '3'], ['state-reject-executable', '3'],
    ['state-reject-writable', '5'], ['state-reject-init-signer', '7'],
    ['state-reject-init-dirty-header', '4'], ['state-reject-wrong-schema-hash', '4'],
    ['state-reject-init-nonzero', '4'], ['state-reject-short-size', '4'],
    ['state-reject-long-size', '4'], ['state-reject-noncanonical-transition', '4'],
  ]) {
    const i = SCENARIOS.findIndex(s => s.name === name); assert(i >= 0, `missing entrypoint scenario ${name}`);
    const row = originalRun.rows[i] as any; assert.equal(row.rc, code, `${name}: explicit entrypoint result`);
    assert.equal(row.returnCalls, Number(code === '0'), `${name}: return-data publication`);
    assert.equal(row.stateUnchanged, Number(code !== '0'), `${name}: state preservation/commit`);
  }
  const fullIndex = SCENARIOS.findIndex(s => s.name === 'transfer-mint-burn-full-u64');
  assert.deepEqual((originalRun.rows[fullIndex] as any).calls.map((c: any) => Buffer.from(c.data, 'hex')[0]), [12, 14, 15]);

  for (const [name, code] of [
    ['transfer-reject-source-owner', '13'], ['transfer-reject-source-executable', '13'],
    ['transfer-reject-token-state', '14'], ['transfer-reject-mint-owner', '13'],
    ['transfer-reject-mint-executable', '13'], ['transfer-reject-mint-state', '14'],
    ['transfer-reject-token-mint-binding', '15'], ['transfer-reject-effect-mint-key', '15'],
    ['transfer-source-authority-missing', '16'], ['transfer-custody-authority-missing', '16'],
    ['transfer-actor-authority-without-signer', '16'],
    ['transfer-readonly-source', '5'], ['bound-transfer-wrong-source-binding', '25'],
    ['bound-transfer-fresh-destination-not-empty', '26'], ['mint-requires-custody-mint-authority', '23'],
    ['mint-initialize-requires-zero-supply', '24'],
    ['burn-owner-requires-actor-signer', '16'], ['custody-rejects-wrong-token-program', '10'],
    ['custody-rejects-nonexecutable-token-program', '10'], ['custody-pda-key-mismatch', '11'],
    ['custody-pda-syscall-failure', '11'], ['token-cpi-syscall-failure', '18'],
  ]) {
    const i = SCENARIOS.findIndex(s => s.name === name); assert(i >= 0, `missing required negative scenario ${name}`);
    const row = originalRun.rows[i] as any; assert.equal(row.rc, code, `${name}: expected explicit adapter code`);
    assert.equal(row.stateUnchanged, 1, `${name}: explicit adapter failure leaves managed state unchanged`);
  }

  const mutationDir = path.join(RUN, 'mutants'); fs.mkdirSync(mutationDir, { recursive: true });
  const mutationReports: unknown[] = [];
  for (const m of MUTATIONS) {
    const dir = path.join(mutationDir, m.name); fs.mkdirSync(dir, { recursive: true });
    const changedProgramC = m.target === 'program' ? replaceExactly(programC, m.from, m.to, m.name) : programC;
    const runtime = path.join(dir, 'runtime');
    const runtimeTokenHash = writeRuntimeCopy(runtime, m.target === 'runtime' ? m : undefined);
    const unit = makeUnit(dir, changedProgramC, m.name);
    const binary = path.join(dir, 'mutant-native');
    const mutantCompile = compile(cc, unit, dir, runtime, artifactDir, binary);
    const mutantRun = execute(binary, encoded, path.join(dir, 'mutant'), SCENARIOS.length);
    const differences = mutantRun.rows.map((row, i) => ({ name: SCENARIOS[i].name, difference: firstDifference(expected[i], row) }))
      .filter(x => x.difference);
    assert.equal(mutantRun.rows.length, SCENARIOS.length, `${m.name}: mutation did not complete the full matrix`);
    assert(differences.length > 0, `${m.name}: semantic mutant unexpectedly agrees with the independent oracle on the complete matrix`);
    if (m.name === 'generated-state-header-commit-dropped' || m.name === 'generated-state-payload-commit-dropped') {
      assert(differences.some(x => x.difference?.path === '$.stateData' && expected[SCENARIOS.findIndex(s => s.name === x.name)]?.rc === '0'),
        `${m.name}: completed matrix must expose an exact successful state-byte mismatch`);
    }
    if (m.name === 'generated-adapter-token-validation-bypassed') {
      const i = SCENARIOS.findIndex(s => s.name === 'reject-last-validation-before-any-execution');
      const row = mutantRun.rows[i] as any;
      assert.equal(row.rc, '0'); assert(row.invokeCalls > 0, 'skipping generated validation reaches token CPI');
      assert.equal(row.stateUnchanged, 0);
    }
    mutationReports.push({ name: m.name, target: m.target, classification: 'semantic-mismatch',
      programSha256: sha(changedProgramC), runtimeTokenSha256: runtimeTokenHash,
      sourceArtifact: path.relative(ROOT, path.join(dir, 'program.c')),
      runtimeTokenArtifact: path.relative(ROOT, path.join(runtime, 'token.h')),
      compileArgs: mutantCompile.args, completedScenarios: mutantRun.rows.length, exitStatus: 0,
      stdoutSha256: mutantRun.stdoutSha256, stderrSha256: mutantRun.stderrSha256,
      observations: mutantRun.rows, differences });
    console.log(`${m.name}: completed ${mutantRun.rows.length} scenarios; ${differences.length} semantic disagreements`);
  }

  const endingHashes = sourceHashes(inputFiles);
  assert.deepEqual(endingHashes, initialHashes, 'a source or runtime input changed during the gate; refusing to publish success');
  const bendCommitEnd = spawnSync('git', ['-C', bendDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const bendStatusEnd = spawnSync('git', ['-C', bendDir, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal((bendCommitEnd.stdout ?? '').trim(), (bendCommitRun.stdout ?? '').trim(), 'Bend dependency changed during the gate');
  assert.equal((bendStatusEnd.stdout ?? '').trim(), '', 'Bend dependency became dirty during the gate');

  const artifactFiles = [`${artifactStem}.c`, `${artifactStem}.h`, `${artifactStem}.schema.json`, `${artifactStem}.interface.json`,
    `${artifactStem}.resources.json`, `${artifactStem}.wire.h`, `${artifactStem}.dispatch.h`,
    path.join(artifactDir, 'original.unit.c'), HARNESS, path.join(runtimeDir, 'token.h'), path.join(runtimeDir, 'cpi_abi.h'),
    path.join(runtimeDir, 'solana_min.h')];
  const artifactHashes = Object.fromEntries(artifactFiles.map(f => [path.relative(ROOT, f), sha(fs.readFileSync(f))]));
  const report = {
    version: 1, runId, passed: true, createdAt: new Date().toISOString(), compiler: ccVersion.stdout.split('\n')[0], flags: FLAGS,
    bun: process.versions.bun, sanitizerEnvironment: { ASAN_OPTIONS: ASAN_ENV.ASAN_OPTIONS, UBSAN_OPTIONS: ASAN_ENV.UBSAN_OPTIONS },
    worktree: ROOT, sharedDependencies: { nodeModules: fs.realpathSync(path.join(ROOT, 'node_modules')),
      bend: bendDir, bendCommit: (bendCommitEnd.stdout ?? '').trim(), bendClean: true, mutated: false },
    scope: 'Finite native ASan/UBSan execution of the complete generated token adapter entrypoint, including its loader parsing, codecs, Bend root, custody setup, effect extraction, runtime/token.h validation, runtime/token.h execution, state commit, and return-data path. Exact post-entrypoint managed-state header and payload bytes are compared on every row against a fixed fixture header conformance vector and independently calculated state encoding, including successful stored-state transitions and U32 wraparound. The schema-derived header algorithm is a separate consistency check, not an independent proof of that algorithm. Only PDA, invoke_signed, Clock, and return-data syscalls are mocked. This does not establish token-program behavior, transaction rollback, SBF behavior, or end-to-end compiler verification. Explicit adapter failures are checked for unchanged managed state under the helper assumptions; this is not a transaction rollback claim.',
    accountContract: 'Account 0 is state, 1 actor, 2 executable SPL Token program, 3 custody PDA, 4/5/7 token accounts and 6 mint. The independent oracle maps abstract None/CheckMint/Transfer/BoundTransfer/Mint/Burn effects to canonical BendTransfer fields, SPL account predicates, checked-token CPI metas, 10-byte instruction data and signer seeds.',
    syscallScope: 'Generated custody setup runs unconditionally for every effectful adapter call, including None/CheckMint-only instructions. Token-program failure occurs before PDA derivation. The actual runtime executor makes invoke_signed calls only for executable Transfer/Mint/Burn effects. Clock and return-data syscalls are deterministic mocks.',
    mutablePredicates: 'The generated adapter completes validation of all slots before it attempts the first invoke_signed syscall. CPI mocks do not mutate token accounts. Successful preflight uses initial account bytes; a real earlier token CPI may change later account predicates. This native test makes no post-CPI revalidation or rollback claim.',
    inputs: initialHashes, bendDependency: { commit: (bendCommitEnd.stdout ?? '').trim(), clean: true },
    fixtureSourceSha256: sha(fs.readFileSync(SOURCE)), generatedArtifacts: artifactHashes,
    dependencyClosure: ['compiler/codecs.ts', 'compiler/dispatch.ts', 'compiler/resources.ts', 'compiler/storage.ts',
      'compiler/effects.ts', 'compiler/backend.ts', 'compiler/tagged-sum-ir.ts', 'runtime/token.h', 'runtime/cpi_abi.h', 'runtime/solana_min.h'],
    runtimeTokenSha256: initialHashes['runtime/token.h'], harnessSha256: initialHashes[HARNESS],
    compilerFlags: compileResult.args, original: { exitStatus: 0, completedScenarios: originalRun.rows.length,
      inputSha256: sha(encoded), stdoutSha256: originalRun.stdoutSha256, stderrSha256: originalRun.stderrSha256,
      binarySha256: sha(fs.readFileSync(originalBinary)), observations: originalRun.rows },
    scenarios: SCENARIOS.map((s, i) => ({ id: s.id, name: s.name, effects: s.effects.map(effectDescription),
      accountStateSha256: abstractAccountDigest(s), inputRecordSha256: sha(encodedRows[i]), oracle: expected[i] })),
    totals: { scenarios: SCENARIOS.length, positiveSanitizedRuns: 1, completedSemanticMutants: mutationReports.length,
      oracleDisagreements: (mutationReports as any[]).reduce((n, m) => n + m.differences.length, 0) },
    mutations: mutationReports,
    evidence: { runDirectory: path.relative(ROOT, RUN), originalInput: path.relative(ROOT, path.join(RUN, 'scenarios.input.bin')),
      originalStdout: path.relative(ROOT, path.join(RUN, 'original.stdout.jsonl')),
      originalStderr: path.relative(ROOT, path.join(RUN, 'original.stderr.txt')),
      expected: path.relative(ROOT, path.join(RUN, 'oracle.expected.json')) },
  };
  const reportText = JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(path.join(RUN, 'report.json.tmp'), reportText); fs.renameSync(path.join(RUN, 'report.json.tmp'), path.join(RUN, 'report.json'));
  fs.writeFileSync(`${rootReport}.tmp`, reportText); fs.renameSync(`${rootReport}.tmp`, rootReport);
  console.log(`Token composition: ${SCENARIOS.length} scenarios passed under ASan/UBSan; ${MUTATIONS.length} ordinary mutants completed the matrix and disagreed semantically; report ${path.relative(ROOT, rootReport)}`);
}

if (import.meta.main) await testTokenComposition();
