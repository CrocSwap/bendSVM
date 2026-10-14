"""Reviewed-template account decoder model, not a general C interpreter."""
from pathlib import Path
import sys,re,json,hashlib
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
import z3 as z
from adapter_contract_c import strict_tokens
from collection_caller_syntax import function_body
assert z.get_version_string()=='5.1.0'
from loader_report import SCOPE,validate,unchanged
input_path=Path(sys.argv[1]);raw=input_path.read_bytes();data=json.loads(raw);unchanged(data)
text=Path(data['headerArtifact']).read_text()
assert text.startswith('#pragma once\n');code=text[len('#pragma once\n'):];tokens=strict_tokens(code);assert '#' not in tokens
from loader_profile import profile,reader
profile(tokens)
body=function_body(code,'read_account',set());compact=lambda t:''.join(t)
assert len(body)==13 and body[0][0]=='if' and body[0][3] is None
assert body[0][2]==('return',['(','const','u8','*',')','0'])
def number(s):
 assert re.fullmatch('0|[1-9][0-9]*',s);return int(s)
def match(pattern,s):
 m=re.fullmatch(pattern,s);assert m is not None,s;return m.groups()
marker_offset,operator,marker_value=match(r'p\[([0-9]+)\](!=|==)([0-9]+)',compact(body[0][1]));marker_offset=number(marker_offset);marker_value=number(marker_value)
fields={}
for row in body[1:9]:
 assert row[0]=='simple';s=compact(row[1]);name,rhs=match(r'a->(\w+)=(.*)',s);assert name not in fields;fields[name]=rhs
assert set(fields)=={'signer','writable','executable','key','owner','size','lamports','data'}
assert body[9][0]=='simple' and body[10][0]=='simple' and body[11][0]=='simple' and body[12][0]=='return'
reserve=number(match(r'u64next=\(u64\)\(a->data\+a->size\+([0-9]+)\)',compact(body[9][1]))[0])
rounding,mask=map(number,match(r'constu8\*rent=\(constu8\*\)\(\(next\+([0-9]+)\)&~\(u64\)([0-9]+)\)',compact(body[10][1])))
assert compact(body[11][1])=='a->rent_epoch=read_le(rent,8)'
trailer=number(match(r'rent\+([0-9]+)',compact(body[12][1]))[0])
# Byte decoding and native address casts are explicit primitive assumptions here.
b=z.Array('serialized',z.BitVecSort(64),z.BitVecSort(8));base=z.BitVec('base',64)
v=lambda n:z.BitVecVal(n,64)
def byte(n):return z.Select(b,n if z.is_bv(n) else v(n))
def specification_le(n):return z.Concat(*[byte(n+v(i)) for i in range(7,-1,-1)])
initial,shift=reader(code,number,match)
def le(n):
 result=v(initial)
 for i in range(8):result=result | (z.ZeroExt(56,byte(n+v(i))) << (shift*i))
 return result
length=specification_le(v(80));expected_rent=v(88)+length+v(10240)+((-length)&v(7));expected_end=expected_rent+v(8)
# The trusted loader supplies a valid aligned, non-wrapping allocation.
premises=[base!=0,(base&v(7))==0,z.ULE(length,v(10*1024*1024)),z.ULE(base,v((1<<64)-1-(10*1024*1024+10400)))]
actual={};read_spans=[('marker',v(marker_offset),1,False)]
for name,rhs in fields.items():
 if name in ('signer','writable','executable'):
  offset=number(match(r'p\[([0-9]+)\]!=0',rhs)[0]);actual[name]=byte(offset)!=0;read_spans.append((name,v(offset),1,True))
 elif name=='size':
  offset=v(number(match(r'read_le\(p\+([0-9]+),8\)',rhs)[0]));actual[name]=le(offset);read_spans.append(('size',offset,8,True))
 else:
  pattern={'key':r'p\+([0-9]+)','owner':r'p\+([0-9]+)',
           'lamports':r'\(u64\*\)\(p\+([0-9]+)\)','data':r'\(u8\*\)\(p\+([0-9]+)\)'}[name]
  actual[name]=v(number(match(pattern,rhs)[0]))

reject=(byte(marker_offset)!=marker_value) if operator=='!=' else (byte(marker_offset)==marker_value)
next_offset=actual['data']+actual['size']+v(reserve)
rent_address=(base+next_offset+v(rounding))&~v(mask);rent_offset=rent_address-base;end_offset=rent_offset+v(trailer)
read_spans.append(('rent',rent_offset,8,True))
rows=[];proven={}
def check(name,condition,success=False,lemmas=()):
 solver=z.Solver();solver.set(timeout=30000);solver.add(*premises)
 if success:solver.add(z.Not(reject))
 solver.add(*lemmas,z.Not(condition));status=solver.check();print(name,status,flush=True)
 assert status==z.unsat,(name,status,solver.model() if status==z.sat else solver.reason_unknown())
 rows.append({'name':name,'result':str(status)})
 proven[name]=condition
read_at=z.BitVec('read_at',64)
check('read-le8',le(read_at)==specification_le(read_at))
serialized_extent=z.If(byte(0)==255,expected_end,v(8))
for name,start,width,guard in read_spans:
 check('read-bounds-'+name,z.And(z.UGE(start+v(width),start),z.ULE(start+v(width),serialized_extent)),guard)
check('duplicate-marker',reject==(byte(0)!=255))
for name,offset in [('key',8),('owner',40),('lamports',72),('data',88)]:check(name+'-address',actual[name]==v(offset),True)
for name,offset in [('signer',1),('writable',2),('executable',3)]:check(name+'-flag',actual[name]==(byte(offset)!=0),True)
check('data-length',actual['size']==length,True)
check('rent-address',rent_offset==expected_rent,True)
check('next-account-address',end_offset==expected_end,True)
# Both dependencies were freshly proved above under the same loader premises.
# read_at is arbitrary and absent from those premises; instantiate it here.
rent_lemmas=[z.substitute(proven['read-le8'],(read_at,rent_offset)),proven['rent-address']]
check('rent-value',le(rent_offset)==specification_le(expected_rent),True,lemmas=rent_lemmas)
check('nonwrapping-intermediates',z.And(z.UGE(next_offset,actual['data']),z.UGE(base+next_offset,base),z.UGE(base+next_offset+v(rounding),base+next_offset),z.UGE(rent_address+v(trailer),rent_address)),True)
check('data-and-rent-disjoint',z.ULE(actual['data']+actual['size'],rent_offset),True)
check('next-account-aligned',(base+end_offset)&v(7)==0,True)
check('lamports-aligned',(base+actual['lamports'])&v(7)==0,True)
for name,width in [('key',32),('owner',32),('lamports',8)]:
 check('field-span-'+name,z.And(z.UGE(actual[name]+v(width),actual[name]),z.ULE(actual[name]+v(width),actual['data'])),True)
solver=z.Solver();solver.add(*premises,z.Not(reject));assert solver.check()==z.sat
report={'passed':True,'endToEndVerified':False,'version':1,'z3':z.get_version_string(),'runId':data['runId'],
 'inputSha256':hashlib.sha256(raw).hexdigest(),'sourceHashes':data['sourceHashes'],'headerSha256':hashlib.sha256(text.encode()).hexdigest(),
 'claims':rows,'successWitness':'sat','scope':SCOPE}
validate(report,data,raw);unchanged(data);assert input_path.read_bytes()==raw
with Path(sys.argv[2]).open('x') as stream:stream.write(json.dumps(report,indent=2)+'\n')
