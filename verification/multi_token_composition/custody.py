"""Fresh custody helper equivalence and caller-binding failure controls.

This component models a reviewed helper template; it does not connect the
caller bindings to the full adapter execution or serialized memory yet.
"""
import sys
sys.path.insert(0,'verification')
from token_custody import parse,result,bind,TOKEN,z,Grammar
from multi_token_composition.common import begin,finish

data,binding,out=begin(sys.argv[1],sys.argv[2])
rows=[]
for f in data['fixtures']:
 parsed=parse(f['files']);key2,key3,derived=z.BitVecs('key2 key3 derived',256);executable=z.Bool('executable');rc=z.BitVec('pda_result',64)
 actual=result(parsed,key2,executable,key3,rc,derived)
 expected=z.And(key2==z.BitVecVal(int.from_bytes(TOKEN,'little'),256),executable,rc==0,derived==key3)
 solver=z.Solver();solver.add((actual==0)!=expected);assert solver.check()==z.unsat
 witness=z.Solver();witness.add(expected);assert witness.check()==z.sat
 controls=[]
 for name,changed in [('wrong-program',result({**parsed,'tokenKey':parsed['tokenKey']^1},key2,executable,key3,rc,derived)),('missing-executable',result(parsed,key2,z.BoolVal(True),key3,rc,derived)),('missing-derived-key-check',result(parsed,key2,executable,key3,rc,key3)),('missing-syscall-failure',result(parsed,key2,executable,key3,z.BitVecVal(0,64),derived))]:
  solver=z.Solver();solver.add(changed==0,z.Not(expected));assert solver.check()==z.sat;controls.append({'name':name,'result':'sat','witness':str(solver.model())})
 from types import SimpleNamespace
 w=SimpleNamespace(KEY=[z.BitVec('caller_key'+str(i),256) for i in range(4)],PROGRAM=z.BitVec('caller_program',256),EXECUTABLE=[z.Bool('caller_exec'+str(i)) for i in range(4)],SETUP=z.BitVec('caller_setup',64),BUMP=z.BitVec('caller_bump',8))
 constraints,expected_bound=bind(parsed,w)
 solver=z.Solver();solver.add(*constraints,w.SETUP==0,z.Not(expected_bound));assert solver.check()==z.unsat
 solver=z.Solver();solver.add(*constraints,w.SETUP==0);assert solver.check()==z.sat
 for omitted in range(len(constraints)):
  solver=z.Solver();solver.add(*[c for i,c in enumerate(constraints) if i!=omitted],w.SETUP==0,z.Not(expected_bound));assert solver.check()==z.sat
  controls.append({'name':'missing-caller-binding-'+str(omitted),'result':'sat','witness':str(solver.model())})
 text=f['files']['token.h'];start=text.index('static inline u64 bend_custody(');end=text.index('\n}',start)+2;original_body=text[start:end]
 grammar=[]
 for name,changed in [
  ('comment-spoof',text.replace('if (!bend_token_program(&accounts[2])) return 10;','if (0) return 10;')+'\n/*'+original_body+'*/\n'),
  ('macro-shadow',text+'\n#define bend_token_program(x) 1\n'),
  ('duplicate-binding',text+'\nextern int bend_token_program(const Account *a);\n'),
  ('wrong-seed-root',text.replace('{{prefix,4},{accounts[0].key,32}}','{{prefix,4},{accounts[1].key,32}}'))]:
  try:parse({**f['files'],'token.h':changed})
  except (AssertionError,Grammar) as error:grammar.append({'name':name,'result':'refused','reason':str(error)})
  else:raise AssertionError('accepted '+name)
 equivalent=parse({**f['files'],'token.h':text+'\n/*'+original_body+'*/\n'});assert equivalent['tokenKey']==parsed['tokenKey']
 rows.append({'name':f['name'],'parsed':parsed,'grammarControls':grammar,'commentEquivalent':True,'successEquivalence':'unsat','callerBindingEquivalence':'unsat','successWitness':'sat','controls':controls});print(f['name'],'custody model passed',flush=True)
finish(data,binding,out,'custody',rows)
