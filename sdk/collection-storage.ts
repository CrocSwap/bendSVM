import {wireCodec, type WireValue} from './wire.ts';
import type {RuntimeSchema} from '../compiler/schema.ts';
import type {emitCollectionStorage} from '../compiler/collection-storage.ts';
export type CollectionStorageInterface=ReturnType<typeof emitCollectionStorage>['interface'];

// A client may inspect only the requested records. Metadata validation does not
// claim that untouched records are canonical; record/window decode checks them.
export function collectionStorageCodec(schema:RuntimeSchema,layout:CollectionStorageInterface) {
  const codec=wireCodec(schema),root=schema.exports.find(f=>f.name===layout.root);
  const selection=schema.exports.find(f=>f.name===layout.select),c=layout.collection;
  const header=(xs:number[])=>Array.isArray(xs)&&xs.length===20&&xs.every(x=>Number.isInteger(x)&&x>=0&&x<=255);
  if(layout.version!==3||!root||root.args.length!==5||root.args[1]!==layout.state||root.args[2]!==layout.instruction||
      !selection||selection.args.join(',')!==root.args.slice(0,4).join(',')||
      !header(layout.header)||!c||!header(c.header)||c.headerBytes!==56||c.lengthOffset!==20||c.boundStateOffset!==24||
      c.stride!==codec.sizes.get(c.element)||!Number.isInteger(c.windowCapacity)||c.windowCapacity<1||c.windowCapacity>8||
      layout.stateBytes!==20+codec.sizes.get(layout.state)!||layout.instructionBytes!==1+codec.sizes.get(layout.instruction)!||
      layout.modes.initialize!==0||layout.modes.transition!==1||!['none','token-v1','token-v2','cpi-v1'].includes(layout.effects)||
      c.accountIndex!==(layout.effects==='none'?2:4))throw new Error('Invalid collection storage interface');
  const integer=(n:number)=>Number.isInteger(n)&&n>=0&&n<=0xffffffff;
  const metadata=(data:Uint8Array,stateKey:Uint8Array)=>{
    if(stateKey.length!==32||data.length<56||(data.length-56)%c.stride||
        c.header.some((b,i)=>data[i]!==b)||stateKey.some((b,i)=>data[24+i]!==b))throw new Error('Invalid collection header, binding or size');
    const capacity=(data.length-56)/c.stride,length=new DataView(data.buffer,data.byteOffset,data.byteLength).getUint32(20,true);
    if(!integer(capacity)||length>capacity)throw new Error('Invalid collection length or capacity');
    return {length,capacity};
  };
  return {
    instruction(value:WireValue,mode:'initialize'|'transition'='transition') {
      if(mode!=='initialize'&&mode!=='transition')throw new Error('Invalid storage mode');
      const out=new Uint8Array(layout.instructionBytes);out[0]=layout.modes[mode];out.set(codec.encode(layout.instruction,value),1);return out;
    },
    state(data:Uint8Array) {
      if(data.length!==layout.stateBytes||layout.header.some((b,i)=>data[i]!==b))throw new Error('Invalid state header or size');
      return codec.decode(layout.state,data.subarray(20));
    },
    allocationBytes(capacity:number) {
      if(!integer(capacity))throw new Error('Invalid collection capacity');
      return 56+capacity*c.stride;
    },
    metadata,
    window(data:Uint8Array,stateKey:Uint8Array,start:number,count:number) {
      const {length}=metadata(data,stateKey);
      if(!integer(start)||!integer(count)||count>c.windowCapacity||start+count>length)throw new Error('Invalid collection read window');
      return Array.from({length:count},(_,i)=>codec.decode(c.element,data.subarray(56+(start+i)*c.stride,56+(start+i+1)*c.stride)));
    },
  };
}
