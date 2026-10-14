import { bindingContext } from './native.ts';
export function casesFor(schema: any) {
const {zero}=bindingContext(schema);
const cases:any[]=[];
for(const fn of ['prior_bound131','ledger_bound172','winner_bound172']) {
 const exp=schema.exports.find((e:any)=>e.name===fn);const base=zero(exp.args[0]);
 const h=base.fields.policy_facts.fields,d=base.fields.document.fields;
 h.capacity=2;h.terms.fields.challenge_limit=2;h.next_sequence.fields.low=2;d.next_sequence.fields.low=2;
 const key=fn==='prior_bound131'?'fold':fn==='ledger_bound172'?'ledger_fold':'winner_scan';
 const f=base.fields[key].fields;f.valid=true;
 if(fn==='prior_bound131') {base.fields.challenge.fields.sequence.fields.low=1;base.fields.selected_row.fields.sequence.fields.low=1;f.target_sequence=1;f.next_sequence=1;}
 if(fn==='ledger_bound172') {f.total=2;f.next_sequence=2;}
 if(fn==='winner_bound172') {f.total=2;f.next=2;f.has_winner=true;f.winner_sequence=0;}
 function add(label:string,patch:(x:any)=>void,expected:boolean){const x=structuredClone(base);patch(x);cases.push({fn,label,input:x,expected});}
 add('ordinary complete',()=>{},true);
 add('capacity differs from committed terms',x=>x.fields.policy_facts.fields.terms.fields.challenge_limit=1,false);
 add('zero capacity',x=>x.fields.policy_facts.fields.capacity=0,false);
 add('overlarge bound',x=>{x.fields.policy_facts.fields.capacity=1025;x.fields.policy_facts.fields.terms.fields.challenge_limit=1025},false);
 add('table high counter',x=>x.fields.policy_facts.fields.next_sequence.fields.high=1,false);
 add('document high counter',x=>x.fields.document.fields.next_sequence.fields.high=1,false);
 add('document next differs',x=>x.fields.document.fields.next_sequence.fields.low=1,false);
 add('table next differs',x=>x.fields.policy_facts.fields.next_sequence.fields.low=1,false);
 add('fold invalid',x=>x.fields[key].fields.valid=false,false);
 add('incomplete cursor',x=>x.fields[key].fields[fn==='winner_bound172'?'next':'next_sequence']=0,false);
 add('unrelated lamports do not change consistency',x=>x.fields.roles.fields[fn==='prior_bound131'?'challenge':'payer'].fields.lamports_low=123,true);
 if(fn==='prior_bound131') {
  add('challenge sequence differs',x=>x.fields.challenge.fields.sequence.fields.low=0,false);
  add('row sequence differs',x=>x.fields.selected_row.fields.sequence.fields.low=0,false);
  add('challenge sequence high',x=>x.fields.challenge.fields.sequence.fields.high=1,false);
  add('row sequence high',x=>x.fields.selected_row.fields.sequence.fields.high=1,false);
  add('earlier open row',x=>x.fields.fold.fields.open_rows=1,false);
  add('found winner not earlier',x=>{x.fields.fold.fields.has_challenger_win=true;x.fields.fold.fields.first_challenger_sequence=1},false);
 }
 if(fn==='ledger_bound172') {
  add('document open challenge',x=>x.fields.document.fields.open_challenges=1,false);
  add('ledger unsettled row',x=>x.fields.ledger_fold.fields.unsettled_rows=1,false);
 }
 if(fn==='winner_bound172') {
  add('found winner outside table',x=>x.fields.winner_scan.fields.winner_sequence=2,false);
  add('no eligible winner',x=>x.fields.winner_scan.fields.has_winner=false,true);
 }
}

return cases;
}
