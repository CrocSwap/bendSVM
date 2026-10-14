import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'build/token-helpers-native');
const RUNTIME = path.join(OUT, 'runtime');
const HARNESS = 'tests/token-helpers-harness.c';
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const PREFIX = Buffer.from([0x62, 0x65, 0x6e, 0x64]);
const TOKEN_ID = Buffer.from([6,221,246,225,215,101,161,147,217,203,225,70,206,235,121,172,
  28,180,133,237,95,91,55,145,58,140,245,133,126,255,0,169]);
const FLAGS = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
  '-fno-sanitize-recover=all', '-Wall', '-Wextra'];

type Operation = 'program' | 'custody' | 'validate' | 'execute';
type Account = { key: Buffer; owner: Buffer; data: Buffer; size: bigint; lamports: bigint; rentEpoch: bigint;
  signer: number; writable: number; executable: number };
type Transfer = { active: number; source: number; destination: number; mint: number; authority: number; recipient: number;
  mintKey: Buffer; recipientKey: Buffer; amount: bigint; initialize: number; sourceBound: number;
  destinationBound: number; freshDestination: number; sourceKey: Buffer; destinationKey: Buffer };
type Input = { id: number; name: string; operation: Operation; count: number; exactAllocations: boolean;
  transfer: Transfer; pdaProgram: Buffer; pdaKey: Buffer; pdaError: bigint; invokeError: bigint; pdaBump: number;
  initialBump: number; accounts: Account[]; helperOnly?: boolean };

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hex = (b: Buffer) => b.toString('hex');
const dec = (n: bigint) => n.toString(10);
const key = (tag: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (tag * 43 + i * 17 + Math.floor(i / 8) * 29) & 255));
const same = (a: Buffer, b: Buffer) => a.equals(b);
const tokenTag = (op: Operation) => ({ program: 1, custody: 2, validate: 3, execute: 4 } as const)[op];

function putLe(b: Buffer, at: number, value: bigint | number, n: number) {
  let v = typeof value === 'bigint' ? value : BigInt(value >>> 0);
  for (let i = 0; i < n; ++i) { b[at + i] = Number(v & 255n); v >>= 8n; }
}
function readLe(b: Buffer, at: number, n: number): bigint {
  let v = 0n;
  for (let i = 0; i < n; ++i) v |= BigInt(b[at + i]) << BigInt(i * 8);
  return v;
}
function blankAccounts(): Account[] {
  return Array.from({ length: 12 }, (_, i) => ({ key: key(i + 1), owner: key(60 + i), data: Buffer.alloc(165),
    size: 165n, lamports: 101n + BigInt(i) * 1009n, rentEpoch: 700n + BigInt(i) * 31n,
    signer: i === 1 ? 1 : 0, writable: i === 1 ? 0 : 1, executable: 0 }));
}
function fresh(name: string, operation: Operation, count = 8): Input {
  const accounts = blankAccounts();
  accounts[2].key = Buffer.from(TOKEN_ID); accounts[2].executable = 1;
  accounts[3].key = key(4);
  const transfer: Transfer = { active: 1, source: 4, destination: 5, mint: 6, authority: 0, recipient: 0,
    mintKey: key(106), recipientKey: Buffer.alloc(32), amount: 0x1_0000_0005n, initialize: 0,
    sourceBound: 0, destinationBound: 0, freshDestination: 0, sourceKey: Buffer.alloc(32), destinationKey: Buffer.alloc(32) };
  const x: Input = { id: -1, name, operation, count, exactAllocations: false, transfer,
    pdaProgram: key(200), pdaKey: Buffer.from(accounts[3].key), pdaError: 0n, invokeError: 0n,
    pdaBump: 0xc9, initialBump: 0x31, accounts };
  setMint(x, 6);
  transfer.mintKey = Buffer.from(accounts[6].key);
  setToken(x, 4, 6, accounts[1].key);
  setToken(x, 5, 6, accounts[1].key);
  return x;
}
function setMint(x: Input, index: number, options: { writable?: number; executable?: number; owner?: Buffer;
  size?: bigint; initialized?: number; mintAuthorityOption?: number; mintAuthority?: Buffer;
  supply?: bigint; decimals?: number; freezeOption?: number } = {}) {
  const a = x.accounts[index]; a.owner = Buffer.from(options.owner ?? x.accounts[2].key);
  a.writable = options.writable ?? 1; a.executable = options.executable ?? 0; a.size = options.size ?? 82n;
  a.data.fill(0); putLe(a.data, 0, options.mintAuthorityOption ?? 1, 4);
  (options.mintAuthority ?? x.accounts[3].key).copy(a.data, 4);
  putLe(a.data, 36, options.supply ?? 37n, 8);
  a.data[44] = options.decimals ?? 9; a.data[45] = options.initialized ?? 1;
  putLe(a.data, 46, options.freezeOption ?? 0, 4);
}
function setToken(x: Input, index: number, mintIndex: number, recipient: Buffer, options: {
  writable?: number; executable?: number; owner?: Buffer; size?: bigint; state?: number;
  delegateOption?: number; mintKey?: Buffer; tokenAmount?: bigint; delegatedAmount?: bigint; closeOption?: number } = {}) {
  const a = x.accounts[index]; a.owner = Buffer.from(options.owner ?? x.accounts[2].key);
  a.writable = options.writable ?? 1; a.executable = options.executable ?? 0; a.size = options.size ?? 165n;
  a.data.fill(0);
  (options.mintKey ?? x.accounts[mintIndex].key).copy(a.data, 0);
  recipient.copy(a.data, 32); putLe(a.data, 64, options.tokenAmount ?? 123n, 8);
  putLe(a.data, 72, options.delegateOption ?? 0, 4); a.data[108] = options.state ?? 1;
  putLe(a.data, 109, 0, 4); putLe(a.data, 121, options.delegatedAmount ?? 0n, 8);
  putLe(a.data, 129, options.closeOption ?? 0, 4);
}
function setTransfer(x: Input, options: Partial<Transfer> & { source?: number; destination?: number; mint?: number } = {}) {
  Object.assign(x.transfer, options);
  const t = x.transfer;
  if (t.mint >= 0 && t.mint < 12) {
    if (t.mint !== 2 && t.mint !== 3) {
      setMint(x, t.mint);
      t.mintKey = Buffer.from(x.accounts[t.mint].key);
    }
  }
  const recipient = t.recipient === 1 ? x.accounts[3].key : t.recipient === 2 ? t.recipientKey : x.accounts[1].key;
  if (t.source >= 0 && t.source < 12 && t.source !== t.mint && t.source !== 2 && t.source !== 3)
    setToken(x, t.source, t.mint, t.active === 4 ? x.accounts[1].key : (t.authority ? x.accounts[3].key : x.accounts[1].key));
  if (t.destination >= 0 && t.destination < 12 && t.destination !== t.mint && t.destination !== t.source && t.destination !== 2 && t.destination !== 3)
    setToken(x, t.destination, t.mint, recipient);
  if (t.active === 3 && t.mint >= 0 && t.mint < 12) {
    // Issuance is exclusively custody-authorized; initialization starts with zero supply.
    putLe(x.accounts[t.mint].data, 36, t.initialize ? 0n : 37n, 8);
  }
}

const cases: Input[] = [];
function add(x: Input) { x.id = cases.length; cases.push(x); }
function programCase(name: string, mutate: (x: Input) => void = () => {}) { const x = fresh(name, 'program'); mutate(x); add(x); }
function custodyCase(name: string, mutate: (x: Input) => void = () => {}) { const x = fresh(name, 'custody'); mutate(x); add(x); }
function validateCase(name: string, mutate: (x: Input) => void = () => {}) {
  const x = fresh(name, 'validate'); mutate(x); add(x);
}

