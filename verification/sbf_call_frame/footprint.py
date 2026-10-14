"""Independent acyclic provenance/footprint analysis of actual division callees."""
from pathlib import Path
import os
RUN=Path(os.environ.get("SBF_FRAME_RUN","build/sbf-call-frame"))
import sys,json,hashlib,struct
sys.path.insert(0,'verification')
from sbf_elf import text_section
if not __debug__:raise RuntimeError('assertions required')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
top=json.loads(Path(os.environ['SBF_FRAME_INPUT']).read_text());qualified=top['qualification'];assert sha(qualified['report'])==qualified['sha256'];h=json.loads(Path(qualified['report']).read_text())
p=next(p for p in h['reports'] if p.endswith('/memset-wrapper-report.json'));assert sha(p)==h['reports'][p]
d=json.loads(Path(p).read_text());elf=next(p for p in d['inputHashes'] if p.endswith('/vesting.so'));assert sha(elf)==d['inputHashes'][elf]
address,text=text_section(Path(elf).read_bytes())
from model import analyze,need
leaf=analyze(text,address,0x5c50,0x6398)
parent=analyze(text,address,0x46d8,0x5c50,leaf)
need(len(parent['calls'])==1 and not leaf['calls'],'callee inventory')
controls=[]
def reject(name,at,field,value,entry,end,nested,reason):
 bad=bytearray(text)
 if field=='offset':
  need(struct.unpack_from('<h',bad,at-address+2)[0]!=value,'control must change offset');struct.pack_into('<h',bad,at-address+2,value)
 elif field=='immediate':
  need(struct.unpack_from('<i',bad,at-address+4)[0]!=value,'control must change immediate');struct.pack_into('<i',bad,at-address+4,value)
 else:bad[at-address+field]=value
 try:analyze(bytes(bad),address,entry,end,nested)
 except ValueError as e:
  need(str(e)==reason,'unexpected control reason '+name+': '+str(e));controls.append({'name':name,'reason':str(e),'at':at})
 else:raise RuntimeError('accepted '+name)
stack_write=next(a for a in leaf['accesses'] if a['region']=='stack' and a['kind']=='write')
output_write=next(a for a in leaf['accesses'] if a['region']=='output' and a['kind']=='write')
stack_read=next(a for a in leaf['accesses'] if a['region']=='stack' and a['kind']=='read')
reject('store-past-local-frame',stack_write['at'],'offset',0,0x5c50,0x6398,None,'access bounds')
reject('store-past-output',output_write['at'],'offset',40,0x5c50,0x6398,None,'access bounds')
reject('read-uninitialized-local',stack_read['at'],'offset',-4096,0x5c50,0x6398,None,'initialized stack read')
reject('wrong-nested-target',parent['calls'][0]['at'],'immediate',2,0x46d8,0x5c50,leaf,'nested target')
report={'controls':controls,'passed':True,'endToEndVerified':False,'leaf':leaf,'parent':parent,'inputHashes':{str(Path(__file__)):sha(__file__),elf:sha(elf),'verification/sbf_elf.py':sha('verification/sbf_elf.py'),str(Path(__file__).with_name('model.py')):sha(Path(__file__).with_name('model.py'))},'scope':'Independent conservative acyclic pointer-provenance and complete memory-footprint analysis of recorded div16/div4 bytes. Every syntactically reachable load/store checked, regardless of scalar branch feasibility. Callee local frames and input/output extents remain assumed valid/disjoint; nested40-byte arguments bound. This is a trusted abstract interpreter, not a VM semantics or functional arithmetic proof.'}
(RUN/'footprint-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'leafInstructions':leaf['instructions'],'parentInstructions':parent['instructions'],'accesses':len(leaf['accesses'])+len(parent['accesses'])}))
