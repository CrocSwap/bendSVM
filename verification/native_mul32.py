"""Exploratory exact-source/actual-C binding for imported native mul32.

Reuses a complete checked source-refinement report; this remains a trusted
receipt/template bridge, not a general C interpreter or a full handler proof.
"""
import copy,hashlib,json,pathlib,re,sys
from acyclic_c import function_bodies,mangle
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,message):
 if not ok:raise ValueError(message)
def refs(value):
 if isinstance(value,dict):
  if value.get('$')=='Ref':yield value['k']
  for v in value.values():yield from refs(v)
 elif isinstance(value,list):
  for v in value:yield from refs(v)
def normalize(value,prefix):
 if isinstance(value,str):return value[len(prefix):] if value.startswith(prefix) else value
 if isinstance(value,list):return [normalize(v,prefix) for v in value]
 if isinstance(value,dict):return {normalize(k,prefix):normalize(v,prefix) for k,v in value.items()}
 return value
PROOF_INPUTS={'sdk/math.bend','sdk/wide.bend','verification/model.ts','verification/prove.py','verification/division_loop.py','verification/multiplication.py','verification/check-multiplication.ts','compiler/primitives.ts'}
CLAIMS=['mul32_parts','mul_parts','wide-add','wide-product-parts','math.mul32_parts','limb-16-expansion','limb-16-bounds','limb-32-expansion','limb-32-bounds','checked-multiply-overflow','mul32-routing','math.mul32-routing','mul-routing','product-routing']
def certify(program,proof,canonical_bytes):
 canonical=json.loads(canonical_bytes)
 need(set(proof['hashes'])==PROOF_INPUTS,'source proof hash inventory')
 files=program['source']['files']
 need(isinstance(files,list) and bool(files) and len(set(files))==len(files) and set(program['sourceHashes'])==set(files),'handler source hash inventory')
 need(proof['bendCommit']=='7561656155a4285c1e4ccfcb3505ab59524de973','Bend pin')
 need(proof['positive']['solver']=='5.1.0','solver pin')
 need([(r['claim'],r['result']) for r in proof['positive']['claims']]==[(n,'unsat') for n in CLAIMS],'source proof inventory')
 need(proof['positive']['models']['math']==sha(canonical_bytes),'canonical model binding')
 for name,h in proof['hashes'].items():need(sha(pathlib.Path(name).read_bytes())==h,'source proof drift')
 for name,h in program['sourceHashes'].items():need(sha(pathlib.Path(name).read_bytes())==h,'handler source drift')
 c=program['artifact']['c'];need(sha(c.encode())==program['artifact']['cSha256'],'C bytes binding')
 functions=program['source']['functions'];names=[n for n in functions if n=='mul32' or n.endswith('/sdk/math.mul32')]
 need(len(names)==1,'native function identity');root=names[0];prefix=root[:-len('mul32')]
 closure=set();pending=[root]
 while pending:
  name=pending.pop()
  if name in closure:continue
  need(name in functions,'missing source dependency');closure.add(name)
  normalized=normalize(name,prefix)
  need(normalized in canonical['functions'],'unproved source function')
  need(normalize(functions[name],prefix)==canonical['functions'][normalized],'source term mismatch')
  pending.extend(refs(functions[name].get('body')))
 signature=functions[root];need(signature['args']==['U32','U32'] and signature['result']==prefix+'U64','native signature')
 types={t['name']:t for t in program['artifact']['schema']['types']};result=types[signature['result']]
 need(result['kind']=='adt' and len(result['variants'])==1,'result shape')
 variant=result['variants'][0]
 need(variant['name']==prefix+'U64' and variant['fields']==[{'name':'lo','type':'U32'},{'name':'hi','type':'U32'}],'result fields')
 name=mangle(root);maker=variant['cMaker']
 need(maker==mangle(prefix+'U64')+'_make','maker identity')
 expected='\n  (void)a0;\n  (void)a1;\n  _Static_assert(sizeof(unsigned long long) == 8, "Requires 64-bit unsigned long long");\n  unsigned long long product = (unsigned long long)a0 * (unsigned long long)a1;\n  return '+maker+'((bend_u32)product, (bend_u32)(product >> 32));\n'
 body=function_bodies(c)[name];need(body==expected,'native body mismatch')
 pattern=r'^static (?:inline|__attribute__\(\(noinline\)\)) '+re.escape(result['cType'])+' '+re.escape(name)+r'\(bend_u32 a0, bend_u32 a1\) \{'
 need(len(re.findall(pattern,c,re.MULTILINE))==1,'native C signature')
 return {'sourceFunction':root,'sourceClosure':sorted(closure),'nativeBodySha256':sha(body.encode()),'sourceProofReused':True,'CMeaning':'reviewed unsigned 64-bit product/split template; C semantics and layout enforcement remain trusted'}
