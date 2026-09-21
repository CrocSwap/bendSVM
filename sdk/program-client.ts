import type {RuntimeSchema, TypeSchema} from '../compiler/schema.ts';
import {wireCodec, type WireValue} from './wire.ts';
import {storageCodec, type StorageInterface} from './storage.ts';
import {multiStorageCodec, type MultiStorageInterface} from './multi-storage.ts';
import {collectionStorageCodec, type CollectionStorageInterface} from './collection-storage.ts';

export type ProgramLayout=StorageInterface|MultiStorageInterface|CollectionStorageInterface;
export type AccountMeta={address:string; signer:boolean; writable:boolean};
export type InstructionPlan={program:string; accounts:AccountMeta[]; data:Uint8Array};
export type CallOptions={mode?:'initialize'|'transition';remaining?:AccountMeta[]};
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function addressBytes(address:string):Uint8Array {
  if(typeof address!=='string'||!address.length||address.length>44)throw new Error('Expected a base58 Solana address');
  let n=0n;for(const c of address){const digit=alphabet.indexOf(c);if(digit<0)throw new Error('Invalid base58 address');n=n*58n+BigInt(digit);}
  const bytes:number[]=[];while(n){bytes.unshift(Number(n&255n));n>>=8n;}
  const zeros=address.length-address.replace(/^1+/,'').length;
  if(zeros+bytes.length!==32)throw new Error('Solana address must encode 32 bytes');
  return new Uint8Array([...Array(zeros).fill(0),...bytes]);
}
export function addressString(bytes:Uint8Array):string {
  if(bytes.length!==32)throw new Error('Solana address must contain 32 bytes');
  let n=0n;for(const b of bytes)n=n*256n+BigInt(b);
  let text='';while(n){text=alphabet[Number(n%58n)]+text;n/=58n;}
  let zeros=0;while(zeros<32&&bytes[zeros]===0)zeros++;
  return '1'.repeat(zeros)+text;
}
export function friendlyKind(t:TypeSchema):'key'|'u64'|undefined {
  if(t.kind!=='adt'||t.variants.length!==1)return;
  const fields=t.variants[0].fields;
  if(/(?:^|\.)Key$/.test(t.name)&&fields.map(f=>f.name).join(',')==='a,b,c,d,e,f,g,h'&&fields.every(f=>f.type==='U32'))return 'key';
  if(/(?:^|\.)U64$/.test(t.name)&&fields.map(f=>f.name).join(',')==='lo,hi'&&fields.every(f=>f.type==='U32'))return 'u64';
}
function fields(value:unknown,names:string[],label:string):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...names].sort().join(','))
    throw new Error(`${label}: expected fields ${names.join(', ')||'(none)'}`);
  return value as Record<string,unknown>;
}
export function programClient(schema:RuntimeSchema,layout:ProgramLayout,program:string) {
  addressBytes(program);
  const wire=wireCodec(schema),types=new Map(schema.types.map(t=>[t.name,t]));
  const codec=layout.version===1?storageCodec(schema,layout):layout.version===2?multiStorageCodec(schema,layout):
    layout.version===3?collectionStorageCodec(schema,layout):undefined;
  if(!codec)throw new Error('Unsupported program ABI');
  const managed=layout.version===2?layout.stateAccounts.map(a=>a.field):layout.version===3?['state','collection']:['state'];
  const effectful=layout.effects!=='none';
  if(!['none','token-v1','token-v2','cpi-v1'].includes(layout.effects))throw new Error('Unsupported program effects');
  const expected=[managed[0],'actor',...(effectful?[layout.effects==='cpi-v1'?'program':'tokenProgram','custody']:[]),...managed.slice(1),...(effectful?['remaining...']:[])];
  if(JSON.stringify(layout.accounts)!==JSON.stringify(expected))throw new Error('Invalid account ordering in program interface');
  const names=expected.filter(n=>n!=='remaining...');
  if(new Set(names).size!==names.length)throw new Error('Ambiguous account names in program interface');
  const instruction=types.get(layout.instruction);
  if(instruction?.kind!=='adt')throw new Error('Instruction type must have constructors');
  const short=(name:string)=>name.split('.').at(-1)!;
  if(new Set(instruction.variants.map(v=>short(v.sourceName??v.name))).size!==instruction.variants.length)throw new Error('Ambiguous instruction names');
  for(const t of schema.types)if(t.kind==='adt'&&t.variants.some(v=>v.fields.some(f=>f.name==='kind')))throw new Error('Client field name kind is reserved');
  function encode(type:string,value:unknown):WireValue {
    const t=types.get(type)!;
    if(t.kind!=='adt')return value as number|boolean; // Canonical codec checks range/type.
    const friendly=friendlyKind(t);
    if(friendly==='u64'){
      if(typeof value!=='bigint'||value<0n||value>0xffffffffffffffffn)throw new Error(`${type}: expected u64 bigint`);
      return {constructor:t.variants[0].name,fields:{lo:Number(value&0xffffffffn),hi:Number(value>>32n)}};
    }
    if(friendly==='key'){
      const bytes=addressBytes(value as string),view=new DataView(bytes.buffer);
      return {constructor:t.variants[0].name,fields:Object.fromEntries(t.variants[0].fields.map((f,i)=>[f.name,view.getUint32(i*4,true)]))};
    }
    const multiple=t.variants.length!==1;
    const v=multiple?t.variants.find(v=>short(v.sourceName??v.name)===(value as any)?.kind):t.variants[0];
    if(!v)throw new Error(`${type}: unknown constructor kind`);
    const data=fields(value,[...(multiple?['kind']:[]),...v.fields.map(f=>f.name)],type);
    return {constructor:v.name,fields:Object.fromEntries(v.fields.map(f=>[f.name,encode(f.type,data[f.name])]))};
  }
  function decode(type:string,value:WireValue):unknown {
    const t=types.get(type)!;if(t.kind!=='adt')return value;
    const data=value as {constructor:string;fields:Record<string,WireValue>};
    if(friendlyKind(t)==='u64')return BigInt(data.fields.lo as number)+(BigInt(data.fields.hi as number)<<32n);
    if(friendlyKind(t)==='key'){
      const bytes=new Uint8Array(32),view=new DataView(bytes.buffer);
      t.variants[0].fields.forEach((f,i)=>view.setUint32(i*4,data.fields[f.name] as number,true));return addressString(bytes);
    }
    const v=t.variants.find(v=>v.name===data.constructor)!;
    return {...(t.variants.length===1?{}:{kind:short(v.sourceName??v.name)}),...Object.fromEntries(v.fields.map(f=>[f.name,decode(f.type,data.fields[f.name])]))};
  }
  return {
    call(name:string,args:unknown,accounts:Record<string,string>,options:CallOptions={}):InstructionPlan {
      const v=instruction.variants.find(v=>short(v.sourceName??v.name)===name);
      if(!v)throw new Error(`Unknown instruction ${name}`);
      fields(args,v.fields.map(f=>f.name),name);fields(accounts,names,'Accounts');
      const mode=options.mode??'transition';
      if(mode!=='initialize'&&mode!=='transition')throw new Error('Invalid instruction mode');
      const metas=names.map(name=>({address:accounts[name],signer:name==='actor'||(mode==='initialize'&&managed.includes(name)),writable:managed.includes(name)}));
      if(!effectful&&options.remaining?.length)throw new Error('This program does not accept remaining accounts');
      metas.push(...(options.remaining??[]));
      if(metas.length>12)throw new Error('Program accepts at most 12 accounts');
      for(const m of metas){addressBytes(m.address);if(typeof m.signer!=='boolean'||typeof m.writable!=='boolean')throw new Error('Invalid account permissions');}
      if(new Set(metas.map(m=>m.address)).size!==metas.length)throw new Error('Program accounts must have distinct addresses');
      const value={constructor:v.name,fields:Object.fromEntries(v.fields.map(f=>[f.name,encode(f.type,(args as any)[f.name])]))};
      return {program,accounts:metas,data:codec.instruction(value,mode)};
    },
    state(data:Uint8Array,field?:string):unknown {
      if(layout.version===2){const slot=layout.stateAccounts.find(a=>a.field===field);if(!slot)throw new Error('Specify the state account field');return decode(slot.type,multiStorageCodec(schema,layout).account(slot.field,data));}
      const result=layout.version===1?storageCodec(schema,layout).account(data):collectionStorageCodec(schema,layout).state(data);
      return decode(layout.state,result);
    },
    collection(data:Uint8Array,stateAddress:string,start:number,count:number) {
      if(layout.version!==3)throw new Error('Program has no collection account');
      const c=collectionStorageCodec(schema,layout),key=addressBytes(stateAddress);
      return {...c.metadata(data,key),entries:c.window(data,key,start,count).map(v=>decode(layout.collection.element,v))};
    },
    allocationBytes(capacity?:number):Record<string,number> {
      if(layout.version===2)return Object.fromEntries(layout.stateAccounts.map(a=>[a.field,a.stateBytes]));
      if(layout.version===1)return {state:layout.stateBytes};
      if(capacity===undefined)throw new Error('Specify collection capacity');
      return {state:layout.stateBytes,collection:collectionStorageCodec(schema,layout).allocationBytes(capacity)};
    },
  };
}
