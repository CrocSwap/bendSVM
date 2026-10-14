"""Controls for the current product's conditional stack-store model and boundary."""
from pathlib import Path
import hashlib,importlib.util,json,struct,sys
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
run=Path(sys.argv[1]).resolve();output=Path(sys.argv[2]).resolve()
def load(name,file):
 spec=importlib.util.spec_from_file_location(name,file);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
carry=load('carry_control',run/'build/sbf-carry-probe/check.py')
paths=load('path_control',run/'build/sbf-operand-probe/paths.py')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
files=[Path(__file__).resolve(),run/'build/sbf-carry-probe/check.py',run/'build/sbf-slice-probe/check.py',run/'build/sbf-operand-probe/paths.py',run/'verification/sbf_machine.py',run/'verification/sbf_paths.py',run/'verification/sbf_cfg.py',run/'verification/sbf_elf.py',paths.elf]
before={str(p):sha(p) for p in files};rows=[]
def need(ok,why):
 if not ok:raise RuntimeError(why)
def refuse(name,call,reason):
 try:call()
 except ValueError as error:need(str(error)==reason,(name,str(error),reason))
 else:raise RuntimeError('accepted '+name)
 rows.append({'name':name,'refused':reason})
I=lambda op,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)
regs=[z.BitVec('conditional_r'+str(i),64) for i in range(11)]
mem={-264:z.BitVec('conditional_previous',64)}
block=I(0x5d,1,0,off=2)+I(0xb7,2)+I(0x7b,10,2,off=-264)
r,m,w,b=carry.execute(block,regs,mem);condition=regs[1]!=regs[0]
s=z.Solver();s.set(timeout=30000);s.add(z.Not(z.And(r[2]==z.If(condition,regs[2],z.BitVecVal(0,64)),m[-264]==z.If(condition,mem[-264],z.BitVecVal(0,64)),*[r[i]==regs[i] for i in range(11) if i!=2])))
need(s.check()==z.unsat,'conditional store model');need(w=={-264} and b==1,'conditional store inventory')
rows.append({'name':'both conditional-store paths','result':'unsat'})
refuse('uninitialized skipped store',lambda:carry.execute(block,regs,{}),'conditional store shape')
refuse('different store source',lambda:carry.execute(block[:16]+I(0x7b,10,3,off=-264),regs,mem),'conditional store shape')
refuse('unsupported skip span',lambda:carry.execute(I(0x5d,1,0,off=3)+block[8:],regs,mem),'conditional skip shape')
code=paths.text[0x2020-paths.address:0x21a8-paths.address]
bad=bytearray(code);struct.pack_into('<h',bad,0x2190-0x2020+2,1)
fault=carry.prove(bytes(bad));need(fault['result']=='sat','unconditional store fault')
parts=fault['partialProducts'];wanted=(parts['p00']+(parts['p10']<<32)+(parts['p01']<<32)+(parts['p11']<<64))%2**128
need(fault['expected']==wanted and fault['actual']!=wanted,'integer counterexample replay')
rows.append({'name':'wrong skip target','result':'sat','counterexample':fault})
original_execute=carry.execute
def wrong_entry(code,registers,memory):
 memory=dict(memory);memory[-264]=z.BitVecVal(0,64);return original_execute(code,registers,memory)
try:
 carry.execute=wrong_entry;fault=carry.prove(code)
finally:carry.execute=original_execute
need(fault['result']=='sat','wrong incoming carry premise')
rows.append({'name':'wrong incoming carry','result':'sat','counterexample':fault})
world={};baseline=paths.analyze(paths.text,world);need(baseline['result']=='unsat' and baseline['reachability']=='sat','path prerequisite')
for value,want in [(1,z.unsat),(0,z.sat)]:
 s=z.Solver();s.set(timeout=30000);s.add(*world['assumptions'],world['guard'],world['memory'][-264]!=value)
 result=s.check();need(result==want,'entry carry connection')
 rows.append({'name':'entry carry '+str(value),'result':str(result)})
original_tactic=carry.z.Tactic
class UnknownSolver:
 def set(self,**kwargs):pass
 def add(self,*args):pass
 def check(self):return z.unknown
 def reason_unknown(self):return 'forced carry control'
class UnknownTactic:
 def solver(self):return UnknownSolver()
try:
 carry.z.Tactic=lambda name:UnknownTactic()
 refuse('solver UNKNOWN',lambda:carry.prove(code),'UNKNOWN: forced carry control')
finally:carry.z.Tactic=original_tactic
need(carry.prove(code)['result']=='unsat','positive recovery')
need(before=={str(p):sha(p) for p in files},'source drift')
output.parent.mkdir(parents=True,exist_ok=True)
report={'passed':True,'endToEndVerified':False,'inputHashes':before,'controls':rows,'scope':'Restricted model and entry-stack premise controls with an integer replay of a partial-product counterexample; not whole-handler, LLVM or rollback assurance.'}
output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'controls':len(rows),'report':str(output),'sha256':sha(output)}))