// Program recognition and custody PDA boundary, including precedence and full key width.
programCase('program-token-id-and-executable');
programCase('program-same-key-not-executable', x => { x.accounts[2].executable = 0; });
for (let chunk = 0; chunk < 4; ++chunk) programCase(`program-key-mismatch-chunk-${chunk}`, x => {
  x.accounts[2].key[chunk * 8 + 3] ^= 0x81;
});
custodyCase('custody-correct-seeds-key-and-bump');
custodyCase('custody-token-program-failure-precedes-pda-error', x => {
  x.accounts[2].executable = 0; x.pdaError = U64_MAX;
});
for (let chunk = 0; chunk < 4; ++chunk) custodyCase(`custody-pda-key-mismatch-chunk-${chunk}`, x => {
  x.pdaKey[chunk * 8 + 5] ^= 0x22;
});
for (const rc of [1n, 0x1_0000_0000n, 0x1_0000_0000_00bn, U64_MAX]) custodyCase(`custody-pda-error-${rc}`, x => {
  x.pdaError = rc; x.initialBump = 0x75;
});

// Supported transfer/check/issuance/burn modes and unsupported-tag precedence.
validateCase('validate-inactive-ignores-all-effect-garbage', x => {
  x.transfer.active = 0; x.transfer.mint = U32_MAX; x.transfer.source = U32_MAX;
  x.transfer.destination = U32_MAX; x.transfer.authority = U32_MAX; x.transfer.recipient = U32_MAX;
  x.accounts[6].size = 0n;
});
validateCase('validate-transfer-actor-authority');
validateCase('validate-transfer-custody-authority', x => { setTransfer(x, { authority: 1, recipient: 1 }); });
validateCase('validate-check-mint-tag-two-ignores-other-fields', x => {
  x.transfer.active = 2; x.transfer.source = U32_MAX; x.transfer.destination = U32_MAX;
  x.transfer.authority = U32_MAX; x.transfer.recipient = U32_MAX; x.transfer.initialize = U32_MAX;
  x.transfer.sourceBound = U32_MAX; x.transfer.destinationBound = U32_MAX; x.transfer.freshDestination = U32_MAX;
  x.accounts[6].writable = 0; putLe(x.accounts[6].data, 0, 0, 4); putLe(x.accounts[6].data, 46, 1, 4);
});
validateCase('validate-issuance-initialize-zero-supply', x => {
  x.transfer.active = 3; x.transfer.authority = 1; x.transfer.destination = 5; x.transfer.initialize = 1;
  setTransfer(x, {});
});
validateCase('validate-issuance-existing-supply-when-not-initializing', x => {
  x.transfer.active = 3; x.transfer.authority = 1; x.transfer.destination = 5; x.transfer.initialize = 0;
  setTransfer(x, {});
});
validateCase('validate-burn-actor-owns-and-signs-source', x => {
  x.transfer.active = 4; x.transfer.authority = 0; x.transfer.source = 4;
  setTransfer(x, {});
});
validateCase('validate-invalid-tag-after-valid-mint', x => { x.transfer.active = 5; });

// Helper-only acceptance: these fields are ignored by token.h for Mint/Burn.
validateCase('helper-only-issuance-authority-field-ignored', x => {
  x.helperOnly = true; x.transfer.active = 3; x.transfer.authority = 0; x.transfer.destination = 5;
  setTransfer(x, {});
});
validateCase('helper-only-burn-authority-field-ignored', x => {
  x.helperOnly = true; x.transfer.active = 4; x.transfer.authority = 1; x.transfer.source = 4;
  setTransfer(x, {});
});
validateCase('helper-only-issuance-unused-source-binding-fields-ignored', x => {
  x.helperOnly = true; x.transfer.active = 3; x.transfer.authority = 1; x.transfer.destination = 5;
  x.transfer.source = U32_MAX; x.transfer.sourceBound = U32_MAX; x.transfer.destinationBound = U32_MAX;
  x.transfer.freshDestination = U32_MAX; setTransfer(x, {});
});
validateCase('helper-only-burn-unused-destination-recipient-fields-ignored', x => {
  x.helperOnly = true; x.transfer.active = 4; x.transfer.authority = 0; x.transfer.source = 4;
  x.transfer.destination = U32_MAX; x.transfer.recipient = U32_MAX; x.transfer.initialize = U32_MAX;
  x.transfer.sourceBound = U32_MAX; x.transfer.freshDestination = U32_MAX; setTransfer(x, {});
});

// Error precedence, count/index edges, ownership, exact sizes and data flags.
validateCase('precedence-mint-index-before-account-fields', x => { x.transfer.mint = U32_MAX; });
validateCase('precedence-mint-owner-before-size', x => {
  setTransfer(x, {}); x.accounts[6].owner[0] ^= 0x80; x.accounts[6].size = 0n;
});
validateCase('precedence-mint-executable-before-size', x => { setTransfer(x, {}); x.accounts[6].executable = 1; x.accounts[6].size = 0n; });
validateCase('precedence-mint-size-before-initialized-read', x => { setTransfer(x, {}); x.accounts[6].size = 0n; });
validateCase('precedence-mint-initialized-before-mint-key', x => {
  setTransfer(x, {}); x.accounts[6].data[45] = 0; x.transfer.mintKey[0] ^= 1;
});
validateCase('precedence-mint-key-before-tag-invalid', x => { x.transfer.active = 9; x.transfer.mintKey[31] ^= 0x10; });
validateCase('mint-index-three-is-out-of-range', x => { x.transfer.mint = 3; });
validateCase('mint-index-four-count-four-is-out-of-range', x => { x.count = 4; x.transfer.mint = 4; });
for (let count = 5; count <= 12; ++count) validateCase(`mint-index-last-of-count-${count}-valid-check`, x => {
  x.count = count; x.transfer.active = 2; x.transfer.mint = count - 1;
  setMint(x, count - 1); x.transfer.mintKey = Buffer.from(x.accounts[count - 1].key);
});
validateCase('mint-index-equal-to-count-is-out-of-range', x => { x.count = 8; x.transfer.mint = 8; });
validateCase('helper-only-validator-does-not-enforce-adapter-count-maximum', x => {
  x.helperOnly = true; x.count = 13; x.transfer.active = 2; x.transfer.mint = 6;
});
validateCase('mint-wrong-owner');
validateCase('mint-executable');
validateCase('mint-size-81', x => { x.accounts[6].size = 81n; });
validateCase('mint-size-83', x => { x.accounts[6].size = 83n; });
validateCase('mint-not-initialized', x => { x.accounts[6].data[45] = 0; });
validateCase('mint-key-mismatch-last-chunk', x => { x.transfer.mintKey[31] ^= 0x40; });
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`mint-key-mismatch-chunk-${chunk}`, x => {
  x.transfer.mintKey[chunk * 8 + 3] ^= 0x40;
});

