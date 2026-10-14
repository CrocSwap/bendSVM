if not __debug__:raise RuntimeError('memory proof assertions required')
"""Conditional contiguous-layout arithmetic and single-write frame lemma."""
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import sys,json,hashlib
sys.path.insert(0,'verification')
import z3 as z
from adapter_contract_c import strict_tokens
from collection_caller_syntax import function_body
from loader_profile import profile
header=Path('runtime/solana_min.h').read_text();code=header.removeprefix('#pragma once\n');profile(strict_tokens(code));body=function_body(code,'read_account',set());join=lambda xs:''.join(xs)
# Bind this arithmetic experiment to the current layout expressions. This is
# not a replay of the full decoder semantic gate and does not claim otherwise.
assert join(body[8][1])=='a->data=(u8*)(p+88)'
assert join(body[9][1])=='u64next=(u64)(a->data+a->size+10240)'
assert join(body[10][1])=='constu8*rent=(constu8*)((next+7)&~(u64)7)'
assert body[12]==('return',['rent','+','8'])
v=lambda n:z.BitVecVal(n,64);base=z.BitVec('input_base',64);sizes=[z.BitVec('size_'+str(i),64) for i in range(3)];maximum=10*1024*1024
premises=[base!=0,(base&v(7))==0,z.ULE(base,v((1<<64)-1-(3*(maximum+10400)+64)))]+[z.ULE(s,v(maximum)) for s in sizes]
starts=[];data=[];rents=[];at=base+v(8)
for size in sizes:
 starts.append(at);data.append(at+v(88));rent=(at+v(88)+size+v(10240)+v(7))&~v(7);rents.append(rent);at=rent+v(8)
end=at+v(8+10+32);rows=[]
def prove(name,condition,extra=()):
 s=z.Solver();s.set(timeout=60000);s.add(*premises,*extra,z.Not(condition));r=s.check();print(name,r,flush=True);assert r==z.unsat,(name,r,s.reason_unknown());rows.append({'name':name,'result':str(r)})
prove('total-span-nonwrapping',z.UGT(end,base))
for i in range(3):
 prove('account-'+str(i)+'-ordered-extent',z.And(z.UGE(starts[i],base+v(8)),z.UGE(data[i],starts[i]),z.UGE(data[i]+sizes[i],data[i]),z.UGE(rents[i],data[i]+sizes[i]),z.ULT(rents[i],at)))
 for j in range(i+1,3):prove('payloads-disjoint-'+str(i)+'-'+str(j),z.ULE(data[i]+sizes[i],starts[j]))
wire=z.Array('before',z.BitVecSort(64),z.BitVecSort(8));write=z.BitVec('write_address',64);read=z.BitVec('read_address',64);value=z.BitVec('write_value',8);after=z.Store(wire,write,value)
for i in range(3):
 write_inside=z.And(z.UGE(write,data[i]),z.ULT(write,data[i]+sizes[i]))
 # Preserve account metadata, rent trailers and invocation count/instruction/program.
 regions=[('count',base,base+v(8)),('instruction-and-program',at,end)]
 regions += [('metadata-'+str(j),starts[j],data[j]) for j in range(3)]
 regions += [('rent-'+str(j),rents[j],rents[j]+v(8)) for j in range(3)]
 regions += [('other-data-'+str(j),data[j],data[j]+sizes[j]) for j in range(3) if j!=i]
 for name,lo,hi in regions:
  inside=z.And(z.UGE(read,lo),z.ULT(read,hi))
  prove('write-'+str(i)+'-preserves-'+name,z.Select(after,read)==z.Select(wire,read),[write_inside,inside])
s=z.Solver();s.add(*premises,*[n==v(maximum) for n in sizes]);assert s.check()==z.sat
assert Path('runtime/solana_min.h').read_text()==header
report={'passed':True,'claims':rows,'maximumSizeWitness':'sat','headerSha256':hashlib.sha256(header.encode()).hexdigest(),'scope':'Arithmetic/frame lemma for three contiguous serialized accounts, bounded sizes, aligned base and explicit total-address headroom. Layout expressions matched to runtime header; not full decoder composition, pointer provenance, VM mapping or multi-write commit proof.'}
(OUT/'layout-frame.json').write_text(json.dumps(report,indent=2)+'\n')
