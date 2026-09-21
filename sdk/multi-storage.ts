import {wireCodec, type WireValue} from './wire.ts';
import type {RuntimeSchema} from '../compiler/schema.ts';
import type {emitMultiStorage} from '../compiler/multi-storage.ts';
export type MultiStorageInterface=ReturnType<typeof emitMultiStorage>['interface'];

export function multiStorageCodec(schema:RuntimeSchema,layout:MultiStorageInterface) {
  const codec=wireCodec(schema),root=schema.exports.find(f=>f.name===layout.root);
  const state=schema.types.find(t=>t.name===layout.state);
  const slots=layout.stateAccounts;
  if(layout.version!==2 || !root || root.args.length!==3 || root.args[1]!==layout.state || root.args[2]!==layout.instruction ||
      state?.kind!=='adt' || state.variants.length!==1 || !Array.isArray(slots) || slots.length<2 || slots.length>4 ||
      slots.length!==state.variants[0].fields.length || !['none','token-v1','cpi-v1'].includes(layout.effects) ||
      layout.instructionBytes!==codec.sizes.get(layout.instruction)!+1 || layout.modes.initialize!==0 || layout.modes.transition!==1)
    throw new Error('Invalid multi-storage interface');
  const effectful=layout.effects!=='none';
  if(layout.minimumAccounts!==slots.length+(effectful?3:1) || layout.maximumAccounts!==(effectful?12:layout.minimumAccounts))throw new Error('Invalid multi-storage account bounds');
  slots.forEach((a,i)=>{
    const field=state.variants[0].fields[i];
    if(a.field!==field.name || a.type!==field.type || a.index!==(i===0?0:i+(effectful?3:1)) ||
       a.header.length!==20 || a.header.some(b=>!Number.isInteger(b)||b<0||b>255) || a.stateBytes!==20+codec.sizes.get(a.type)!)
      throw new Error('Invalid multi-storage account layout');
  });
  return {
    instruction(value:WireValue,mode:'initialize'|'transition'='transition') {
      if(mode!=='initialize'&&mode!=='transition')throw new Error('Invalid storage mode');
      const out=new Uint8Array(layout.instructionBytes);out[0]=layout.modes[mode];out.set(codec.encode(layout.instruction,value),1);return out;
    },
    account(field:string,data:Uint8Array) {
      const a=slots.find(a=>a.field===field);
      if(!a || data.length!==a.stateBytes || a.header.some((b,i)=>data[i]!==b))throw new Error('Invalid storage account field/header/size');
      return codec.decode(a.type,data.subarray(20));
    },
    reply(data:Uint8Array) {return codec.decode(layout.state,data);},
  };
}