for (const state of [1, 2]) validateCase(`transfer-token-state-accepted-${state}`, x => {
  x.accounts[4].data[108] = state; x.accounts[5].data[108] = state;
});
validateCase('transfer-source-and-destination-binding-match', x => {
  x.transfer.sourceBound = 1; x.transfer.sourceKey = Buffer.from(x.accounts[4].key);
  x.transfer.destinationBound = 1; x.transfer.destinationKey = Buffer.from(x.accounts[5].key);
});
validateCase('transfer-fresh-destination-contract-satisfied', x => {
  x.transfer.freshDestination = 1; x.transfer.recipient = 1; setTransfer(x, {});
  putLe(x.accounts[5].data, 64, 0n, 8);
});
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`transfer-source-mint-reference-chunk-${chunk}`, x => {
  x.accounts[4].data[chunk * 8 + 5] ^= 0x20;
});
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`transfer-destination-mint-reference-chunk-${chunk}`, x => {
  x.accounts[5].data[chunk * 8 + 5] ^= 0x20;
});
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`transfer-source-bound-key-chunk-${chunk}`, x => {
  x.transfer.sourceBound = 1; x.transfer.sourceKey = Buffer.from(x.accounts[4].key); x.transfer.sourceKey[chunk * 8 + 3] ^= 1;
});
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`transfer-destination-bound-key-chunk-${chunk}`, x => {
  x.transfer.destinationBound = 1; x.transfer.destinationKey = Buffer.from(x.accounts[5].key); x.transfer.destinationKey[chunk * 8 + 3] ^= 1;
});
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`transfer-source-authority-owner-chunk-${chunk}`, x => {
  x.accounts[4].data[32 + chunk * 8 + 3] ^= 1;
});
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`transfer-recipient-owner-chunk-${chunk}`, x => {
  x.accounts[5].data[32 + chunk * 8 + 3] ^= 1;
});
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`transfer-custom-recipient-key-chunk-${chunk}`, x => {
  x.transfer.recipient = 2; x.transfer.recipientKey = Buffer.from(x.accounts[5].data.subarray(32, 64));
  x.transfer.recipientKey[chunk * 8 + 3] ^= 1;
});
validateCase('transfer-source-and-destination-binding-match', x => {
  x.transfer.sourceBound = 1; x.transfer.sourceKey = Buffer.from(x.accounts[4].key);
  x.transfer.destinationBound = 1; x.transfer.destinationKey = Buffer.from(x.accounts[5].key);
});
validateCase('transfer-fresh-destination-contract-satisfied', x => {
  x.transfer.freshDestination = 1; x.transfer.recipient = 1; setTransfer(x, {});
  putLe(x.accounts[5].data, 64, 0n, 8);
});
for (const [name, mutate] of [
  ['source-not-writable', (x: Input) => { x.accounts[4].writable = 0; }],
  ['destination-not-writable', (x: Input) => { x.accounts[5].writable = 0; }],
  ['source-owner-mismatch', (x: Input) => { x.accounts[4].owner[7] ^= 0x11; }],
  ['destination-owner-mismatch', (x: Input) => { x.accounts[5].owner[22] ^= 0x10; }],
  ['source-executable', (x: Input) => { x.accounts[4].executable = 1; }],
  ['destination-executable', (x: Input) => { x.accounts[5].executable = 1; }],
  ['source-size-short', (x: Input) => { x.accounts[4].size = 164n; }],
  ['destination-size-long', (x: Input) => { x.accounts[5].size = 166n; }],
  ['source-uninitialized', (x: Input) => { x.accounts[4].data[108] = 0; }],
  ['destination-invalid-state', (x: Input) => { x.accounts[5].data[108] = 3; }],
  ['source-delegate-present', (x: Input) => { putLe(x.accounts[4].data, 72, 1, 4); }],
  ['destination-delegate-present', (x: Input) => { putLe(x.accounts[5].data, 72, 1, 4); }],
  ['source-native-option-present', (x: Input) => { putLe(x.accounts[4].data, 109, 1, 4); }],
  ['destination-native-option-present', (x: Input) => { putLe(x.accounts[5].data, 109, 1, 4); }],
  ['source-mint-binding-mismatch', (x: Input) => { x.accounts[4].data[31] ^= 0x80; }],
  ['destination-mint-binding-mismatch', (x: Input) => { x.accounts[5].data[24] ^= 0x80; }],
  ['source-bound-key-mismatch', (x: Input) => { x.transfer.sourceBound = 1; x.transfer.sourceKey = Buffer.from(x.accounts[4].key); x.transfer.sourceKey[31] ^= 0x01; }],
  ['destination-bound-key-mismatch', (x: Input) => { x.transfer.destinationBound = 1; x.transfer.destinationKey = Buffer.from(x.accounts[5].key); x.transfer.destinationKey[0] ^= 0x01; }],
  ['fresh-recipient-not-custody', (x: Input) => { x.transfer.freshDestination = 1; }],
  ['fresh-destination-nonzero-amount', (x: Input) => { x.transfer.freshDestination = 1; putLe(x.accounts[5].data, 64, 1, 8); }],
  ['fresh-destination-ignored-delegated-amount-field', (x: Input) => {
    x.helperOnly = true; x.transfer.freshDestination = 1; x.transfer.recipient = 1; setTransfer(x, {});
    putLe(x.accounts[5].data, 64, 0, 8); putLe(x.accounts[5].data, 121, 1, 8);
  }],
  ['fresh-destination-close-authority', (x: Input) => { x.transfer.freshDestination = 1; putLe(x.accounts[5].data, 129, 1, 4); }],
  ['actor-authority-missing-signature', (x: Input) => { x.accounts[1].signer = 0; }],
  ['actor-authority-key-mismatch', (x: Input) => { x.accounts[4].data[32] ^= 0x80; }],
  ['recipient-actor-key-mismatch', (x: Input) => { x.accounts[5].data[32] ^= 0x80; }],
  ['recipient-custom-key-mismatch', (x: Input) => { x.transfer.recipient = 2; x.transfer.recipientKey = Buffer.from(x.accounts[5].data.subarray(32, 64)); x.transfer.recipientKey[30] ^= 1; }],
  ['invalid-authority-value', (x: Input) => { x.transfer.authority = 2; }],
  ['invalid-recipient-value', (x: Input) => { x.transfer.recipient = 3; }],
  ['invalid-binding-flag', (x: Input) => { x.transfer.sourceBound = U32_MAX; }],
  ['invalid-freshness-flag', (x: Input) => { x.transfer.freshDestination = 2; }],
  ['source-index-three-rejected', (x: Input) => { x.transfer.source = 3; }],
  ['destination-index-three-rejected', (x: Input) => { x.transfer.destination = 3; }],
  ['source-equal-count-rejected', (x: Input) => { x.count = 8; x.transfer.source = 8; }],
  ['destination-equal-count-rejected', (x: Input) => { x.transfer.destination = x.count; }],
  ['source-equals-destination-rejected', (x: Input) => { x.transfer.destination = x.transfer.source; }],
  ['source-equals-mint-rejected', (x: Input) => { x.transfer.source = x.transfer.mint; }],
  ['destination-equals-mint-rejected', (x: Input) => { x.transfer.destination = x.transfer.mint; }],
  ['count-four-rejects-normal-token-indices', (x: Input) => { x.count = 4; }],
] as const) validateCase(`transfer-${name}`, x => { setTransfer(x, {}); mutate(x); });

