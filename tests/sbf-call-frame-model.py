"""Pointer spill, initialization and access controls for the footprint model."""
from pathlib import Path
import hashlib,json,struct,sys,subprocess
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'verification/sbf_call_frame'))
from model import analyze
if not __debug__:raise RuntimeError('assertions required')
I=lambda op,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)
EXIT=I(0x95);address=0
def run(code):return analyze(code+EXIT,address,address,address+len(code)+8)
positives=[]
for name,code in [
 ('pointer-spill-reload',I(0x7b,10,1,-8)+I(0x79,4,10,-8)+I(0x62,4)),
 ('full-scalar-overwrite-retires-pointer',I(0x7b,10,1,-8)+I(0x7a,10,off=-8)+I(0x79,4,10,-8)+I(0x57,4,imm=255)),
 ('lowest-valid-frame-slot',I(0x7b,10,0,-4096)+I(0x79,4,10,-4096)),
]:
 d=run(code);positives.append({'name':name,'instructions':d['instructions'],'accesses':len(d['accesses'])})
refusals=[]
for name,code,reason in [
 ('partial-pointer-overwrite',I(0x7b,10,1,-8)+I(0x62,10,off=-8)+I(0x79,4,10,-8)+I(0x62,4),'pointer provenance'),
 ('forged-scalar-pointer',I(0xb7,4,imm=128)+I(0x62,4),'pointer provenance'),
 ('write-read-only-input',I(0x62,2),'write region'),
 ('read-write-only-output',I(0x61,4,1),'read fields/region'),
 ('uninitialized-frame-load',I(0x79,4,10,-8),'initialized stack read'),
 ('partial-pointer-spill',I(0x63,10,1,-4),'partial pointer spill'),
 ('word-beyond-input',I(0x61,4,2,40),'access bounds'),
 ('negative-output-offset',I(0x62,1,off=-4),'access bounds'),
 ('cyclic-control-flow',I(5,off=-1),'forward in-range control flow'),
 ('unknown-call',I(0x85,s=1,imm=0),'nested target'),
]:
 try:run(code)
 except ValueError as e:
  assert str(e)==reason,(name,str(e),reason);refusals.append({'name':name,'reason':str(e)})
 else:raise RuntimeError('accepted '+name)

for name,args in [('unaligned-base',(EXIT,1,1,9)),('truncated-extent',(EXIT,0,0,16)),('empty-extent',(b'',0,0,0)),('nonbytes-code',(bytearray(EXIT),0,0,8))]:
 try:analyze(*args)
 except ValueError as e:
  assert str(e)=='instruction extent';refusals.append({'name':name,'reason':str(e)})
 else:raise RuntimeError('accepted '+name)
model=Path('verification/sbf_call_frame/model.py')
child=subprocess.run([sys.executable,'-B','-O',str(model)],capture_output=True,text=True,timeout=10)
assert child.returncode!=0 and 'assertions required' in child.stderr
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert len(positives)==3 and len(refusals)==14
report={'passed':True,'endToEndVerified':False,'positives':positives,'refusals':refusals,'optimizedPythonRefused':True,'inputHashes':{str(p.resolve()):sha(p) for p in [Path(__file__),model]},'scope':'Synthetic bytecode controls for the actual footprint analyzer; tests of trusted model behavior, not proof of VM semantics.'}
print(json.dumps(report))
