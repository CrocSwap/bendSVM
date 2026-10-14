"""Conditional exact native Claim output words from actual emitted suffix."""
from pathlib import Path
import hashlib,importlib.util,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'));sys.path.insert(0,str(base))
import z3 as z
import sbf_output as out
from sbf_elf import text_section
model=base/'payout-prefix-model.py';spec=importlib.util.spec_from_file_location('claim_prefix',model);prefix=importlib.util.module_from_spec(spec);spec.loader.exec_module(prefix)
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes());B=lambda v:z.BitVecVal(v,64);W=lambda v:z.BitVecVal(v,32);words={}
def word(region,off):
 if region=='state' and off in [4,8,44,80,92,104,116]:return W(0)
 if region=='state' and off==0:return W(1)
 if region=='instruction' and off==0:return W(1)
 if region=='context' and off==40:return W(1)
 if region=='context' and off in range(8,40,4):return word('state',off+4)
 key=region,off
 if key not in words:words[key]=z.BitVec(region+'_'+str(off),32)
 return words[key]
rr=[z.BitVec('entry_'+str(i),64) for i in range(11)];rr[1]=('output',0);rr[2]=('context',0);rr[3]=('state',0);rr[4]=('instruction',0);rr[10]=('stack',0)
entry=prefix.execute(text,address,0x1438,0x2490,rr,{'output':360,'context':56,'state':128,'instruction':112},word)
q=z.BitVec('vested',64);claimed=z.Concat(word('state',124),word('state',120));amount=q-claimed;lo=lambda v:z.ZeroExt(32,z.Extract(31,0,v));hi=lambda v:z.ZeroExt(32,z.Extract(63,32,v))
r=[z.BitVec('suffix_'+str(i),64) for i in range(10)]+[('stack',0)];r[4]=hi(amount);r[1]=lo(amount);r[2]=hi(q);r[3]=('state',0);r[6]=('output',0);r[0]=entry['memory'][-0x158];r[7]=entry['memory'][-0xc0];r[8]=entry['memory'][-0x120];r[9]=B(1)
mem={('state',off):word('state',off) for off in range(0,128,4)}
for off,v in entry['memory'].items():
 if z.is_bv(v):mem['stack',off]=z.Extract(31,0,v);mem['stack',off+4]=z.Extract(63,32,v)
mem['stack',-0xa8]=z.Extract(31,0,q);mem['stack',-0xa4]=z.Extract(63,32,q)
sizes={'stack':(-4096,0),'state':(0,128),'output':(0,360)}
def run(raw):return out.execute(raw,address,0x28d8,0x2e60,r,mem,sizes,memset_target=0x6890)
actual=run(text)
expected={('output',off):W(0) for off in range(0,360,4)}
for off in range(0,128,4):expected['output',off+4]=word('state',off)
expected['output',124]=z.Extract(31,0,q);expected['output',128]=z.Extract(63,32,q)
for off,value in [(136,1),(140,4),(144,5),(148,6),(188,2),(240,1)]:expected['output',off]=W(value)
for k in range(0,36,4):expected['output',152+k]=word('state',44+k);expected['output',192+k]=word('state',8+k)
expected['output',232]=z.Extract(31,0,amount);expected['output',236]=z.Extract(63,32,amount)
rows=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=30000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown(),str(s.model()) if result==z.sat else ''))
 rows.append({'name':name,'result':str(result)})
prove('all ninety output words',z.And(*(actual['memory'][k]==v for k,v in expected.items())))
if {k for k in actual['writes'] if k[0]=='output'}!=set(expected):raise RuntimeError('incomplete or excess output footprint')
if actual['calls']!=[{'address':0x2e38,'target':0x6890,'region':'output','offset':248,'bytes':112}]:raise RuntimeError('wrong memory clear contract')
prove('immutable input unchanged',z.And(*(actual['memory']['state',off]==word('state',off) for off in range(0,128,4))))
faults=[]
for name,at,byte,value in [('source-role',0x29d0,4,3),('recipient-kind',0x29a0,4,0)]:
 bad=bytearray(text);bad[at-address+byte]=value;wrong=run(bytes(bad));s=z.Solver();s.add(z.Or(*(wrong['memory'][k]!=v for k,v in expected.items())));result=s.check()
 if result!=z.sat:raise RuntimeError(('missed output fault',name,str(result)))
 faults.append({'name':name,'result':str(result),'witness':str(s.model())})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'faults':faults,'instructions':actual['instructions'],'initialStackReads':sorted(k[1] for k in actual['initialReads'] if k[0]=='stack'),'outputWords':len(expected),'calls':actual['calls'],'inputHashes':{str(p):sha(p) for p in [Path(__file__),repo/'verification/sbf_output.py',model,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',elf]},'scope':'All90nativeClaimoutputwords equal expected updated state and one custody transfer for arbitrary vested/claimed/key/schedule values, conditional on entering accepted payout suffix with specified result registers and retained native-entry stack fields. Memset zero-fill/output-only behavior and CALL preservation are trusted summaries, valid/disjoint regions assumed. Original suffix-entry/retained-field composition, quotient/source semantics and whole-handler/adapter/commit theorem remain separate obligations.'}
file=base/'claim-output-report.json';file.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':actual['instructions'],'outputWords':len(expected),'initialStackReads':report['initialStackReads']}))