// Transfer check and issuance/burn ownership, authority, supply and key chunks.
validateCase('issuance-mint-readonly', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.accounts[6].writable = 0; });
validateCase('issuance-no-mint-authority-option', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); putLe(x.accounts[6].data, 0, 0, 4); });
validateCase('issuance-mint-authority-key-mismatch', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.accounts[6].data[35] ^= 1; });
for (let chunk = 0; chunk < 4; ++chunk) validateCase(`issuance-mint-authority-key-chunk-${chunk}`, x => {
  x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.accounts[6].data[4 + chunk * 8 + 2] ^= 1;
});
validateCase('issuance-freeze-authority-option', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); putLe(x.accounts[6].data, 46, 1, 4); });
validateCase('issuance-init-nonzero-supply', x => { x.transfer.active = 3; x.transfer.authority = 1; x.transfer.initialize = 1; setTransfer(x, {}); putLe(x.accounts[6].data, 36, 2n, 8); });
validateCase('issuance-init-flag-out-of-range-after-token-key', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.transfer.initialize = 2; });
validateCase('issuance-destination-index-out-of-range', x => { x.transfer.active = 3; x.transfer.authority = 1; x.transfer.destination = 8; setTransfer(x, {}); x.count = 8; });
validateCase('issuance-destination-equals-mint', x => { x.transfer.active = 3; x.transfer.authority = 1; x.transfer.destination = 6; setTransfer(x, {}); });
validateCase('issuance-destination-readonly', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.accounts[5].writable = 0; });
validateCase('issuance-destination-wrong-owner', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.accounts[5].owner[0] ^= 1; });
validateCase('issuance-destination-wrong-mint', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.accounts[5].data[4] ^= 0x10; });
validateCase('issuance-recipient-custom-owner', x => {
  x.transfer.active = 3; x.transfer.authority = 1; x.transfer.recipient = 2; x.transfer.recipientKey = key(220); setTransfer(x, {});
  x.transfer.recipientKey.copy(x.accounts[5].data, 32);
});
validateCase('issuance-invalid-recipient-precedes-owner', x => {
  x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.transfer.recipient = 3; x.accounts[5].data[32] ^= 1;
});
validateCase('issuance-destination-invalid-status', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.accounts[5].data[108] = 0; });
validateCase('issuance-destination-delegate', x => { x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); putLe(x.accounts[5].data, 72, 1, 4); });
validateCase('issuance-size-error-before-destination-data', x => {
  x.transfer.active = 3; x.transfer.authority = 1; setTransfer(x, {}); x.accounts[5].size = 0n;
});
validateCase('burn-source-owner-mismatch', x => { x.transfer.active = 4; x.transfer.authority = 0; setTransfer(x, {}); x.accounts[4].data[32] ^= 1; });
validateCase('burn-actor-not-signer', x => { x.transfer.active = 4; x.transfer.authority = 0; setTransfer(x, {}); x.accounts[1].signer = 0; });
validateCase('burn-source-readonly', x => { x.transfer.active = 4; x.transfer.authority = 0; setTransfer(x, {}); x.accounts[4].writable = 0; });
validateCase('burn-index-out-of-range', x => { x.transfer.active = 4; x.transfer.authority = 0; x.transfer.source = 8; setTransfer(x, {}); x.count = 8; });
validateCase('burn-source-equals-mint', x => { x.transfer.active = 4; x.transfer.authority = 0; x.transfer.source = 6; setTransfer(x, {}); });
validateCase('burn-state-size-and-mint-order', x => {
  x.transfer.active = 4; x.transfer.authority = 0; setTransfer(x, {}); x.accounts[4].size = 1n;
  x.accounts[4].data[0] ^= 1;
});

function extractedForExecution(t: Transfer): boolean {
  return (t.active === 1 && (t.authority === 0 || t.authority === 1) && t.recipient <= 2 &&
      t.sourceBound <= 1 && t.destinationBound <= 1 && t.freshDestination <= 1) ||
    (t.active === 3 && t.authority === 1 && t.recipient <= 2 && t.initialize <= 1) ||
    (t.active === 4 && t.authority === 0);
}
function extractedNone(t: Transfer): boolean {
  return [t.active, t.source, t.destination, t.mint, t.authority, t.recipient, t.initialize, t.sourceBound,
    t.destinationBound, t.freshDestination].every(v => v === 0) && t.amount === 0n &&
    [t.mintKey, t.recipientKey, t.sourceKey, t.destinationKey].every(k => k.equals(Buffer.alloc(32)));
}
function extractedCheckMint(t: Transfer, a: Account[]): boolean {
  return t.active === 2 && t.source === 0 && t.destination === 0 && t.authority === 0 && t.recipient === 0 &&
    t.amount === 0n && t.initialize === 0 && t.sourceBound === 0 && t.destinationBound === 0 && t.freshDestination === 0 &&
    t.recipientKey.equals(Buffer.alloc(32)) && t.sourceKey.equals(Buffer.alloc(32)) && t.destinationKey.equals(Buffer.alloc(32)) &&
    t.mintKey.equals(a[t.mint]?.key ?? Buffer.alloc(0));
}
function executeCase(name: string, mutate: (x: Input) => void = () => {}) {
  const x = fresh(name, 'execute'); mutate(x);
  const valid = expectedValidation(x.transfer, x.accounts, x.count);
  assert.equal(valid, 0n, `${name}: generated executor input satisfies token contract`);
  assert(extractedForExecution(x.transfer), `${name}: generated executor input satisfies effect extraction contract`);
  add(x);
}

// Actual executor calls are restricted to helper-valid, extractor-representable effects.
for (let count = 7; count <= 12; ++count) executeCase(`execute-transfer-count-${count}`, x => {
  x.count = count;
  const source = count - 3, destination = count - 2, mint = count - 1;
  setTransfer(x, { active: 1, source, destination, mint, amount: BigInt(count) * 0x1_0000_0001n,
    authority: count % 2, recipient: count % 3 });
});
executeCase('execute-transfer-custom-recipient-and-u64-max', x => {
  x.transfer.recipient = 2; x.transfer.recipientKey = key(244); x.transfer.amount = U64_MAX; setTransfer(x, {});
  x.transfer.recipientKey.copy(x.accounts[5].data, 32);
});
executeCase('execute-transfer-zero-amount-decimals-zero', x => {
  x.transfer.amount = 0n; setTransfer(x, {}); x.accounts[6].data[44] = 0;
});
executeCase('execute-transfer-pda-authority', x => { setTransfer(x, { authority: 1, recipient: 1 }); });
executeCase('execute-mint-custody-authority-and-amount', x => {
  x.transfer.active = 3; x.transfer.authority = 1; x.transfer.destination = 5; x.transfer.initialize = 1;
  x.transfer.amount = 0x1_0000_0000_0000_123n; setTransfer(x, {});
});
executeCase('execute-mint-to-existing-custody-recipient', x => {
  x.transfer.active = 3; x.transfer.authority = 1; x.transfer.destination = 5; x.transfer.recipient = 1;
  x.transfer.initialize = 0; x.transfer.amount = U64_MAX; setTransfer(x, {});
});
executeCase('execute-burn-actor-signature-with-no-pda-signer', x => {
  x.transfer.active = 4; x.transfer.authority = 0; x.transfer.source = 4; x.transfer.amount = 0x1_0000_0000n; setTransfer(x, {});
});
executeCase('execute-returns-full-u64-syscall-error', x => {
  x.transfer.active = 4; x.transfer.authority = 0; x.transfer.source = 4; setTransfer(x, {}); x.invokeError = U64_MAX;
});
executeCase('execute-returns-wide-syscall-error', x => {
  x.transfer.active = 1; setTransfer(x, {}); x.invokeError = 0x1_0000_0000_123n;
});
executeCase('execute-normalizes-noncanonical-accountinfo-flags', x => {
  x.accounts[1].signer = 0x8000_0000; x.accounts[2].executable = U32_MAX;
  x.accounts[4].writable = 0x8000_0001; x.accounts[5].writable = U32_MAX;
  x.accounts[6].writable = 0x8000_0000;
});

