import { bindingContext } from './native.ts';
export function casesFor(schema: any) {
const {zero}=bindingContext(schema);
const cases:any[]=[];
const fn='winner_cache_bound172', exp=schema.exports.find((e:any)=>e.name===fn);
const base=zero(exp.args[0]), h=base.fields.policy_facts.fields, d=base.fields.document.fields;
h.capacity=2;h.terms.fields.challenge_limit=2;h.next_sequence.fields.low=2;d.next_sequence.fields.low=2;
const f=base.fields.winner_scan.fields;f.total=2;f.next=2;f.valid=true;f.has_winner=true;f.winner_sequence=1;
h.earliest_winner_sequence.fields.low=1;
for(const k of [f.winner_key,h.earliest_winner_key,d.first_winner_key,base.fields.auxiliary_key])for(let i=0;i<8;i++)k.fields['w'+i]=0xf0000000+i;
function add(label:string,seed:any,patch:(x:any)=>void,expected:boolean,root=fn){const x=structuredClone(seed);patch(x);cases.push({fn:root,label,input:x,expected});}
add('ordinary eligible winner',base,()=>{},true);
for(const field of ['fold','dpa','document','recipient'])for(let i=0;i<8;i++)add(`${field} word ${i} mismatch`,base,x=>{
 const k=field==='fold'?x.fields.winner_scan.fields.winner_key:field==='dpa'?x.fields.policy_facts.fields.earliest_winner_key:field==='document'?x.fields.document.fields.first_winner_key:x.fields.auxiliary_key;k.fields['w'+i]=(k.fields['w'+i]^1)>>>0;
},field==='recipient');
for(const [label,patch] of [
 ['cache high sequence',(x:any)=>x.fields.policy_facts.fields.earliest_winner_sequence.fields.high=1],
 ['cache wrong sequence',(x:any)=>x.fields.policy_facts.fields.earliest_winner_sequence.fields.low=0],
 ['fold cursor incomplete',(x:any)=>x.fields.winner_scan.fields.next=1],
 ['fold invalid',(x:any)=>x.fields.winner_scan.fields.valid=false],
 ['document counter mismatch',(x:any)=>x.fields.document.fields.next_sequence.fields.low=1],
 ['table capacity mismatch',(x:any)=>x.fields.policy_facts.fields.capacity=3],
 ['winner outside prefix',(x:any)=>x.fields.winner_scan.fields.winner_sequence=2],
] as const)add(label,base,patch,false);
const none=structuredClone(base);none.fields.winner_scan.fields.has_winner=false;none.fields.winner_scan.fields.winner_sequence=0;
none.fields.policy_facts.fields.earliest_winner_sequence.fields.low=0xffffffff;none.fields.policy_facts.fields.earliest_winner_sequence.fields.high=0xffffffff;
for(const k of [none.fields.winner_scan.fields.winner_key,none.fields.policy_facts.fields.earliest_winner_key,none.fields.document.fields.first_winner_key])for(let i=0;i<8;i++)k.fields['w'+i]=0;
add('no winner sentinel; auxiliary unused',none,()=>{},true);
for(const field of ['fold','dpa','document'])for(let i=0;i<8;i++)add(`no winner ${field} word ${i} nonzero`,none,x=>{
 const k=field==='fold'?x.fields.winner_scan.fields.winner_key:field==='dpa'?x.fields.policy_facts.fields.earliest_winner_key:x.fields.document.fields.first_winner_key;k.fields['w'+i]=1;
},false);
add('no winner wrong sentinel low',none,x=>x.fields.policy_facts.fields.earliest_winner_sequence.fields.low=0,false);
add('no winner wrong sentinel high',none,x=>x.fields.policy_facts.fields.earliest_winner_sequence.fields.high=0,false);
add('no winner stale fold sequence',none,x=>x.fields.winner_scan.fields.winner_sequence=1,false);
const recipientRoot='winner_recipient_bound172';
const held=structuredClone(base);held.fields.document.fields.bond_state=1;
add('standard held matching recipient',held,()=>{},true,recipientRoot);
for(let i=0;i<8;i++)add(`standard held recipient word ${i} mismatch`,held,x=>x.fields.auxiliary_key.fields['w'+i]=(x.fields.auxiliary_key.fields['w'+i]^1)>>>0,false,recipientRoot);
for(const state of [0,2,3,4,257])add(`non-held ${state} auxiliary unused`,held,x=>{x.fields.document.fields.bond_state=state;x.fields.auxiliary_key.fields.w0=(x.fields.auxiliary_key.fields.w0^1)>>>0;},true,recipientRoot);
const customName=schema.types.find((t:any)=>t.name.endsWith('PolicyKind')).variants.find((v:any)=>v.name.endsWith('Custom')).name;
add('custom escrow auxiliary differs from winner',held,x=>{x.fields.policy_facts.fields.terms.fields.policy_kind={constructor:customName,fields:{}};x.fields.auxiliary_key.fields.w0=(x.fields.auxiliary_key.fields.w0^1)>>>0;},true,recipientRoot);
add('no winner recipient unused',none,()=>{},true,recipientRoot);
add('recipient check still rejects bad cache',held,x=>x.fields.document.fields.first_winner_key.fields.w0=(x.fields.document.fields.first_winner_key.fields.w0^1)>>>0,false,recipientRoot);
add('standard held no winner auxiliary unused',none,x=>x.fields.document.fields.bond_state=1,true,recipientRoot);
add('custom held no winner auxiliary unused',none,x=>{x.fields.document.fields.bond_state=1;x.fields.policy_facts.fields.terms.fields.policy_kind={constructor:customName,fields:{}};},true,recipientRoot);

return cases;
}
