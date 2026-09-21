import {wireLayouts,type RuntimeSchema} from './schema.ts';

// Exact sizes for this backend's generated C representation: all scalar fields,
// tags and empty payloads are u32-aligned; unions occupy their largest variant.
export function resourceReport(schema:RuntimeSchema) {
  const wire=wireLayouts(schema),types=new Map(schema.types.map(t=>[t.name,t])),native=new Map<string,number>();
  const size=(name:string):number=>{
    if(native.has(name))return native.get(name)!;
    const t=types.get(name)!;
    const n=t.kind==='adt'?4+Math.max(...t.variants.map(v=>v.fields.length?v.fields.reduce((n,f)=>n+size(f.type),0):4)):4;
    native.set(name,n);return n;
  };
  const layouts=schema.types.map(t=>({type:t.name,nativeBytes:size(t.name),wireBytes:wire.get(t.name)!}));
  return {version:1,limits:{nativeValueBytes:1536,wireValueBytes:1024,stackFrameBytes:4096,natFuel:64},
    layouts,largestNativeBytes:Math.max(0,...layouts.map(t=>t.nativeBytes)),largestWireBytes:Math.max(0,...layouts.map(t=>t.wireBytes)),
    note:'Value sizes are exact for the generated u32-aligned C layout. Stack usage is reported separately by Clang; these are not compute bounds.'};
}