// The executor short-circuits inactive and non-executing variants without a syscall.
for (const active of [0, 2]) {
  const x = fresh(`execute-no-invoke-active-${active}`, 'execute'); x.transfer.active = active;
  if (active === 0) {
    x.transfer.source = 0; x.transfer.destination = 0; x.transfer.mint = 0; x.transfer.authority = 0; x.transfer.recipient = 0;
    x.transfer.mintKey.fill(0); x.transfer.recipientKey.fill(0); x.transfer.amount = 0n; x.transfer.initialize = 0;
    x.transfer.sourceBound = 0; x.transfer.destinationBound = 0; x.transfer.freshDestination = 0;
    x.transfer.sourceKey.fill(0); x.transfer.destinationKey.fill(0);
  } else {
    x.transfer.source = 0; x.transfer.destination = 0; x.transfer.mint = 6; x.transfer.authority = 0; x.transfer.recipient = 0;
    x.transfer.mintKey = Buffer.from(x.accounts[6].key); x.transfer.recipientKey.fill(0); x.transfer.amount = 0n; x.transfer.initialize = 0;
    x.transfer.sourceBound = 0; x.transfer.destinationBound = 0; x.transfer.freshDestination = 0;
    x.transfer.sourceKey.fill(0); x.transfer.destinationKey.fill(0);
  }
  add(x);
}

function expectedValidation(t: Transfer, a: Account[], count: number): bigint {
  if (!t.active) return 0n;
  if (t.mint < 4 || t.mint >= count) return 12n;
  const mint = a[t.mint];
  if (!same(mint.owner, a[2].key) || mint.executable) return 13n;
  if (mint.size !== 82n || mint.data[45] !== 1) return 14n;
  if (!same(mint.key, t.mintKey)) return 15n;
  if (t.active === 2) return 0n;
  if (t.active === 3 || t.active === 4) {
    if (!mint.writable) return 5n;
    if (readLe(mint.data, 0, 4) !== 1n || !same(mint.data.subarray(4, 36), a[3].key) || readLe(mint.data, 46, 4) !== 0n) return 23n;
    if (t.active === 3 && t.initialize && readLe(mint.data, 36, 8) !== 0n) return 24n;
    const index = t.active === 3 ? t.destination : t.source;
    if (index < 4 || index >= count || index === t.mint) return 12n;
    const token = a[index];
    if (!token.writable) return 5n;
    if (!same(token.owner, a[2].key) || token.executable) return 13n;
    if (token.size !== 165n || (token.data[108] !== 1 && token.data[108] !== 2) || readLe(token.data, 109, 4) !== 0n) return 14n;
    if (!same(token.data.subarray(0, 32), mint.key)) return 15n;
    if (t.active === 4) return !a[1].signer || !same(token.data.subarray(32, 64), a[1].key) ? 16n : 0n;
    if (t.recipient > 2 || t.initialize > 1) return 9n;
    const recipient = t.recipient === 2 ? t.recipientKey : a[t.recipient ? 3 : 1].key;
    return same(token.data.subarray(32, 64), recipient) ? 0n : 17n;
  }
  if (t.active !== 1) return 9n;
  if (t.source < 4 || t.destination < 4 || t.source >= count || t.destination >= count ||
      t.source === t.destination || t.source === t.mint || t.destination === t.mint) return 12n;
  const src = a[t.source], dst = a[t.destination];
  if (!src.writable || !dst.writable) return 5n;
  if (!same(src.owner, a[2].key) || !same(dst.owner, a[2].key) || !same(mint.owner, a[2].key) ||
      src.executable || dst.executable || mint.executable) return 13n;
  if (src.size !== 165n || dst.size !== 165n || mint.size !== 82n || mint.data[45] !== 1 ||
      (src.data[108] !== 1 && src.data[108] !== 2) || (dst.data[108] !== 1 && dst.data[108] !== 2) ||
      readLe(src.data, 109, 4) !== 0n || readLe(dst.data, 109, 4) !== 0n) return 14n;
  if (!same(mint.key, t.mintKey) || !same(src.data.subarray(0, 32), mint.key) || !same(dst.data.subarray(0, 32), mint.key)) return 15n;
  if (t.sourceBound > 1 || t.destinationBound > 1 || t.freshDestination > 1) return 9n;
  if ((t.sourceBound && !same(src.key, t.sourceKey)) || (t.destinationBound && !same(dst.key, t.destinationKey))) return 25n;
  if (t.freshDestination && (readLe(dst.data, 64, 8) !== 0n || readLe(dst.data, 72, 4) !== 0n ||
      readLe(dst.data, 129, 4) !== 0n || !same(dst.data.subarray(32, 64), a[3].key))) return 26n;
  if (t.authority > 1 || t.recipient > 2) return 9n;
  const authority = a[t.authority ? 3 : 1].key;
  if ((!t.authority && !a[1].signer) || !same(src.data.subarray(32, 64), authority)) return 16n;
  const recipient = t.recipient === 2 ? t.recipientKey : a[t.recipient ? 3 : 1].key;
  return same(dst.data.subarray(32, 64), recipient) ? 0n : 17n;
}
const validate = expectedValidation;

function programOk(a: Account) { return !!a.executable && same(a.key, TOKEN_ID); }
function expectedCustody(x: Input) {
  if (!programOk(x.accounts[2])) return { result: 10n, calls: 0n, bump: x.initialBump, pda: null as unknown };
  const success = x.pdaError === 0n;
  const outBump = success ? x.pdaBump : x.initialBump;
  return { result: !success || !same(x.pdaKey, x.accounts[3].key) ? 11n : 0n, calls: 1n, bump: outBump,
    pda: { program: hex(x.pdaProgram), seedCount: 2,
      seeds: [{ length: '4', data: hex(PREFIX) }, { length: '32', data: hex(x.accounts[0].key) }],
      returnedKey: hex(success ? x.pdaKey : Buffer.alloc(32)), returnedBump: success ? x.pdaBump : 0, outBump } };
}
function commonExpected(x: Input) {
  let result = 0n, validation = 0n, custodyResult = 0n, pdaCalls = 0n, invokeCalls = 0n, bump = x.initialBump;
  let pda: unknown = null, call: unknown = null;
  if (x.operation === 'program') result = programOk(x.accounts[2]) ? 0n : 10n;
  if (x.operation === 'custody') {
    const c = expectedCustody(x); result = custodyResult = c.result; pdaCalls = c.calls; bump = c.bump; pda = c.pda;
  }
  if (x.operation === 'validate') result = validate(x.transfer, x.accounts, x.count);
  if (x.operation === 'execute') {
    const c = expectedCustody(x); custodyResult = c.result; pdaCalls = c.calls; bump = c.bump; pda = c.pda;
    result = custodyResult;
    if (custodyResult === 0n) validation = validate(x.transfer, x.accounts, x.count);
    if (custodyResult === 0n) result = validation;
    if (custodyResult === 0n && validation === 0n && x.transfer.active === 0) assert(extractedNone(x.transfer), `${x.name}: None extraction precondition`);
    if (custodyResult === 0n && validation === 0n && x.transfer.active === 2) assert(extractedCheckMint(x.transfer, x.accounts), `${x.name}: CheckMint extraction precondition`);
    if (custodyResult === 0n && validation === 0n && [1, 3, 4].includes(x.transfer.active)) {
      assert(extractedForExecution(x.transfer), `${x.name}: executor input remains extraction-valid`);
      invokeCalls = 1n;
      const t = x.transfer, a = x.accounts;
      const infos = a.slice(0, x.count).map((v, i) => ({ key: hex(v.key), owner: hex(v.owner), lamports: dec(v.lamports),
        dataLength: dec(v.size), rentEpoch: dec(v.rentEpoch), signer: Number(!!v.signer), writable: Number(!!v.writable),
        executable: Number(!!v.executable), keyPointerOk: 1, lamportsPointerOk: 1, dataPointerOk: 1, ownerPointerOk: 1 }));
      const metas = t.active === 1 ? [
        { index: t.source, writable: 1, signer: 0 }, { index: t.mint, writable: 0, signer: 0 },
        { index: t.destination, writable: 1, signer: 0 }, { index: t.authority ? 3 : 1, writable: 0, signer: 1 },
      ] : t.active === 3 ? [
        { index: t.mint, writable: 1, signer: 0 }, { index: t.destination, writable: 1, signer: 0 },
        { index: 3, writable: 0, signer: 1 },
      ] : [
        { index: t.source, writable: 1, signer: 0 }, { index: t.mint, writable: 1, signer: 0 },
        { index: 1, writable: 0, signer: 1 },
      ];
      const opcode = t.active === 1 ? 12 : t.active === 3 ? 14 : 15;
      const payload = Buffer.alloc(10); payload[0] = opcode; putLe(payload, 1, t.amount, 8); payload[9] = a[t.mint].data[44];
      const signerCount = t.active === 3 ? 1 : t.authority ? 1 : 0;
      const signerSeeds = [{ length: '4', data: hex(PREFIX) }, { length: '32', data: hex(a[0].key) },
        { length: '1', data: hex(Buffer.from([bump])) }];
      call = { rawInfoCount: x.count, rawMetaCount: String(metas.length), rawSignerCount: signerCount,
        infoCount: x.count, metaCount: metas.length, programPointerOk: 1, accountsPointerPresent: 1, dataPointerPresent: 1,
        signerCount, signerSeedCount: 3, signerSeeds, instructionLength: '10', syscallError: dec(x.invokeError),
        program: hex(a[2].key), data: hex(payload), metas: metas.map(m => ({ ...m, keyPointerOk: 1, key: hex(a[m.index].key) })), infos };
      result = x.invokeError;
    }
  }
  const accountResult = x.accounts.map(a => {
    const n = Math.min(165, Number(x.exactAllocations ? a.size : 165n));
    return { key: hex(a.key), owner: hex(a.owner), size: dec(a.size), lamports: dec(a.lamports), rentEpoch: dec(a.rentEpoch),
      signer: a.signer, writable: a.writable, executable: a.executable, keyPointerUnchanged: 1, ownerPointerUnchanged: 1,
      dataPointerUnchanged: 1, lamportsPointerUnchanged: 1, data: hex(a.data.subarray(0, n)) };
  });
  return { id: x.id, result: dec(result), validation: dec(validation), custodyResult: dec(custodyResult), pdaCalls: dec(pdaCalls), invokeCalls: dec(invokeCalls),
    bump, pda, call, effectUnchanged: 1, accounts: accountResult };
}

