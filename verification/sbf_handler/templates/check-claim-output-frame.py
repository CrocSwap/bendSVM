"""Trace payout stack inputs across original division routes and caller buffers."""
from pathlib import Path
import hashlib,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
import sbf_leaf as m
from sbf_elf import text_section
source=base/'check-caller-calls.py'
# Reuse the reviewed exploratory caller semantics, exposing its complete word map.
# Only bookkeeping and additional symbolic initial frame words are changed.
src=source.read_text().split('rows=[];routes=[]')[0]
old="words={};calls=[];visited=[]";new="words={k+delta:z.Extract(31+8*delta,8*delta,v) for k,v in protected.items() for delta in [0,4]};calls=[];visited=[]"
if src.count(old)!=1:raise RuntimeError('caller initialization extraction')
src=src.replace(old,new)
protected={off:z.BitVec('payout_saved_'+str(-off),64) for off in [-0x158,-0x120,-0x118,-0x110,-0x100,-0xf8,-0xf0,-0xe8,-0xd8,-0xd0,-0xc8,-0xc0,-0xb8,-0xb0]}
ns={'__file__':str(base/'check-caller-calls.py'),'protected':protected};exec(compile(src,str(source),'exec'),ns)
rows=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result)))
 rows.append({'name':name,'result':str(result)})
for name,start in [('full',0x2500)]:
 state=ns['run'](start);words=state['words']
 prove(name+' caller preserves complete payout stack words',z.And(*(z.Concat(words[k+4],words[k])==v for k,v in protected.items())))
 # Typed output buffers of all div16 calls cannot overlap these retained words.
 for call in state['calls']:
  if not all(call['target']+40<=off or off+8<=call['target'] for off in protected):raise RuntimeError('call output overlaps payout state')
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
# Reuse the current router's exact initial register/spill interpretation.
routefile=base/'check-call-routes.py';rs=routefile.read_text();rn={'__file__':str(routefile)};exec(compile(rs[:rs.index('rows=[]')],str(routefile),'exec'),rn)
regs=rn['r'];mem={**rn['mem'],**protected,-0x138:z.BitVecVal(0,64),-0x168:rn['ext'](rn['lo'](rn['d'])),-0x178:rn['ext'](rn['lo'](rn['h']))<<32,-0x180:rn['ext'](rn['hi'](rn['q']))}
for name,stop in [('direct',0x24a8),('native',0x2610),('full',0x2500),('small',0x2680)]:
 state=m.execute(text,address,0x2490,stop,regs,{},lambda *_:None,mem)
 prove(name+' router preserves payout stack',z.And(*(state['memory'][k]==v for k,v in protected.items())))
state=m.execute(text,address,0x24a8,0x2748,regs,{},lambda *_:None,mem)
prove('direct quotient packing preserves payout stack',z.And(*(state['memory'][k]==v for k,v in protected.items())))
native=m.execute(text,address,0x2490,0x2610,regs,{},lambda *_:None,mem)
state=m.execute(text,address,0x2610,0x2748,native['registers'],{},lambda *_:None,native['memory'],native_division=True)
prove('native quotient preserves payout stack',z.And(*(state['memory'][k]==v for k,v in protected.items())))
# The separately qualified local MUL extension preserves the same frame domain.
import importlib.util
model_path=base/'small-quotient-model.py';spec=importlib.util.spec_from_file_location('small_payout_frame',model_path);small=importlib.util.module_from_spec(spec);spec.loader.exec_module(small)
entry=m.execute(text,address,0x2490,0x2680,regs,{},lambda *_:None,mem)
state=small.execute(text,address,0x2680,0x2748,entry['registers'],{},lambda *_:None,entry['memory'],native_division=True)
prove('small quotient preserves payout stack',z.And(*(state['memory'][k]==v for k,v in protected.items())))
# Replace the final context restore with a word write into pending output state.
bad=bytearray(text);struct.pack_into('<BBhi',bad,0x2710-address,0x7b,0x3a,-0x118,0)
fault=ns['run'](0x2500,bytes(bad));words=fault['words'];solver=z.Solver();solver.set(timeout=10000)
solver.add(z.Concat(words[-0x114],words[-0x118])!=protected[-0x118]);result=solver.check()
if result!=z.sat:raise RuntimeError('missed pending-state overwrite')
fault_control={'name':'pending output word overwrite','result':str(result),'witness':str(solver.model())}
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'fault':fault_control,'protectedOffsets':sorted(protected),'inputHashes':{str(p):sha(p) for p in [Path(__file__),source,routefile,model_path,elf,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']},'scope':'All fourteen original scalar stack words consumed directly or through live registers by Claim output construction remain unchanged across actual router/direct packing and native/small/full caller instructions. Callee summary assumes writes restricted to declared40-byte output and CALL frame isolation; original source-entry meaning and U32 widths remain separate obligations.'}
out=base/'claim-output-frame-report.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'report':str(out)}))
