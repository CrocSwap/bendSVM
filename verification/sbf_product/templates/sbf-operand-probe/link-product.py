"""Fresh native-entry operand proof linked to the complete conditional product theorem."""
from pathlib import Path
import hashlib,importlib.util,json,subprocess,sys
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent;root=base.parents[1]
spec=importlib.util.spec_from_file_location('paths',base/'paths.py');paths=importlib.util.module_from_spec(spec);spec.loader.exec_module(paths)
need=paths.need;sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
product_dir=root/'build/sbf-carry-probe'
files=[Path(__file__).resolve().parents[2]/'verification/sbf_elf.py',Path(__file__).resolve().parents[2]/'verification/sbf_paths.py',Path(__file__).resolve().parents[2]/'verification/sbf_cfg.py',Path(__file__).resolve().parents[2]/'verification/sbf_machine.py',Path(__file__),base/'paths.py',paths.elf,root/'build/sbf-slice-probe/check.py',product_dir/'product.py',product_dir/'compose.py',product_dir/'check.py']
bound={str(p):sha(p) for p in files}
state={};path_result=paths.analyze(paths.text,state);need(path_result['result']=='unsat' and path_result['reachability']=='sat','fresh operand prerequisite')
p=subprocess.run([sys.executable,str(product_dir/'product.py')],capture_output=True,text=True,timeout=120)
(base/'product-prerequisite.log').write_text(p.stdout+p.stderr);need(p.returncode==0,'fresh product prerequisite')
product=json.loads((product_dir/'product-report.json').read_text());need(product['passed'],'fresh product report')
for f,h in product['inputHashes'].items():need(sha(Path(f))==h,'product source drift')
# Capture the exact scalar proof's initial state from its actual execution call.
scalar=paths.m;original=scalar.execute;captured={}
def capture(code,regs,mem):
 need(not captured,'one prefix execution');captured.update(registers=list(regs),memory=dict(mem));return original(code,regs,mem)
try:
 scalar.execute=capture
 proof=scalar.prove(paths.text[paths.stop-paths.address:0x2020-paths.address])
finally:scalar.execute=original
need(proof['result']=='unsat','fresh exact prefix')
actual=[];pointer_symbols={}
for value in state['registers']:
 if isinstance(value,tuple):
  # Prefix/suffix preserve pointer registers; they never dereference r3/r6.
  region,offset=value;pointer_symbols.setdefault(region,z.BitVec('address_'+region,64));actual.append(pointer_symbols[region]+offset)
 else:actual.append(value)
inputs=state['inputs'];elapsed=state['elapsed']
limbs=[z.Extract(31,0,elapsed),z.Extract(63,32,elapsed),inputs[('state',84)],inputs[('state',88)]]
sub=list(zip(z.BitVecs('alo ahi blo bhi',32),limbs))+[(z.BitVec('r'+str(i),64),value) for i,value in enumerate(actual)]+[(z.BitVec('incoming_start_high',64),state['memory'][-0xd8])]
expected=[z.substitute(v,*sub) for v in captured['registers']]
expected_mem={k:z.substitute(v,*sub) for k,v in captured['memory'].items()}
claims=[a==b for a,b in zip(actual,expected)]+[state['memory'][k]==v for k,v in expected_mem.items()]
# The carry block's start-high word and pending carry flag are connected to
# the actual native-entry memory here, including the flag's required value 1.
def query(claim):
 s=z.Solver();s.set(timeout=30000);s.add(*state['assumptions'],state['guard'],claim);r=s.check();need(r!=z.unknown,'UNKNOWN: '+s.reason_unknown());return s,r
_,result=query(z.Not(z.And(*claims)));need(result==z.unsat,'native/product boundary mismatch')
fault=list(claims);fault[7]=(actual[7]^z.BitVecVal(1,64))==expected[7]
s,r=query(z.Not(z.And(*fault)));need(r==z.sat,'boundary fault not detected')
witness={reg+'_'+str(off):s.model().eval(v,model_completion=True).as_long() for (reg,off),v in inputs.items()}
need(bound=={str(p):sha(p) for p in files},'source drift')
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':bound,'freshPath':path_result,'freshPrefix':proof,'productReportSha256':sha(product_dir/'product-report.json'),'productPrerequisiteLogSha256':sha(base/'product-prerequisite.log'),'boundary':{'result':'unsat','registers':11,'stackSlots':sorted(expected_mem),'carryExtraStackSlots':[-0xd8,-0x108]},'boundaryFault':{'result':'sat','witness':witness},'scope':'Conditional native handler entry to reconstructed product: under valid disjoint ABI regions and Live/Claim tags, reaching the product slice supplies elapsed=(now-start) and total limbs, strict start<now<end, and the 78-instruction arithmetic theorem reconstructs total*elapsed in128bits. Source field/layout/ABI correspondence is externally supplied; actual later top-limb accumulation, division, result commit and whole-handler equivalence remain outside this proof.'}
(base/'linked-product-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'boundary':report['boundary'],'scope':report['scope']}))