function writer() {
  const chunks: Buffer[] = [];
  return {
    u8(n: number) { const b = Buffer.alloc(1); b.writeUInt8(n); chunks.push(b); },
    u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); chunks.push(b); },
    u64(n: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); chunks.push(b); },
    bytes(b: Buffer) { chunks.push(Buffer.from(b)); },
    done() { return Buffer.concat(chunks); },
  };
}
function encodeInput(x: Input): Buffer {
  const w = writer();
  w.u32(x.id); w.u32(tokenTag(x.operation)); w.u32(x.count); w.u32(Number(x.exactAllocations));
  const t = x.transfer;
  for (const n of [t.active, t.source, t.destination, t.mint, t.authority, t.recipient]) w.u32(n);
  w.bytes(t.mintKey); w.bytes(t.recipientKey); w.u64(t.amount);
  for (const n of [t.initialize, t.sourceBound, t.destinationBound, t.freshDestination]) w.u32(n);
  w.bytes(t.sourceKey); w.bytes(t.destinationKey);
  w.bytes(x.pdaProgram); w.bytes(x.pdaKey); w.u64(x.pdaError); w.u64(x.invokeError); w.u8(x.pdaBump); w.u8(x.initialBump);
  for (const a of x.accounts) {
    w.bytes(a.key); w.bytes(a.owner); w.bytes(a.data); w.u64(a.size); w.u64(a.lamports); w.u64(a.rentEpoch);
    w.u32(a.signer); w.u32(a.writable); w.u32(a.executable);
  }
  const b = w.done(); assert.equal(b.length, 3454, `${x.name}: wire size`); return b;
}
function firstDifference(want: unknown, got: unknown, at = '$'): { path: string; expected: unknown; observed: unknown } | undefined {
  if (want === got) return undefined;
  if (typeof want !== typeof got || want === null || got === null || typeof want !== 'object') return { path: at, expected: want, observed: got };
  if (Array.isArray(want) !== Array.isArray(got)) return { path: at, expected: want, observed: got };
  const wk = Object.keys(want as object), gk = Object.keys(got as object);
  if (wk.length !== gk.length || wk.some(k => !gk.includes(k))) return { path: `${at}.$keys`, expected: wk, observed: gk };
  for (const k of wk) { const d = firstDifference((want as Record<string, unknown>)[k], (got as Record<string, unknown>)[k], `${at}.${k}`); if (d) return d; }
  return undefined;
}

