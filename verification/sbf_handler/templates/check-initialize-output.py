"""Actual native Initialize output construction with explicit call summary."""
from pathlib import Path
import hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'));sys.path.insert(0,str(base))
import z3 as z
import sbf_leaf as prefix
import sbf_output as out
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes());W=lambda x:z.BitVecVal(x,32);words={}
def word(region,off):
 if region=='state' and off==0:return W(0)
 if region=='instruction' and off in [0,4,40,76,88,100]:return W(0)
 if region=='context' and off==40:return W(1)
 key=(region,off)
 if key not in words:words[key]=z.BitVec('initialize_'+region+'_'+str(off),32)
 return words[key]
r=[z.BitVec('init_r'+str(i),64) for i in range(11)];r[1]=('output',0);r[2]=('context',0);r[3]=('state',0);r[4]=('instruction',0);r[10]=('stack',0)
state=prefix.execute(text,address,0x1438,0x19d0,r,{'output':360,'context':56,'state':128,'instruction':112},word)
mem={('instruction',off):word('instruction',off) for off in range(0,112,4)}
for off,v in state['memory'].items():
 if z.is_bv(v):mem['stack',off]=z.Extract(31,0,v);mem['stack',off+4]=z.Extract(63,32,v)
sizes={'stack':(-4096,0),'instruction':(0,112),'context':(0,56),'state':(0,128),'output':(0,360)}
def run(raw):return out.execute(raw,address,0x19d0,0x2e60,state['registers'],mem,sizes,memset_target=0x6890)
actual=run(text);expected={('output',off):W(0) for off in range(0,360,4)}
expected['output',4]=W(1)
for off in range(4,112,4):expected['output',off+8]=word('instruction',off)
for off,value in [(136,1),(140,4),(144,5),(148,6),(188,1)]:expected['output',off]=W(value)
for off in range(0,36,4):expected['output',152+off]=word('instruction',40+off)
expected['output',232]=word('instruction',80);expected['output',236]=word('instruction',84)
s=z.Solver();s.set(timeout=10000);s.add(z.Not(z.And(*(actual['memory'][k]==v for k,v in expected.items()))));result=s.check()
if result!=z.unsat:raise RuntimeError(('native initialization output',str(result),str(s.model()) if result==z.sat else s.reason_unknown()))
if {k for k in actual['writes'] if k[0]=='output'}!=set(expected):raise RuntimeError('initialization footprint')
if actual['calls']!=[{'address':0x1e60,'target':0x6890,'region':'output','offset':248,'bytes':112}]:raise RuntimeError('initialization clear summary')
faults=[]
for name,at,byte,value in [('wrong-authority',0x1e38,4,1),('wrong-source-role',0x1af8,4,3)]:
 bad=bytearray(text);bad[at-address+byte]=value;fault=run(bytes(bad));s=z.Solver();s.add(z.Or(*(fault['memory'][k]!=v for k,v in expected.items())));result=s.check()
 if result!=z.sat:raise RuntimeError(('missed fault',name,str(result)))
 faults.append({'name':name,'result':str(result),'witness':str(s.model())})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':[{'name':'all ninety initialization output words','result':'unsat'}],'faults':faults,'instructions':actual['instructions'],'outputWords':90,'calls':actual['calls'],'inputHashes':{str(p):sha(p) for p in [Path(__file__),repo/'verification/sbf_output.py',repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',elf]},'scope':'Actual valid/signed Initialize suffix constructs exact native Live schedule with claimed0 and one funding transfer4/5/6, ToCustody, Actor authority and empty second effect. Entry registers/stack obtained from actual canonical native dispatch; reaching valid suffix established separately. Trusted interpreter/native layout/disjoint memory/memset summary/CALL preservation remain. No account adapter/commit theorem.'}
file=base/'initialize-output-report.json';file.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':actual['instructions'],'outputWords':90,'faults':len(faults)}))
