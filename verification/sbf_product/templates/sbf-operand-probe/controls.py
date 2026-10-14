from pathlib import Path
import hashlib,importlib.util,json,struct,subprocess,sys
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('paths',base/'paths.py');p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
files=[Path(__file__).resolve().parents[2]/'verification/sbf_elf.py',Path(__file__).resolve().parents[2]/'verification/sbf_paths.py',Path(__file__).resolve().parents[2]/'verification/sbf_cfg.py',Path(__file__).resolve().parents[2]/'verification/sbf_machine.py',base/'paths.py',base/'paths-report.json',p.elf,Path(__file__)]
bindings={str(f):sha(f) for f in files};rows=[]
def refuse(name,call,reason):
 try:call()
 except ValueError as e:
  if str(e)!=reason:raise RuntimeError((name,str(e),reason))
  rows.append({'name':name,'reason':str(e)})
 else:raise RuntimeError('accepted '+name)
def altered(at,field,value):
 b=bytearray(p.text);offset=at-p.address
 if field=='opcode':b[offset]=value
 elif field=='registers':b[offset+1]=value
 elif field=='offset':struct.pack_into('<h',b,offset+2,value)
 elif field=='immediate':struct.pack_into('<i',b,offset+4,value)
 else:raise RuntimeError('unknown mutation')
 return bytes(b)
for name,at,field,value,reason in [
 ('call in operand cone',0x16f0,'opcode',0x85,'unsupported path opcode 0x85'),
 ('signed branch',0x1708,'opcode',0x6d,'unsupported branch'),
 ('cycle in operand cone',0x1708,'offset',-1,'cyclic cone'),
 ('uninitialized stack input',0x16e0,'offset',-4088,'initialized stack load'),
 ('misaligned input word',0x1680,'offset',0x61,'input word alignment'),
 ('out-of-range register',0x16f0,'registers',0xfb,'register range'),
 ('shift by width',0x1f30,'immediate',64,'shift fields'),
 ('reserved immediate',0x16f0,'immediate',1,'move fields'),
 ('input load from stack',0x1680,'registers',0xa4,'input load region'),
 ('write frame pointer',0x1460,'registers',0x3a,'word load base'),
 ('register branch reserved immediate',0x1708,'immediate',1,'branch reserved fields'),
 ('immediate branch reserved source',0x1448,'registers',0x11,'branch reserved fields'),
 ('coincident conditional successors',0x1708,'offset',0,'coincident branch successors unsupported'),
]:refuse(name,lambda at=at,field=field,value=value:p.analyze(altered(at,field,value)),reason)
original=p.z.Solver
class Unknown:
 def set(self,**kw):pass
 def add(self,*args):pass
 def check(self):return p.z.unknown
 def reason_unknown(self):return 'forced path control'
try:
 p.z.Solver=Unknown
 refuse('solver UNKNOWN',lambda:p.analyze(p.text),'UNKNOWN: forced path control')
finally:p.z.Solver=original
r=subprocess.run([sys.executable,'-O',str(base/'paths.py')],capture_output=True,text=True)
if r.returncode==0 or 'assertions required' not in r.stderr:raise RuntimeError('optimized Python accepted')
rows.append({'name':'optimized Python','exitCode':r.returncode,'reason':'assertions required'})
positive=p.analyze(p.text)
if positive['result']!='unsat' or positive['reachability']!='sat':raise RuntimeError('positive recovery')
if bindings!={str(f):sha(f) for f in files}:raise RuntimeError('evidence changed')
report={'passed':True,'exploratory':True,'inputHashes':bindings,'controls':rows,'positiveRecovery':positive,'scope':'Rejection tests for the new acyclic operand model; no runtime or full-program proof claim.'}
(base/'controls-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'controls':len(rows),'positiveRecovery':positive}))