type Mutant = { name: string; file: 'token.h' | 'solana_min.h'; from: string; to: string; occurrence?: number };
const mutants: Mutant[] = [
  { name: "executor-raw-account-count-exceeds-capacity", file: 'token.h', from: "(int)count,&signer,t->authority ? 1 : 0", to: "13,&signer,t->authority ? 1 : 0" },
  { name: "executor-raw-meta-count-exceeds-capacity", file: 'token.h', from: "metas,meta_count,data,10", to: "metas,5,data,10" },
  { name: "executor-negative-signer-count", file: 'token.h', from: "(int)count,&signer,t->authority ? 1 : 0", to: "(int)count,&signer,-1" },
  { name: "executor-mutates-state-metadata-after-call", file: 'token.h', from: "return sol_invoke_signed_c(&ix,infos,(int)count,&signer,t->authority ? 1 : 0);", to: "u64 error = sol_invoke_signed_c(&ix,infos,(int)count,&signer,t->authority ? 1 : 0); a[0].size ^= 1; return error;" },
  { name: 'inactive-validator-mutates-effect', file: 'token.h', from: 'if (!t->active) return 0;', to: 'if (!t->active) { ((BendTransfer *)t)->amount ^= 1; return 0; }' },
  { name: 'token-program-executable-gate-removed', file: 'token.h', from: 'return a->executable && equal_key(a->key, key);', to: 'return equal_key(a->key, key);' },
  { name: 'key-equality-skips-final-eight-byte-chunk', file: 'solana_min.h', from: 'i < 32; i += 8', to: 'i < 24; i += 8' },
  { name: 'custody-program-gate-removed', file: 'token.h', from: 'if (!bend_token_program(&accounts[2])) return 10;', to: 'if (0) return 10;' },
  { name: 'custody-seed-uses-actor-key', file: 'token.h', from: 'BendSeed seeds[2] = {{prefix,4},{accounts[0].key,32}};', to: 'BendSeed seeds[2] = {{prefix,4},{accounts[1].key,32}};' },
  { name: 'mint-owner-check-removed', file: 'token.h', from: 'if (!equal_key(mint->owner,a[2].key) || mint->executable) return 13;', to: 'if (mint->executable) return 13;' },
  { name: 'inactive-tag-no-longer-short-circuits', file: 'token.h', from: 'if (!t->active) return 0;', to: 'if (!t->active) return 9;' },
  { name: 'check-mint-tag-two-rejected', file: 'token.h', from: 'if (t->active == 2) return 0;', to: 'if (t->active == 2) return 9;' },
  { name: 'mint-writable-gate-removed', file: 'token.h', from: 'if (!mint->writable) return 5;', to: 'if (0) return 5;' },
  { name: 'issuance-pda-authority-check-removed', file: 'token.h', from: '!equal_key(mint->data+4,a[3].key) ||', to: '0 ||' },
  { name: 'issuance-freeze-authority-check-removed', file: 'token.h', from: 'read_le(mint->data+46,4) != 0', to: '0' },
  { name: 'issuance-zero-supply-check-removed', file: 'token.h', from: 'if (t->active == 3 && t->initialize && read_le(mint->data+36,8) != 0) return 24;', to: 'if (0) return 24;' },
  { name: 'transfer-token-length-check-removed', file: 'token.h', from: 'token->size != 165 ||', to: '0 ||' },
  { name: 'transfer-freshness-check-removed', file: 'token.h', from: 'if (t->fresh_destination && (read_le(dst->data+64,8) != 0 ||', to: 'if (0 && (read_le(dst->data+64,8) != 0 ||' },
  { name: 'source-authority-check-removed', file: 'token.h', from: 'if ((!t->authority && !a[1].signer) || !equal_key(src->data+32,authority)) return 16;', to: 'if (0) return 16;' },
  { name: 'recipient-owner-check-removed', file: 'token.h', from: 'if (!equal_key(dst->data+32,recipient)) return 17;', to: 'if (0) return 17;' },
  { name: 'transfer-instruction-opcode-mutated', file: 'token.h', from: 'u8 data[10] = {12};', to: 'u8 data[10] = {13};' },
  { name: 'instruction-amount-omitted', file: 'token.h', from: 'write_le(data+1,t->amount,8);', to: 'write_le(data+1,0,8);' },
  { name: 'instruction-decimals-source-mutated', file: 'token.h', from: 'data[9] = a[t->mint].data[44];', to: 'data[9] = a[t->mint].data[45];' },
  { name: 'transfer-destination-made-readonly', file: 'token.h', from: 'metas[2]=(BendAccountMeta){a[t->destination].key,1,0};', to: 'metas[2]=(BendAccountMeta){a[t->destination].key,0,0};' },
  { name: 'mint-instruction-custody-meta-not-signer', file: 'token.h', from: 'metas[2]=(BendAccountMeta){a[3].key,0,1};', to: 'metas[2]=(BendAccountMeta){a[3].key,0,0};' },
  { name: 'instruction-uses-non-token-program', file: 'token.h', from: 'BendInstruction ix = {a[2].key,metas,meta_count,data,10};', to: 'BendInstruction ix = {a[1].key,metas,meta_count,data,10};' },
  { name: 'executor-signer-count-always-zero', file: 'token.h', from: 'return sol_invoke_signed_c(&ix,infos,(int)count,&signer,t->authority ? 1 : 0);', to: 'return sol_invoke_signed_c(&ix,infos,(int)count,&signer,0);' },
  { name: 'executor-state-seed-mutated', file: 'token.h', from: "BendSeed seeds[3] = {{prefix,4},{a[0].key,32},{&bump,1}};", to: "BendSeed seeds[3] = {{prefix,4},{a[1].key,32},{&bump,1}};" },
];
function mutate(source: string, m: Mutant): string {
  const nth = m.occurrence ?? 1;
  let at = -1, from = m.from, cursor = 0;
  for (let i = 0; i < nth; ++i) { at = source.indexOf(from, cursor); assert(at >= 0, `${m.name}: mutation anchor missing`); cursor = at + from.length; }
  return source.slice(0, at) + m.to + source.slice(at + from.length);
}

const INPUTS = [HARNESS, 'tests/token-helpers.ts', 'runtime/token.h', 'runtime/cpi_abi.h', 'runtime/solana_min.h'];
function inputHashes() { return Object.fromEntries(INPUTS.map(f => [f, sha(fs.readFileSync(path.join(ROOT, f)))])); }
const ASAN_ENV = { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1:allocator_may_return_null=0',
  UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };
function compile(cc: string, harness: string, runtime: string, binary: string) {
  const p = spawnSync(cc, [...FLAGS, `-I${runtime}`, path.join(ROOT, harness), '-o', binary],
    { encoding: 'utf8', timeout: 90_000 });
  assert(!p.error && p.status === 0, `native compile failed (${p.error?.message ?? p.status})\n${p.stderr ?? ''}`);
  return { stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}
function execute(binary: string, encoded: Buffer, expectedRows: number) {
  const p = spawnSync(binary, [], { input: encoded, encoding: 'utf8', env: ASAN_ENV,
    timeout: 180_000, maxBuffer: 256 << 20 });
  assert(!p.error && p.status === 0, `native run incomplete (${p.error?.message ?? p.status}, signal=${p.signal ?? '-'})\n${(p.stderr ?? '').slice(0, 3000)}`);
  assert.equal(p.stderr, '', `sanitizer diagnostic during native run\n${p.stderr}`);
  const lines = p.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, expectedRows, `partial native output: ${lines.length}/${expectedRows}`);
  return lines.map((line, i) => {
    try { return JSON.parse(line); } catch (e) { throw new Error(`malformed output row ${i}: ${String(e)}\n${line.slice(0, 500)}`); }
  }) as unknown[];
}

