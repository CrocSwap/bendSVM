import * as B from '../.deps/bend/bend2/bend.ts';
import { Backend, checkedProgram } from '../compiler/backend.ts';
import { primitives } from '../compiler/primitives.ts';

// Export the checked runtime terms, not a manually transcribed arithmetic
// implementation. Backend validation limits this model to its supported subset.
export async function model(source: string, roots: string[]) {
  const checked=await checkedProgram(source);
  const emitted=new Backend(checked.book).emit(roots);
  const bare=(t:B.LTerm):B.LTerm => t.$==='Ann'?bare(t.x):t;
  const type=(t:B.LTerm):string=>{
    t=bare(t);
    if(t.$==='Var' && t.v!==undefined) t=bare(B.term_lower(B.term_wnf(checked.book,t.v as B.HTerm)));
    if(t.$!=='Ref'&&t.$!=='ADT') throw new Error('Unsupported model type');
    const parameters=t.$==='ADT'?t.x:[];
    const name=parameters.length?`${t.k}<${parameters.map(type).join(',')}>`:t.k;
    if(!emitted.schema.types.some(t=>t.name===name)) throw new Error(`Unknown model type: ${name}`);
    return name;
  };
  const variant=(name:string,family:string)=>{
    if(family==='Nat' && (name==='Zero'||name==='Succ')) return {name,fields:name==='Zero'?[]:[{name:'pred',type:'Nat'}]};
    if(family==='Bool' && (name==='True'||name==='False')) return {name,fields:[]};
    const schema=emitted.schema.types.find(t=>t.name===family);
    const v=schema?.kind==='adt'?schema.variants.find(v=>(v.sourceName??v.name)===name):undefined;
    if(!v) throw new Error(`Unknown model constructor ${name} in ${family}`);
    return v;
  };
  const term=(raw:B.LTerm,args:string[]=[]):unknown=>{
    const t=bare(raw);
    switch(t.$) {
      case 'Var':return {$:'Var',i:t.i};
      case 'Ref':return {$:'Ref',k:t.k};
      case 'App':return {$:'App',f:term(t.f),x:term(t.x)};
      case 'Lam':
        if(!args.length) throw new Error('Unapplied model lambda');
        return {$:'Lam',i:t.i,f:term(t.f,args.slice(1))};
      case 'Mat': {
        if(!args.length) throw new Error('Unapplied model match');
        const v=variant(t.k,args[0]);
        return {$:'Mat',k:v.name,h:term(t.h,[...v.fields.map(f=>f.type),...args.slice(1)]),m:term(t.m,args)};
      }
      case 'Ctr': {
        if(t.k==='Zero'||t.k==='Succ') {
          let n=0,cursor=t as B.LTerm;
          while(true) {
            cursor=bare(cursor);
            if(cursor.$==='Ctr'&&cursor.k==='Zero')break;
            if(cursor.$!=='Ctr'||cursor.k!=='Succ'||++n>64)throw new Error('Unsupported model Nat');
            cursor=cursor.x[0];
          }
          return {$:'Nat',value:n};
        }
        if(t.k==='U32') {const n=B.u32_from_term(B.term_higher(t));if(n===null) throw new Error('Nonliteral U32');return {$:'U32',value:n};}
        const family=raw.$==='Ann'?type(raw.T):undefined;
        if(!family) {
          // Checked constructors should carry their instantiated result type.
          const candidates=emitted.schema.types.filter(s=>s.kind==='adt'&&s.variants.some(v=>v.sourceName===t.k));
          if(candidates.length) throw new Error(`Missing generic constructor annotation: ${t.k}`);
        }
        return {$:'Ctr',k:family?variant(t.k,family).name:t.k,x:t.x.map(x=>term(x))};
      }
      case 'Let':return {$:'Let',i:t.i,v:t.v.map(v=>term(v)),f:term(t.f)};
      case 'Efq':return {$:'Efq'};
      default:throw new Error(`Unsupported model term: ${t.$}`);
    }
  };
  const functions=Object.fromEntries(emitted.functions.map(name=>{
    const def=checked.book.tlds[name];if(def.$!=='Def') throw new Error('Expected checked definition');
    let t=B.term_lower(def.T);const args:string[]=[];
    while(t.$==='All') {args.push(type(t.A));t=t.B;}
    return [name,{args,result:type(t),primitive:Object.hasOwn(primitives,name),
      body:Object.hasOwn(primitives,name)?null:term(def.e!,args)}];
  }));
  return {version:1,source,roots,files:checked.files,schema:emitted.schema,functions};
}
