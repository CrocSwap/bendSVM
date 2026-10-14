if not __debug__:raise RuntimeError('memory proof assertions required')
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import sys,os,json,hashlib,uuid,runpy
sys.path.insert(0,'verification');sys.path.insert(0,'verification/collection_entry/qualification')
import fresh_report
import z3 as z
import collection_contracts as cc
root=OUT;receipt_path=Path('build/collection-entry/fresh-receipt.json');receipt=json.loads(Path(os.environ['MEMORY_INPUT']).read_bytes())['entryReceipt'] if os.environ.get('MEMORY_INPUT') else json.loads(receipt_path.read_bytes())
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
for p,h in [('beforeArtifact','beforeSha256'),('inputArtifact','inputSha256'),('reportArtifact','reportSha256')]:assert sha(receipt[p])==receipt[h]
fresh_report.validate(receipt['beforeArtifact'],receipt['inputArtifact'])
run=root/('caller' if os.environ.get('MEMORY_INPUT') else 'caller-'+str(uuid.uuid4()));run.mkdir();pre=json.loads(Path(receipt['beforeArtifact']).read_bytes());pre.update(runId=run.name,runDirectory=str(run));before=run/'before.json';before.write_text(json.dumps(pre,indent=2)+'\n');os.environ['ENTRY_BUNDLE_INPUT']=str(before)
a=runpy.run_path('verification/collection_entry/binding-domain.py',run_name='__main__');r=a['r'];m=a['m'];e=a['e'];paths=r['paths'];dispatch=r['c']['dispatch'];commit=r['c']['commits'];v=r['v'];field=r['field'];constraints=r['constraints'];claims=[]
layout=(globals().get('qualified_layout') or runpy.run_path('verification/collection_memory/layout-frame.py',run_name='__main__'));actual_base=v(0x100000000)
sub=[(layout['base'],actual_base)]+[(layout['sizes'][i],field(i,'size')) for i in range(3)]
def translated(term):return z.substitute(term,*sub)
def check(name,condition,guard=commit,wanted=z.unsat):
 s=z.Solver();s.set(timeout=60000)
 # Entry-only layout claims use the smaller, weaker entry premise set; root
 # and codec equations are irrelevant and can obscure this proof for Z3.
 premise_set=e['paths'].constraints if z.eq(guard,dispatch) else constraints
 s.add(*premise_set,guard,z.Not(condition));status=s.check();print(name,status,flush=True);assert status==wanted,(name,status,s.reason_unknown());claims.append({'name':name,'result':str(status)})
check('entry-discharges-layout-premises',z.And(*[translated(p) for p in layout['premises']]),dispatch)
for i in range(3):
 check('account-'+str(i)+'-start-binding',translated(layout['starts'][i])==actual_base+e['records'][i]['at'],dispatch)
 check('account-'+str(i)+'-data-binding',translated(layout['data'][i])==actual_base+r['c']['address'](i,'data'),dispatch)
env={'data_size':field(2,'size'),'next_length':paths.u32('next'),'start':paths.u32('start'),'stride':paths.opened_stride,'written':paths.u32('written'),'capacity':paths.opened_capacity,'length':paths.opened_length,'reserved':paths.u32('reserved'),'loaded':paths.u32('loaded'),'scratch_extent':v(8)}
precondition=cc.term(cc.CONTRACT_DOCUMENT['contracts']['commit']['precondition'],env)
check('actual-caller-discharges-global-commit-precondition',precondition)
check('caller-state-write-size',field(0,'size')==v(25))
# Match the already qualified generated statements that select the account/key
# and perform both state copies; retain full existing caller grammar validation.
text=m['core']['text'];compact=''.join(text.split())
for call in ['bend_collection_commit(&collection,&selected,written,next,encoded_records,collection_header,state->key);','__builtin_memcpy(state->data,state_header,20);','__builtin_memcpy(state->data+20,encoded_state,5);']:
 assert compact.count(call)==1,call
check('state-key-source-address',actual_base+r['c']['address'](0,'key')==translated(layout['starts'][0])+v(8))
check('commit-is-reachable',z.BoolVal(False),wanted=z.sat)
wrong=dict(env,data_size=field(1,'size'));check('wrong-account-size-binding-control',cc.term(cc.CONTRACT_DOCUMENT['contracts']['commit']['precondition'],wrong),wanted=z.sat)
wrong=dict(env,start=paths.u32('start')+z.BitVecVal(1,32));check('wrong-window-start-binding-control',cc.term(cc.CONTRACT_DOCUMENT['contracts']['commit']['precondition'],wrong),wanted=z.sat)
fresh_report.validate(receipt['beforeArtifact'],receipt['inputArtifact'])
(run/'caller-memory.json').write_text(json.dumps({'passed':True,'claims':claims,'entryReceipt':receipt,'contractInterfaceHash':cc.CONTRACT_INTERFACE_HASH,'scope':'Fresh qualified serialized entry/root namespace discharges contiguous-layout and shared commit-domain preconditions, with parsed actual commit/key/state-copy argument binding. Full post-state/induction models remain separate; local objects, scratch/header separation, provenance and SBF execution not proved.'},indent=2)+'\n');print(run,flush=True)
