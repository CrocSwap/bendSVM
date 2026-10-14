"""Conditional fixed-frame address separation for the pinned SBPFv0 call model."""
from pathlib import Path
import os
RUN=Path(os.environ.get("SBF_FRAME_RUN","build/sbf-call-frame"))
import hashlib,json,tomllib
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
assert z.get_version_string()=='5.1.0'
lock=Path('scripts/test-runner/Cargo.lock');packages=tomllib.loads(lock.read_text())['package']
package=next(p for p in packages if p['name']=='solana-sbpf');assert package['version']=='0.11.1'
crates=list((Path.home()/'.cargo/registry/src').glob('*/solana-sbpf-0.11.1/src/interpreter.rs'));assert len(crates)==1
source=crates[0];text=source.read_text()
# Bind the reviewed dependency branch; this is not a Rust semantics proof.
for snippet in ['frame.frame_pointer = self.reg[ebpf::FRAME_PTR_REG];','config.stack_frame_size * if config.enable_stack_frame_gaps { 2 } else { 1 };','self.reg[ebpf::FRAME_PTR_REG] += stack_frame_size as u64;','self.reg[ebpf::FRAME_PTR_REG] = frame.frame_pointer;']:
 assert text.count(snippet)==1,snippet
B=lambda n:z.BitVecVal(n,64)
base,depth,ancestor,offset,width,callee_offset=[z.BitVec(n,64) for n in ['base','depth','ancestor','offset','width','callee_offset']]
gaps=z.Bool('gaps');stride=z.If(gaps,B(8192),B(4096))
fp=lambda d:base+B(4096)+d*stride
pre=[z.ULE(base,B(2**64-1-64*8192)),z.ULT(depth,B(64)),z.ULT(ancestor,depth),z.ULE(offset,B(4096)),z.ULE(width,B(4096)-offset),z.ULT(callee_offset,B(4096))]
caller_low=fp(ancestor)-B(4096)+offset;caller_high=caller_low+width
callee_low=fp(depth)-B(4096);callee_at=callee_low+callee_offset
claims=[]
def prove(name,extra,statement):
 s=z.Solver();s.set(timeout=10000);s.add(*pre,*extra,z.Not(statement));r=s.check()
 if r!=z.unsat:raise RuntimeError((name,str(r),str(s.model()) if r==z.sat else s.reason_unknown()))
 claims.append({'name':name,'result':str(r)})
prove('frame-addresses-do-not-wrap',[],z.And(z.UGE(fp(depth),base),z.UGE(callee_low,base),z.UGE(callee_at,callee_low),z.ULT(callee_at,fp(depth))))
prove('caller-output-contained',[],z.And(z.UGE(caller_low,fp(ancestor)-B(4096)),z.UGE(caller_high,caller_low),z.ULE(caller_high,fp(ancestor))))
prove('ancestor-output-before-callee-frame',[],z.ULE(caller_high,callee_low))
prove('callee-store-cannot-touch-ancestor-output',[],z.Not(z.And(z.UGE(callee_at,caller_low),z.ULT(callee_at,caller_high))))
# The existing native dispatch wrapper places its 360-byte result at fp-2048.
prove('native-dispatch-output-disjoint',[offset==2048,width==360],z.Or(z.ULT(callee_at,caller_low),z.UGE(callee_at,caller_high)))
# Passing an ancestor pointer is permitted: it retains its original target.
mem=z.Array('before',z.BitVecSort(64),z.BitVecSort(8));value=z.BitVec('store_byte',8);i=z.BitVec('output_index',64)
prove('callee-local-store-preserves-output',[z.ULT(i,width)],z.Store(mem,callee_at,value)[caller_low+i]==mem[caller_low+i])
controls=[]
# A model that reuses the caller frame loses the separation guarantee.
s=z.Solver();s.add(*pre,width!=0,callee_offset==offset);wrong=fp(ancestor)-B(4096)+callee_offset
s.add(z.And(z.UGE(wrong,caller_low),z.ULT(wrong,caller_high)));r=s.check();assert r==z.sat
controls.append({'name':'reused-caller-frame','result':str(r),'witness':str(s.model())})
# Bounds matter: a callee can deliberately write through an ancestor pointer.
s=z.Solver();s.add(*pre,width!=0);bad=z.Store(mem,caller_low,value)
s.add(bad[caller_low]!=mem[caller_low]);r=s.check();assert r==z.sat
controls.append({'name':'unrestricted-callee-write','result':str(r),'witness':str(s.model())})
paths=[Path(__file__),lock,source]
report={'passed':True,'endToEndVerified':False,'claims':claims,'controls':controls,'dependency':{'name':package['name'],'version':package['version'],'registryChecksum':package['checksum']},'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},'scope':'Conditional fixed-frame BV64 layout and single-byte store frame theorem for up to64frames with4096-byte frames, optional4096-byte gaps and explicit address headroom. Pinned interpreter snippets are evidence of the intended model, not a Rust/JIT semantics proof. Actual VM frame setup, config, valid mapping and all callee writes staying within the modeled local frame remain assumptions. Ancestor output pointers intentionally passed to a callee are separate authorized accesses. No full handler memory theorem.'}
(RUN/'layout-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
