"""Symbolic value/byte semantics for syntactically validated emitted codecs.
Trust: codec_structures' C grammar/templates, typed schema bridge and Z3.
This is not an arbitrary C interpreter or a C memory/provenance proof.
"""
import z3 as z
from codec_structures import validate,layout,parse_codecs,ident

def need(v,m):
 if not v:raise ValueError(m)
class Codecs:
 def __init__(self,source,bundle):
  self.evidence=validate(bundle);self.source=source
  self.types,self.sizes,self.order=layout(bundle['schema'])
  prefix=f'#include "{bundle["headerName"]}"\n';need(bundle['codecs'].startswith(prefix),'include')
  self.nodes=parse_codecs(bundle['codecs'][len(prefix):],self.types,self.sizes)
 def decode(self,name,bytes_):
  t=self.types[name];node=self.nodes[ident(name)];need(len(bytes_)==self.sizes[name],'decode size')
  if t['kind']=='u32':
   value=z.Concat(*reversed(bytes_));return (z.ULE(value,t['max']) if 'max' in t else z.BoolVal(True)),value
  if t['kind']=='bool':return z.ULE(bytes_[0],1),bytes_[0]!=0
  conditions=[];value=self.source.default(name)
  for i,(variant,case) in enumerate(zip(t['variants'],node['decode'])):
   fields=[];valid=[bytes_[0]==case['tag']]
   for field,read in zip(variant['fields'],case['fields']):
    offset,width=read[3],read[4];ok,child=self.decode(field['type'],bytes_[offset:offset+width]);fields.append(child);valid.append(ok)
   if case['padding'] is not None:
    begin,end=case['padding'];valid.extend(b==0 for b in bytes_[begin:end])
   condition=z.And(valid);conditions.append(condition)
   # Failed decoder outputs are unspecified and discarded by callers.
   value=z.If(bytes_[0]==case['tag'],self.source.sort(name).constructor(i)(*fields),value)
  return z.simplify(z.Or(conditions)),z.simplify(value)
 def encode(self,name,value):
  t=self.types[name];n=self.sizes[name]
  if t['kind']=='u32':return (z.ULE(value,t['max']) if 'max' in t else z.BoolVal(True)),[z.Extract(8*i+7,8*i,value) for i in range(4)]
  if t['kind']=='bool':return z.BoolVal(True),[z.If(value,z.BitVecVal(1,8),z.BitVecVal(0,8))]
  result=[z.BitVecVal(0,8) for _ in range(n)];valid=[];sort=self.source.sort(name)
  for i,(variant,case) in enumerate(zip(t['variants'],self.nodes[ident(name)]['write'])):
   branch=[z.BitVecVal(0,8) for _ in range(n)];branch[0]=z.BitVecVal(case['wire_tag'],8);guards=[sort.recognizer(i)(value)]
   for j,(field,call) in enumerate(zip(variant['fields'],case['calls'])):
    ok,child=self.encode(field['type'],sort.accessor(i,j)(value));guards.append(ok);offset=call[1];branch[offset:offset+len(child)]=child
   condition=z.And(guards);valid.append(condition);result=[z.If(sort.recognizer(i)(value),b,old) for b,old in zip(branch,result)]
  return z.simplify(z.Or(valid)),[z.simplify(b) for b in result]


class PackedDecoder:
 def __init__(self,codecs,name):
  self.codecs,self.name,self.cache=codecs,name,{}
 def range(self):return self.codecs.source.sort(self.name)
 def pair(self,packed):
  # Retain AST objects: bare Z3 node IDs may be reused after reclamation.
  if packed not in self.cache:
   n=self.codecs.sizes[self.name]
   need(packed.size()==8*n,'packed decoder width')
   bytes_=[z.Extract(8*(n-i)-1,8*(n-i-1),packed) for i in range(n)]
   self.cache[packed]=tuple(z.simplify(x) for x in self.codecs.decode(self.name,bytes_))
  return self.cache[packed]
 def __call__(self,packed):return self.pair(packed)[1]
 def ok(self,packed):return self.pair(packed)[0]
