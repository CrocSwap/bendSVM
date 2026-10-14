"""PDA witness interpretation guard positive and refusal controls."""
import sys
sys.path.insert(0,'verification')
import z3 as z
from multi_token_composition.pda_witness import rewrite,NAMES
from multi_token_composition.common import begin,finish
data,binding,out=begin(sys.argv[1],sys.argv[2])
key=z.BitVec('key',256);program=z.BitVec('program',256);other=z.BitVec('other_key',256)
funcs=[z.Function(name,z.BitVecSort(256),z.BitVecSort(256),z.BitVecSort(width)) for name,width in NAMES.items()]
pins=[(f(key,program),z.BitVecVal(i,f.range().size())) for i,f in enumerate(funcs)]
index=z.BitVec('array_index',32)
conditions=[funcs[0](key,program)==0,z.Select(z.Lambda(index,z.Extract(7,0,funcs[1](key,program))+z.Extract(7,0,index)),z.BitVecVal(1,32))==2,funcs[2](key,program)==2]
rewritten=rewrite(conditions,pins);solver=z.Solver();solver.add(*rewritten);assert solver.check()==z.sat
# Multiple applications are allowed when the same constant interpretation fits.
rewrite(conditions+[funcs[0](other,program)==0],pins+[(funcs[0](other,program),z.BitVecVal(0,64))])
rows=[]
for name,cs,ps,reason in [
 ('missing-pin',conditions,pins[:-1],'missing application pin'),
 ('duplicate-pin',conditions,pins+[pins[0]],'application inventory'),
 ('inconsistent-values',conditions+[funcs[0](other,program)==1],pins+[(funcs[0](other,program),z.BitVecVal(1,64))],'inconsistent constant interpretation'),
 ('wrong-sort',conditions,[(pins[0][0],z.BitVecVal(0,32)),*pins[1:]],'PDA output signature')]:
 try:rewrite(cs,ps)
 except AssertionError as error:assert str(error)==reason;rows.append({'name':name,'reason':str(error)})
 else:raise AssertionError('accepted '+name)
finish(data,binding,out,'pda-controls',rows)
