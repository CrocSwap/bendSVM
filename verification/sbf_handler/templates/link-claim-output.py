"""Bind actual payout-guard exit registers and memory to native output packing."""
from pathlib import Path
import hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'));sys.path.insert(0,str(base))
import z3 as z
import sbf_output as output
# Reuse the reviewed output setup and expected record, without running its queries.
source=base/'check-claim-output.py';text_source=source.read_text();before=text_source.split('actual=run(text)')[0];expected_code=text_source.split('expected={',1)[1].split('rows=[]',1)[0]
ns={'__file__':str(source)};exec(compile(before+'\nexpected={'+expected_code,str(source),'exec'),ns)
raw,address=ns['text'],ns['address'];prefix=ns['prefix'];q,claimed=ns['q'],ns['claimed'];word=ns['word'];W=ns['W']
regs=[z.BitVec('payout_boundary_'+str(i),64) for i in range(10)]+[('stack',0)];regs[3]=('state',0);regs[6]=('output',0);regs[9]=z.BitVecVal(1,64)
mem=dict(ns['entry']['memory']);mem[-0xa8]=q
actual=prefix.execute(raw,address,0x2748,0x28d8,regs,{'output':360,'context':56,'state':128,'instruction':112},word,mem)
total=z.Concat(word('state',88),word('state',84));want_guard=z.And(z.ULE(q,total),z.UGT(q,claimed));rows=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown()))
 rows.append({'name':name,'result':str(result)})
prove('exact accepted payout boundary guard',actual['guard']==want_guard)
# Every live scalar/pointer consumed by packing matches its prior explicit setup.
checks=[]
for i in [0,1,2,3,4,6,7,8,9,10]:
 a,b=actual['registers'][i],ns['r'][i];checks.append(z.BoolVal(a==b) if isinstance(a,tuple) else a==b)
proof=json.loads((base/'claim-output-report.json').read_text());protected=sorted(set(off//8*8 for off in proof['initialStackReads'])-{-0xa8})
checks.append(actual['memory'][-0xa8]==q)
checks += [actual['memory'][k]==ns['entry']['memory'][k] for k in protected]
prove('all live output entry registers and retained words',z.Implies(actual['guard'],z.And(*checks)))
# Execute the output suffix using the actual boundary, not assumed amount registers.
word_mem={('state',off):word('state',off) for off in range(0,128,4)}
for off,v in actual['memory'].items():
 if z.is_bv(v):word_mem['stack',off]=z.Extract(31,0,v);word_mem['stack',off+4]=z.Extract(63,32,v)
result=output.execute(raw,address,0x28d8,0x2e60,actual['registers'],word_mem,ns['sizes'],memset_target=0x6890)
prove('composed ninety-word claim output',z.Implies(actual['guard'],z.And(*(result['memory'][k]==v for k,v in ns['expected'].items()))))
s=z.Solver();s.add(actual['guard'],q==50,claimed==0,total==100);status=s.check()
if status!=z.sat:raise RuntimeError('vacuous composed output')
rows.append({'name':'accepted payout witness','result':'sat','witness':str(s.model())})
# Wrong final amount borrow affects the actual native output amount.
bad=bytearray(raw);bad[0x2870-address]=0x4f
fault=prefix.execute(bytes(bad),address,0x2748,0x28d8,regs,{'output':360,'context':56,'state':128,'instruction':112},word,mem)
fm=dict(word_mem)
for off,v in fault['memory'].items():
 if z.is_bv(v):fm['stack',off]=z.Extract(31,0,v);fm['stack',off+4]=z.Extract(63,32,v)
wrong=output.execute(bytes(bad),address,0x28d8,0x2e60,fault['registers'],fm,ns['sizes'],memset_target=0x6890)
s=z.Solver();s.add(fault['guard'],z.Concat(wrong['memory']['output',236],wrong['memory']['output',232])!=q-claimed);status=s.check()
if status!=z.sat:raise RuntimeError('missed composed amount fault')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'fault':{'name':'actual borrow-to-output difference','result':'sat','witness':str(s.model())},'reports':{str(base/'claim-output-report.json'):sha(base/'claim-output-report.json')},'inputHashes':{str(p):sha(p) for p in [Path(__file__),source,base/'payout-prefix-model.py',repo/'verification/sbf_output.py',repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',ns['elf']]},'scope':'Actual quotient exit through payout guards and all90native output words, binding live registers and13directly-read retained stack words. Quotient stack value, original state/output pointers and retained entry state supplied; division/frame proofs connect these separately. Canonical native values, signed matching actor, valid disjoint regions, CALL ABI and bound zero-fill syscall summary assumed; no whole-handler source/adapter/commit theorem.'}
file=base/'claim-output-composition-report.json';file.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'protectedSlots':len(protected)}))
