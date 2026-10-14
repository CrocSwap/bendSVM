"""Connect actual nested division footprints to caller pending-word frames."""
from pathlib import Path
import os
RUN=Path(os.environ.get("SBF_FRAME_RUN","build/sbf-call-frame"))
import hashlib,json,sys
import z3 as z
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
read=lambda p:json.loads(Path(p).read_bytes())
if not __debug__:raise RuntimeError('assertions required')
foot=read(RUN/'footprint-report.json');layout=read(RUN/'layout-report.json')
for d in [foot,layout]:
 assert d['passed'] is True
 for p,h in d['inputs' if 'inputs' in d else 'inputHashes'].items():assert sha(p)==h
assert len(foot['controls'])==4 and len(layout['claims'])==6
qualified=read(os.environ['SBF_FRAME_INPUT'])['qualification'];assert sha(qualified['report'])==qualified['sha256'];handler=read(qualified['report'])
assert sha(handler['quotientReport'])==handler['quotientReportSha256'];quotient=read(handler['quotientReport'])
caller_path=next(p for p in quotient['reports'] if p.endswith('/caller-calls-report.json'));assert sha(caller_path)==quotient['reports'][caller_path];caller=read(caller_path)
frame_paths=[next(p for p in handler['reports'] if p.endswith('/'+role+'-frame-report.json')) for role in ['claim-output','payout','authorization']]
frames=[]
for p in frame_paths:
 assert sha(p)==handler['reports'][p];frames.append(read(p))
images={p:h for p,h in foot['inputHashes'].items() if p.endswith('/vesting.so')}
for d in [caller,*frames]:
 for p,h in d['inputHashes'].items():assert sha(p)==h
 assert {p:h for p,h in d['inputHashes'].items() if p.endswith('/vesting.so')}==images
protected=sorted(set(off for f in frames for off in f['protectedOffsets']));assert len(protected)==17
B=lambda n:z.BitVecVal(n,64)
base,i=z.BitVecs('stack_base pending_byte',64);gaps=z.Bool('stack_gaps');stride=z.If(gaps,B(8192),B(4096));fp=lambda depth:base+B(4096)+B(depth)*stride
premises=[z.ULE(base,B(2**64-1-64*8192)),z.ULT(i,B(8))]
# A single predicate builder serves both the proof and the bad-binding control.
# Subtracting the shared base preserves exact BV64 address equality and avoids
# irrelevant carry-bit search. All bytes of every enclosing region are covered.
def nonalias(target):
 bounds=[];j=z.BitVec('write_byte',64);regions=[]
 assert -4096<=target and target+40<=0
 for depth,name in [(1,'parent'),(2,'leaf')]:
  for a in foot[name]['accesses']:
   if a['kind']!='write':continue
   assert a['region'] in ['stack','output']
   low,high=(-4096,0) if a['region']=='stack' else (0,40)
   assert low<=a['offset'] and a['offset']+a['bytes']<=high
  regions.append((fp(depth)-B(4096),4096))
 regions.append((fp(0)+B(target),40))
 for start,width in regions:
  for off in protected:
   pos=fp(0)+B(off)+i
   difference=z.simplify(pos-(start+j))
   bounds.append(z.Implies(z.ULT(j,B(width)),difference!=0))
 return z.And(*bounds)
claims=[]
for route in caller['routes']:
 for index,call in enumerate(route['calls']):
  s=z.Solver();s.set(timeout=10000);s.add(*premises,z.Not(nonalias(call['target'])));r=s.check()
  if r!=z.unsat:raise RuntimeError((route['name'],index,str(r),str(s.model()) if r==z.sat else s.reason_unknown()))
  claims.append({'route':route['name'],'call':index,'at':call['at'],'result':str(r)})
assert len(claims)==4
# A wrongly bound output at a pending field defeats the same disjointness claim.
s=z.Solver();s.set(timeout=10000);s.add(*premises,z.Not(nonalias(protected[0])));r=s.check();assert r==z.sat
report={'passed':True,'endToEndVerified':False,'claims':claims,'protectedOffsets':protected,'control':{'name':'output-bound-to-pending-field','result':str(r),'witness':str(s.model())},'inputs':{p:sha(p) for p in [str(RUN/'footprint-report.json'),str(RUN/'layout-report.json'),str(Path(__file__)),caller_path,*frame_paths]},'scope':'All byte ranges of actual div16/div4 writes mapped to fixed call frames or the designated caller output; four recorded restoring call instances preserve all seventeen pending output, payout and authorization words. Conditional on verified abstract footprints, fixed-frame VM/CALL mapping, valid allocations and the existing caller bindings. Disjoint write ranges support finite store-sequence framing; not a proof of VM/JIT semantics or whole-handler memory safety.'}
(RUN/'connection-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'callInstances':4,'protectedWords':17}))
