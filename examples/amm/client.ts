import type { RuntimeSchema } from '../../compiler/schema.ts';
import { storageCodec, type StorageInterface } from '../../sdk/storage.ts';
import type { WireValue } from '../../sdk/wire.ts';

export type Address = Uint8Array;
export type AmmAccounts = {
  state: Address; actor: Address; tokenProgram: Address; custody: Address;
  userBase: Address; baseVault: Address; baseMint: Address;
  userQuote: Address; quoteVault: Address; quoteMint: Address;
  userLp: Address; lpMint: Address;
};
export type AmmInstruction = {
  data: Uint8Array;
  accounts: { address: Address; isSigner: boolean; isWritable: boolean }[];
};
const order: (keyof AmmAccounts)[] = ['state', 'actor', 'tokenProgram', 'custody',
  'userBase', 'baseVault', 'baseMint', 'userQuote', 'quoteVault', 'quoteMint', 'userLp', 'lpMint'];

// No RPC or wallet dependency. Map these metas/data to your transaction SDK
// and supply the deployed program ID. Always load schemas from the same build.
export function ammClient(schema: RuntimeSchema, layout: StorageInterface) {
  const codec = storageCodec(schema, layout);
  const variants = schema.types.flatMap(t => t.kind === 'adt' ? t.variants : []);
  function constructor(leaf: string, fields: Record<string, WireValue>): WireValue {
    const matches = variants.filter(v => v.name.split('.').at(-1) === leaf);
    if (matches.length !== 1) throw new Error(`Expected unique AMM constructor: ${leaf}`);
    return { constructor: matches[0].name, fields };
  }
  function amount(value: bigint): WireValue {
    if (typeof value !== 'bigint' || value < 0n || value > (1n << 64n) - 1n)
      throw new Error('Amount must be an unsigned 64-bit bigint');
    return constructor('U64', { lo: Number(value & 0xffffffffn), hi: Number(value >> 32n) });
  }
  function key(address: Address): WireValue {
    if (!(address instanceof Uint8Array) || address.length !== 32) throw new Error('Address must contain 32 bytes');
    const view = new DataView(address.buffer, address.byteOffset, 32);
    return constructor('Key', Object.fromEntries('abcdefgh'.split('').map((field, i) => [field, view.getUint32(i * 4, true)])));
  }
  function instruction(accounts: AmmAccounts, value: WireValue, initialize = false): AmmInstruction {
    const seen = new Set<string>();
    const metas = order.map((name, index) => {
      const address = accounts[name]; key(address);
      const id = [...address].join(',');
      if (seen.has(id)) throw new Error('AMM accounts must be distinct');
      seen.add(id);
      return { address: address.slice(), isSigner: index === 1 || (index === 0 && initialize),
        isWritable: ![1, 2, 3, 6, 9].includes(index) };
    });
    return { data: codec.instruction(value, initialize ? 'initialize' : 'transition'), accounts: metas };
  }
  return {
    stateBytes: layout.stateBytes,
    initialize(accounts: AmmAccounts, base: bigint, quote: bigint, minShares: bigint) {
      const config = constructor('Config', { base: key(accounts.baseMint), quote: key(accounts.quoteMint),
        lp: key(accounts.lpMint), base_vault: key(accounts.baseVault), quote_vault: key(accounts.quoteVault) });
      return instruction(accounts, constructor('Initialize', { config, base: amount(base), quote: amount(quote), min_shares: amount(minShares) }), true);
    },
    deposit(accounts: AmmAccounts, shares: bigint, maxBase: bigint, maxQuote: bigint) {
      return instruction(accounts, constructor('Deposit', { shares: amount(shares), max_base: amount(maxBase), max_quote: amount(maxQuote) }));
    },
    withdraw(accounts: AmmAccounts, shares: bigint, minBase: bigint, minQuote: bigint) {
      return instruction(accounts, constructor('Withdraw', { shares: amount(shares), min_base: amount(minBase), min_quote: amount(minQuote) }));
    },
    swap(accounts: AmmAccounts, baseIn: boolean, grossInput: bigint, minOutput: bigint) {
      return instruction(accounts, constructor('Swap', { base_in: baseIn, amount: amount(grossInput), min_output: amount(minOutput) }));
    },
    account: codec.account,
    reply: codec.reply,
  };
}
