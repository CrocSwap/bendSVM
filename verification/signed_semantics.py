"""Total signed-width SDK semantics from the exported checked source model.

Trusted: exporter, restricted evaluator, Z3 and this driver. This does not prove
that callers satisfy bounds needed to replace wider arithmetic.
"""
import sys,json,pathlib,hashlib,time
if not __debug__:raise RuntimeError('signed semantics require Python assertions')
import z3 as z
from prove import Evaluator
CLAIMS=['all-u32-sign-extension','all-u32-low-byte-decode','all-u32-low-byte-product','all-u64-narrow-wrapping-add','no-dead-source-paths']
def check(program):
 assert z.get_version_string()=='5.1.0','solver pin'
 assert program['source']['source']=='sdk/signed.bend'
 assert program['source']['roots']==['extend32','byte_bits','mul8','add32_wrap']
 e=Evaluator(program['source']);t=e.sort(program['source']['functions']['extend32']['result'])
 def word(v):return t.constructor(0)(z.Extract(31,0,v),z.Extract(63,32,v))
 def bits(v):return z.Concat(t.accessor(0,1)(v),t.accessor(0,0)(v))
 a,b=z.BitVecs('a b',32);left,right=z.BitVecs('left right',64);rows=[]
 def query(name,bad):
  s=z.Solver();s.set(timeout=30000);s.add(bad);start=time.monotonic();status=s.check();rows.append({'name':name,'result':str(status),'seconds':time.monotonic()-start});print(name,status,flush=True);assert status==z.unsat,s.reason_unknown()
 query('all-u32-sign-extension',bits(e.call('extend32',[a],z.BoolVal(True)))!=z.SignExt(32,a))
 query('all-u32-low-byte-decode',e.call('byte_bits',[a],z.BoolVal(True))!=z.SignExt(24,z.Extract(7,0,a)))
 query('all-u32-low-byte-product',bits(e.call('mul8',[a,b],z.BoolVal(True)))!=z.SignExt(56,z.Extract(7,0,a))*z.SignExt(56,z.Extract(7,0,b)))
 query('all-u64-narrow-wrapping-add',bits(e.call('add32_wrap',[word(left),word(right)],z.BoolVal(True)))!=z.SignExt(32,z.Extract(31,0,left)+z.Extract(31,0,right)))
 query('no-dead-source-paths',z.Or(e.dead))
 assert [r['name'] for r in rows]==CLAIMS
 return {'passed':True,'z3':z.get_version_string(),'claims':rows}
if __name__=='__main__':
 input_file=pathlib.Path(sys.argv[1]);output=pathlib.Path(sys.argv[2]);assert not output.exists(),'output exists'
 raw=input_file.read_bytes();data=json.loads(raw);sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
 own=sha(__file__)
 for p,h in data['sourceHashes'].items():assert sha(p)==h,p
 result=check(data['program'])
 for p,h in data['sourceHashes'].items():assert sha(p)==h,p
 assert input_file.read_bytes()==raw and sha(__file__)==own
 report={'passed':True,'endToEndVerified':False,'inputSha256':hashlib.sha256(raw).hexdigest(),'checkerSha256':own,'result':result}
 with output.open('x') as file:json.dump(report,file,indent=2);file.write('\n')
