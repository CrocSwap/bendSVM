if not __debug__:raise RuntimeError('memory proof assertions required')
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import sys,runpy,json,hashlib
sys.path.insert(0,'verification')
import z3 as z
import collection_contracts as cc
from collection_caller_syntax import function_body
n=(globals().get('qualified_layout') or runpy.run_path('verification/collection_memory/layout-frame.py',run_name='__main__'));v=n['v'];prove=n['prove'];rows=[]
header=Path('runtime/bend_collection_runtime.h').read_text();code=header
for directive in ['#pragma once','#include "solana_min.h"','#define BEND_COLLECTION_HEADER 56u']:
 assert code.count(directive)==1;code=code.replace(directive,'')
body=function_body(code,'bend_collection_commit',set());join=lambda t:''.join(t)
assert len(body)==7 and body[0][0]=='simple' and join(body[0][1])=='u8*data=c->account->data'
assert body[1][0]=='simple' and join(body[1][1])=='u64offset=BEND_COLLECTION_HEADER+(u64)w->start*c->stride'
for slot,kind,bound,destination,source in [(2,'u64','(u64)written*c->stride','offset+i','encoded[i]'),(3,'unsigned','20','i','header[i]'),(5,'unsigned','32','24+i','state_key[i]')]:
 row=body[slot];assert row[0]=='for' and join(row[1])==kind+'i=0' and join(row[2])=='i<'+bound and join(row[3])=='++i' and row[4][0]=='simple' and join(row[4][1])=='data['+destination+']='+source
assert body[4][0]=='simple' and join(body[4][1])=='write_le(data+20,next_length,4)'
assert body[6][0]=='simple' and join(body[6][1])=='c->length=next_length'
env={name:z.BitVec('commit_'+name,32) for name in ['capacity','length','start','reserved','loaded','written','next_length']}
env.update(stride=z.BitVecVal(4,32),data_size=n['sizes'][2],scratch_extent=v(8))
doc=cc.CONTRACT_DOCUMENT['contracts']['commit'];pre=cc.term(doc['precondition'],env);offset=cc.term(doc['recordStart'],env);count=cc.term(doc['recordCount'],env)
index=z.BitVec('commit_loop_index',64);size=env['data_size'];base=n['data'][2]
terms=[('records',z.ULT(index,count),offset+index),('header',z.ULT(index,v(20)),index),('length',z.ULT(index,v(4)),v(20)+index),('key',z.ULT(index,v(32)),v(24)+index)]
def check(name,condition,extra=()):
 s=z.Solver();s.set(timeout=60000);s.add(*n['premises'],pre,*extra,z.Not(condition));r=s.check();print(name,r,flush=True);assert r==z.unsat,(name,r,s.reason_unknown());rows.append({'name':name,'result':str(r)})
for label,active,relative in terms:
 check(label+'-destination-inside-account',z.And(z.ULT(relative,size),z.UGE(base+relative,base),z.ULT(base+relative,base+size)),[active])
write=z.BitVec('commit_write',64);read=n['read'];wire=n['wire'];after=z.Store(wire,write,n['value'])
active_write=z.Or(*[z.And(active,write==base+relative) for _,active,relative in terms])
regions=[('count',n['base'],n['base']+v(8)),('instruction-program',n['at'],n['end'])]+[('metadata-'+str(i),n['starts'][i],n['data'][i]) for i in range(3)]+[('rent-'+str(i),n['rents'][i],n['rents'][i]+v(8)) for i in range(3)]+[('other-data-'+str(i),n['data'][i],n['data'][i]+n['sizes'][i]) for i in range(2)]
for label,lo,hi in regions:check('commit-preserves-'+label,z.Select(after,read)==z.Select(wire,read),[active_write,z.UGE(read,lo),z.ULT(read,hi)])
s=z.Solver();s.add(*n['premises'],pre,env['written']==2);assert s.check()==z.sat
# A shifted record destination violates the allocation bound despite valid plan facts.
s=z.Solver();s.set(timeout=60000);s.add(*n['premises'],pre,index==0,z.ULT(index,count),z.UGE(offset+index+v(56),size));r=s.check();assert r==z.sat,r
assert Path('runtime/bend_collection_runtime.h').read_text()==header
(OUT/'commit-frame.json').write_text(json.dumps({'passed':True,'claims':rows,'twoRecordWriteWitness':'sat','shiftedDestinationControl':'sat','headerSha256':hashlib.sha256(header.encode()).hexdigest(),'contractInterfaceHash':cc.CONTRACT_INTERFACE_HASH,'scope':'Restricted parsed commit destination families connected to three-account contiguous-layout frame arithmetic under the shared commit precondition, four-byte stride and eight-byte scratch. Single-write frame property supports induction but whole-loop execution, local descriptor stores, object provenance and SBF mapping remain outside this experiment.'},indent=2)+'\n')
print('14 commit destination/frame claims and shifted-destination control passed',flush=True)
