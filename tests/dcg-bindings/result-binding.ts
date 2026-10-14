import { bindingContext } from './native.ts';
export function casesFor(schema: any) {
const {zero}=bindingContext(schema);
const cases:any[]=[];
const fn='result_row1_bound172', exp=schema.exports.find((e:any)=>e.name===fn), base=zero(exp.args[0]);
const b=base.fields.binding.fields,d=base.fields.document.fields,r=base.fields.result.fields,f=base.fields.result_fold.fields;
b.output_count=9;b.output_width=16;d.landed_positions=6;r.output_count=9;r.output_width=16;r.outputs_attested=5;
f.total=9;f.expected_prefix_length=5;f.next_position=9;f.attested_prefix_count=5;f.output_width=16;f.bitmap_matches_prefix=true;f.valid=true;
function add(label:string,seed:any,patch:(x:any)=>void,expected:string){const x=structuredClone(seed);patch(x);cases.push({fn,label,input:x,expected});}
add('complete prefix without stop rule',base,()=>{},'Final');
add('non-FINAL record cannot choose a pristine skip',base,x=>{const f=x.fields.result_fold.fields;f.next_position=0;f.attested_prefix_count=0;f.scan_skipped_final=true;},'ScanRejected');
add('disabled stop cannot have prior stop',base,x=>x.fields.result_fold.fields.stop_before_last_count=1,'ScanRejected');
add('disabled stop cannot have last stop',base,x=>x.fields.result_fold.fields.last_value_is_stop=true,'ScanRejected');
for(const [field,value] of Object.entries({total:8,expected_prefix_length:4,next_position:8,attested_prefix_count:4,attested_after_prefix_count:1,stop_before_last_count:5,stop_plus_one:1,output_width:32,decision_mode:true,scan_skipped_final:true,bitmap_matches_prefix:false,valid:false}))add('forged '+field,base,x=>x.fields.result_fold.fields[field]=value,'ScanRejected');
for(const [field,value] of Object.entries({output_count:8,output_width:32,outputs_attested:4}))add('stored '+field,base,x=>x.fields.result.fields[field]=value,'ScanRejected');
add('landed positions mismatch',base,x=>x.fields.document.fields.landed_positions=5,'ScanRejected');
add('binding width mismatch',base,x=>x.fields.binding.fields.output_width=32,'ScanRejected');
add('binding count mismatch',base,x=>x.fields.binding.fields.output_count=8,'ScanRejected');
add('empty completion span',base,x=>x.fields.document.fields.landed_positions=0,'ScanRejected');
const stop=structuredClone(base);stop.fields.binding.fields.stop_plus_one=1;stop.fields.result_fold.fields.stop_plus_one=1;stop.fields.result_fold.fields.last_value_is_stop=true;
add('early stop exact last cell',stop,()=>{},'Final');
add('early completion lacks stop',stop,x=>x.fields.result_fold.fields.last_value_is_stop=false,'Violated');
add('ran past stop',stop,x=>x.fields.result_fold.fields.stop_before_last_count=1,'Violated');
add('stop count outside prefix',stop,x=>x.fields.result_fold.fields.stop_before_last_count=5,'ScanRejected');
const full=structuredClone(stop);full.fields.document.fields.landed_positions=10;full.fields.result.fields.outputs_attested=9;full.fields.result_fold.fields.expected_prefix_length=9;full.fields.result_fold.fields.attested_prefix_count=9;full.fields.result_fold.fields.last_value_is_stop=false;
add('full capacity needs no last stop',full,()=>{},'Final');
add('full capacity with earlier stop',full,x=>x.fields.result_fold.fields.stop_before_last_count=1,'Violated');
const decision=structuredClone(base);decision.fields.binding.fields.decision_flags=1;decision.fields.binding.fields.option_count=4;decision.fields.result_fold.fields.decision_mode=true;
add('decision prefix',decision,()=>{},'Final');
add('decision span mismatch',decision,x=>x.fields.binding.fields.option_count=3,'ScanRejected');
const already=structuredClone(base);already.fields.result.fields.status=1;const af=already.fields.result_fold.fields;af.next_position=0;af.attested_prefix_count=0;af.scan_skipped_final=true;
add('already FINAL initialized skip',already,()=>{},'AlreadyFinal');
add('already FINAL ignores stored attested',already,x=>x.fields.result.fields.outputs_attested=0,'AlreadyFinal');
for(const field of ['next_position','attested_prefix_count','attested_after_prefix_count','stop_before_last_count'])add('skip with changed '+field,already,x=>x.fields.result_fold.fields[field]=1,'ScanRejected');
add('skip with last stop changed',already,x=>x.fields.result_fold.fields.last_value_is_stop=true,'ScanRejected');
add('skip with bitmap changed',already,x=>x.fields.result_fold.fields.bitmap_matches_prefix=false,'ScanRejected');

return cases;
}