export async function testTokenHelpers() {
  fs.rmSync(path.join(OUT, 'report.json'), { force: true });
  fs.mkdirSync(RUNTIME, { recursive: true });
  const sourceHashesAtStart = inputHashes();
  for (const f of ['token.h', 'cpi_abi.h', 'solana_min.h']) {
    fs.copyFileSync(path.join(ROOT, 'runtime', f), path.join(RUNTIME, f));
    assert.equal(sha(fs.readFileSync(path.join(RUNTIME, f))), sourceHashesAtStart[`runtime/${f}`], `${f}: include copy changed`);
  }
  const cc = process.env.CC ?? 'clang';
  const compiler = spawnSync(cc, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert(!compiler.error && compiler.status === 0, `cannot query native compiler: ${compiler.error?.message ?? compiler.status}`);
  const encoded = Buffer.concat(cases.map(encodeInput));
  const want = cases.map(commonExpected);
  const binary = path.join(OUT, 'token-helpers-native');
  const compileResult = compile(cc, HARNESS, RUNTIME, binary);
  const actual = execute(binary, encoded, cases.length);
  for (let i = 0; i < want.length; ++i) {
    const d = firstDifference(want[i], actual[i]);
    assert(!d, `actual runtime token helper differs from independent contract: ${cases[i].name} ${d?.path}\nexpected=${JSON.stringify(d?.expected)} observed=${JSON.stringify(d?.observed)}`);
  }
  fs.rmSync(binary, { force: true }); fs.rmSync(`${binary}.dSYM`, { recursive: true, force: true });

  const tokenSource = fs.readFileSync(path.join(RUNTIME, 'token.h'), 'utf8');
  const solanaSource = fs.readFileSync(path.join(RUNTIME, 'solana_min.h'), 'utf8');
  const mutantDir = path.join(OUT, '.mutants');
  fs.rmSync(mutantDir, { recursive: true, force: true }); fs.mkdirSync(mutantDir, { recursive: true });
  const mutationResults: Array<{ name: string; file: string; sha256: string; completedCases: number;
    killedBy: { case: string; path: string } }> = [];
  for (let i = 0; i < mutants.length; ++i) {
    const m = mutants[i], original = m.file === 'token.h' ? tokenSource : solanaSource, mutated = mutate(original, m);
    const dir = path.join(mutantDir, String(i).padStart(2, '0'));
    const runtime = path.join(dir, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
    for (const f of ['token.h', 'cpi_abi.h', 'solana_min.h']) fs.copyFileSync(path.join(RUNTIME, f), path.join(runtime, f));
    fs.writeFileSync(path.join(runtime, m.file), mutated);
    const mutantBin = path.join(dir, 'mutant'); compile(cc, HARNESS, runtime, mutantBin);
    const observed = execute(mutantBin, encoded, cases.length);
    let killed: { case: string; path: string } | undefined;
    for (let j = 0; j < want.length; ++j) {
      const d = firstDifference(want[j], observed[j]);
      if (d) { killed = { case: cases[j].name, path: d.path }; break; }
    }
    assert(killed, `compiled mutant survived the completed ${cases.length}-case matrix: ${m.name}`);
    mutationResults.push({ name: m.name, file: m.file, sha256: sha(mutated), completedCases: cases.length, killedBy: killed });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(mutantDir, { recursive: true, force: true });

  // Separate exact-allocation probes: ordinary mutant matrices keep buffers large
  // enough to complete, while these isolate the mint and token-account read guards.
  const sanitizerProbes = [
    { name: 'mint-initialized-read-before-size', input: (() => {
      const x = fresh('sanitizer-mint-read-before-size-probe', 'validate');
      x.transfer.active = 2; x.accounts[6].size = 0n; x.exactAllocations = true; return x;
    })(), from: 'mint->size != 82 || mint->data[45] != 1', to: 'mint->data[45] != 1 || mint->size != 82' },
    { name: 'token-state-read-before-size', input: (() => {
      const x = fresh('sanitizer-token-read-before-size-probe', 'validate');
      x.accounts[4].size = 0n; x.exactAllocations = true; return x;
    })(), from: 'src->size != 165 ||', to: 'src->data[108] != 1 && src->data[108] != 2 || src->size != 165 ||' },
  ];
  const probeBinary = binaryForProbe(cc, RUNTIME, OUT, HARNESS);
  const sanitizerEvidence: Array<{ name: string; baselineResult: string; exactAllocation: number; violation: string; diagnostic: string; mutatedSourceSha256: string }> = [];
  for (const probe of sanitizerProbes) {
    const probeBytes = encodeInput(probe.input);
    const baselineProbe = execute(probeBinary, probeBytes, 1);
    assert.equal((baselineProbe[0] as any).result, '14', `${probe.name}: baseline rejects short account safely`);
    const sizeMutation = mutate(tokenSource, { name: probe.name, file: 'token.h', from: probe.from, to: probe.to });
    const probeDir = path.join(OUT, `.size-before-read-${probe.name}`), sanitizerRuntime = path.join(probeDir, 'runtime');
    fs.rmSync(probeDir, { recursive: true, force: true }); fs.mkdirSync(sanitizerRuntime, { recursive: true });
    for (const f of ['token.h', 'cpi_abi.h', 'solana_min.h']) fs.copyFileSync(path.join(RUNTIME, f), path.join(sanitizerRuntime, f));
    fs.writeFileSync(path.join(sanitizerRuntime, 'token.h'), sizeMutation);
    const sanitizerBin = path.join(probeDir, 'mutant'); compile(cc, HARNESS, sanitizerRuntime, sanitizerBin);
    const violation = spawnSync(sanitizerBin, [], { input: probeBytes, encoding: 'utf8', env: ASAN_ENV,
      timeout: 30_000, maxBuffer: 16 << 20 });
    assert(!violation.error && violation.status !== 0, `${probe.name}: reordered size/data check did not trigger a sanitizer violation`);
    const sanitizerText = `${violation.stderr ?? ''}${violation.stdout ?? ''}`;
    assert.match(sanitizerText, /READ of size 1/);
    assert.match(sanitizerText, /bend_transfer_validate/);
    assert.match(sanitizerText, /allocated by thread/);
    assert.match(sanitizerText, /AddressSanitizer: heap-buffer-overflow/,
      `${probe.name}: expected distinct sanitizer evidence\n${sanitizerText.slice(0, 3000)}`);
    sanitizerEvidence.push({ name: probe.name, baselineResult: '14', exactAllocation: Number(probe.input.accounts[probe.name.startsWith('mint') ? 6 : 4].size),
      violation: 'heap-buffer-overflow', diagnostic: sanitizerText, mutatedSourceSha256: sha(sizeMutation) });
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
  fs.rmSync(probeBinary, { force: true });

  const unchanged = inputHashes();
  assert.deepEqual(unchanged, sourceHashesAtStart, 'a hashed source input changed during the run; refusing to publish evidence');
  const copiedRuntime = Object.fromEntries(['token.h', 'cpi_abi.h', 'solana_min.h'].map(f =>
    [f, sha(fs.readFileSync(path.join(RUNTIME, f)))]));
  const report = {
    version: 1, passed: true, compiler: compiler.stdout.split('\n')[0], flags: FLAGS, bun: process.versions.bun,
    scope: 'Focused host ASan/UBSan differential execution of actual runtime/token.h program recognition, custody, transfer validation and transfer execution helpers. Only PDA derivation and invoke_signed are mocked. The TypeScript oracle independently specifies helper return precedence, SPL account-layout checks, CPI metas/payload/account-info observations and writes. Executor syscall cases satisfy both the validator contract and effect-extraction constraints; helper-only mint/burn ignored-field acceptances are validator-only. This finite native matrix does not establish SBF preservation, token-program behavior, CPI rollback, or source-to-extraction proof.',
    assumptions: ['input account count is within the adapter-supported 4..12 range for executor cases',
      'account data buffers are disjoint; ordinary semantic matrix uses 165-byte backing buffers and two isolated exact-allocation sanitizer probes',
      'SPL Token state and COption offsets match the token.h contract under test',
      'executor is called only after independent validation and extractor-compatible authority assignment (Mint authority=1; Burn authority=0)',
      'PDA and invoke_signed syscall boundaries are deterministic mocks; token-state mutation by the real program is outside this harness'],
    inputs: sourceHashesAtStart, copiedRuntime,
    matrix: { cases: cases.length, byOperation: Object.fromEntries((['program', 'custody', 'validate', 'execute'] as const).map(op =>
      [op, cases.filter(c => c.operation === op).length])), namesSha256: sha(cases.map(c => c.name).join('\n')),
      encodedInputSha256: sha(encoded), expectedSha256: sha(JSON.stringify(want)), observedSha256: sha(JSON.stringify(actual)),
      completedRows: actual.length, pdaCalls: cases.reduce((n, c) => n + ((c.operation === 'custody' || c.operation === 'execute') &&
        programOk(c.accounts[2]) ? 1 : 0), 0),
      invokeCalls: cases.reduce((n, c) => n + (c.operation === 'execute' && expectedCustody(c).result === 0n &&
        validate(c.transfer, c.accounts, c.count) === 0n && [1,3,4].includes(c.transfer.active) ? 1 : 0), 0),
      rawSyscallCountsCapturedBeforeBoundedInspection: true, accountDataWritesCompared: true,
      helperOnlyAcceptances: cases.filter(c => c.helperOnly).map(c => c.name) },
    mutations: mutationResults.length, mutationResults,
    sanitizerProbes: sanitizerEvidence,
    compilerStdout: compileResult.stdout, compilerStderr: compileResult.stderr,
  };
  const reportPath = path.join(OUT, 'report.json');
  fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n'); fs.renameSync(`${reportPath}.tmp`, reportPath);
  console.log(`Token helpers: ${cases.length} differential cases passed; ${mutationResults.length} compiled mutants rejected after complete matrices; both size-before-read probes triggered ASan; report ${reportPath}`);
}

function binaryForProbe(cc: string, runtime: string, out: string, harness: string) {
  const binary = path.join(out, 'token-helpers-probe');
  compile(cc, harness, runtime, binary);
  return binary;
}

if (import.meta.main) await testTokenHelpers();
