"""Checked source/actual-C certificate for the native unsigned divmod leaf.

Standard C unsigned / and % semantics and the reviewed exact template remain
trusted here. This is not a parsed-Clang or machine-code preservation theorem.
"""
import hashlib,json,pathlib,re,math
from acyclic_c import function_bodies,mangle
from native_mul32 import need,refs,normalize
sha=lambda b:hashlib.sha256(b).hexdigest()
ROOTS=['div_step','div2','div4','div8','div16','div32','div64','divmod','div','mod']
PROOF_INPUTS={'sdk/math.bend','verification/model.ts','verification/prove.py','verification/division_step.py','verification/division_loop.py','verification/native_arithmetic.py','verification/native_divmod.py','compiler/primitives.ts','verification/native_mul32.py','verification/acyclic_c.py'}
def semantic(t):
 if isinstance(t,list):return [semantic(v) for v in t]
 if isinstance(t,dict):return {k:semantic(v) for k,v in t.items() if k not in ['cType','cMaker','cName']}
 return t

def validate_proof(proof,canonical_bytes):
 need(set(proof)=={'bendCommit','modelSha256','division','native','hashes'},'division prerequisite fields')
 need(proof['modelSha256']==sha(canonical_bytes),'division model binding')
 d=proof['division'];need(set(d)=={'solver','step','composition','induction','fastPaths','wrappers'},'division report fields')
 def timing(v):return type(v) in (int,float) and math.isfinite(v) and v>=0
 for row in [d['step'],*d['induction'],*d['fastPaths'],*d['wrappers']]:
  need(set(row)=={'claim','result','seconds'} and timing(row['seconds']),'division claim fields')
 n=proof['native'];need(set(n)=={'solver','claims','negative'},'native formula fields')
 for row in n['claims']:
  need(set(row)=={'claim','result','seconds'} and timing(row['seconds']),'native formula claim fields')
 bad=n['negative'];need(set(bad)=={'claim','result','seconds','counterexample'} and timing(bad['seconds']),'native control fields')
 witness=bad['counterexample'];need(set(witness)=={'al','ah','bl','bh'},'native control witness fields')
 need(all(isinstance(v,str) and re.fullmatch(r'[0-9]+',v) and 0<=int(v)<2**32 for v in witness.values()),'native control witness range')
 a=int(witness['al'])+(int(witness['ah'])<<32);b=int(witness['bl'])+(int(witness['bh'])<<32)
 need(b!=0 and ((a*b)&((1<<64)-1))!=a//b,'native control witness replay')

def certify(program,proof,canonical_bytes):
 validate_proof(proof,canonical_bytes)
 need(set(proof)=={'bendCommit','modelSha256','division','native','hashes'},'division prerequisite fields')
 need(proof['bendCommit']=='7561656155a4285c1e4ccfcb3505ab59524de973','Bend pin')
 need(proof['modelSha256']==sha(canonical_bytes),'division model binding')
 need(set(proof['hashes'])==PROOF_INPUTS,'division source inventory')
 for p,h in proof['hashes'].items():need(sha(pathlib.Path(p).read_bytes())==h,'division source drift')
 canonical=json.loads(canonical_bytes)
 need(canonical['version']==1 and canonical['source']=='sdk/math.bend' and canonical['roots']==ROOTS,'division model identity')
 division=proof['division'];need(division['solver']=='5.1.0','division solver')
 need(division['step']['claim']=='restoring-step' and division['step']['result']=='unsat','division step')
 need(division['composition']==[{'function':f'div{n}','step_count':n,'result':'checked'} for n in [2,4,8,16,32,64]],'division composition')
 induction=[f'packing-step-{i}' for i in range(64)]+['integer-remainder-bounds','dividend-invariant-preserved','initial-state','final-euclidean-result']
 need([(c['claim'],c['result']) for c in division['induction']]==[(n,'unsat') for n in induction],'division induction')
 # These fast-path names are fixed by the source wrapper proof, not inferred
 # from an incoming report's inventory.
 fast=['high-divisor-initial-state']+[f'high-divisor-skipped-prefix-{i}' for i in range(1,33)]
 need([(c['claim'],c['result']) for c in division['fastPaths']]==[(n,'unsat') for n in fast],'division fast paths')
 need([(c['claim'],c['result']) for c in division['wrappers']]==[(n,'unsat') for n in ['divmod','div','mod']],'division wrappers')
 native=proof['native'];need(native['solver']=='5.1.0','native solver')
 need([(c['claim'],c['result']) for c in native['claims']]==[(n,'unsat') for n in ['u64-input-packing','zero-divisor-error','quotient-remainder-split','u32-product-split']],'native formula claims')
 need(native['negative']['claim']=='wrong-divide-operator-rejected' and native['negative']['result']=='sat' and bool(native['negative'].get('counterexample')),'native formula control')
 files=program['source']['files'];need(len(files)==len(set(files)) and set(files)==set(program['sourceHashes']),'handler source inventory')
 for p,h in program['sourceHashes'].items():need(sha(pathlib.Path(p).read_bytes())==h,'handler source drift')
 c=program['artifact']['c'];need(sha(c.encode())==program['artifact']['cSha256'],'C byte binding')
 functions=program['source']['functions'];names=[n for n in functions if n=='divmod' or n.endswith('/sdk/math.divmod')]
 need(len(names)==1,'native division identity');root=names[0];prefix=root[:-len('divmod')]
 closure=set();todo=[root]
 while todo:
  name=todo.pop()
  if name in closure:continue
  need(name in functions,'missing source callee');closure.add(name);short=normalize(name,prefix)
  need(short in canonical['functions'],'unproved division callee')
  need(normalize(functions[name],prefix)==canonical['functions'][short],'division source term mismatch')
  todo.extend(refs(functions[name].get('body')))
 sig=functions[root];need(sig['args']==[prefix+'U64']*2 and sig['result']==prefix+'DivResult','division signature')
 types={t['name']:t for t in program['artifact']['schema']['types']};ct={t['name']:t for t in canonical['schema']['types']}
 for short in ['U64','Division','DivResult']:
  need(semantic(normalize(types[prefix+short],prefix))==semantic(ct[short]),'division type layout')
  need(types[prefix+short]['cType']==mangle(prefix+short)+'_t','division C type')
  for v in types[prefix+short]['variants']:need(v['cMaker']==mangle(v['name'])+'_make','division maker')
 maker=lambda n:mangle(prefix+n)+'_make'
 expected='\n  (void)a0;\n  (void)a1;\n  _Static_assert(sizeof(unsigned long long) == 8, "Requires 64-bit unsigned long long");\n  if (a0.tag != 0u || a1.tag != 0u) __builtin_unreachable();\n  unsigned long long n = ((unsigned long long)a0.as.c0.f1 << 32) | a0.as.c0.f0;\n  unsigned long long d = ((unsigned long long)a1.as.c0.f1 << 32) | a1.as.c0.f0;\n  if (!d) return '+maker('DivErr')+'(3u);\n  unsigned long long q = n / d;\n  unsigned long long r = n % d;\n  return '+maker('DivOk')+'('+maker('Division')+'(\n    '+maker('U64')+'((bend_u32)q, (bend_u32)(q >> 32)),\n    '+maker('U64')+'((bend_u32)r, (bend_u32)(r >> 32))));\n'
 symbol=mangle(root);body=function_bodies(c)[symbol];need(body==expected,'native division body mismatch')
 typ=types[prefix+'U64']['cType'];ret=types[prefix+'DivResult']['cType']
 signature=f'static inline {ret} {symbol}({typ} a0, {typ} a1) {{'
 need(c.count(signature)==1,'native division C signature')
 return {'sourceFunction':root,'sourceClosure':sorted(closure),'nativeBodySha256':sha(body.encode()),'sourceProofReused':True,'CMeaning':'reviewed guarded unsigned 64-bit division/remainder template; standard C semantics and layout enforcement remain trusted'}
