"""Fallible vector folds: exact active prefix, order, overflow and length checks."""
import json
import sys
import z3 as z
from prove import Evaluator

program=json.load(open(sys.argv[1]))
e=Evaluator(program)
reports=[]

def storage(type_name,values):
    if len(values)==1:return values[0]
    fields=e.types[type_name]['variants'][0]['fields'];half=len(values)//2
    return e.sort(type_name).constructor(0)(storage(fields[0]['type'],values[:half]),storage(fields[1]['type'],values[half:]))

for name,capacity in [('sum',4),('ordered',4),('conjunction',2)]:
    fn=program['functions'][name];vt=fn['args'][1];st=e.types[vt]['variants'][0]['fields'][1]['type']
    length=z.BitVec(name+'_length',32)
    initial=z.Bool('initial') if name=='conjunction' else z.BitVec('initial',32)
    values=[z.Bool(f'v{i}') if name=='conjunction' else z.BitVec(f'v{i}',32) for i in range(capacity)]
    vector=e.sort(vt).constructor(0)(length,storage(st,values))
    result=e.sort(fn['result']);invalid=result.constructor(0)()
    expected_value=z.ZeroExt(3,initial) if name=='sum' else initial
    for i,value in enumerate(values):
        if name=='sum':expected_value=expected_value+z.If(z.ULT(i,length),z.ZeroExt(3,value),z.BitVecVal(0,35))
        elif name=='ordered':expected_value=z.If(z.ULT(i,length),expected_value*31+value,expected_value)
        else:expected_value=z.If(z.ULT(i,length),z.And(expected_value,value),expected_value)
    checks=[]
    for fuel in range(65):
        before=len(e.dead)
        actual=e.call(name,[z.BitVecVal(fuel,32),vector,initial],z.BoolVal(True))
        valid=z.And(length==fuel,z.ULE(length,capacity))
        if name=='sum':valid=z.And(valid,z.ULE(expected_value,0xffffffff))
        value=z.Extract(31,0,expected_value) if name=='sum' else expected_value
        expected=z.If(valid,result.constructor(1)(value),invalid)
        # Split on exact fuel/length agreement. This is an exhaustive partition;
        # substituting the equality branch avoids asking the bit-vector solver
        # to rediscover the same length fact through every constructor selector.
        accepted=result.recognizer(1)(actual)
        payload=result.accessor(1,0)(actual)
        mismatch=z.Or(accepted!=valid,z.And(valid,payload!=value))
        obligations=[z.And(length!=fuel,accepted),
            z.substitute(mismatch,(length,z.BitVecVal(fuel,32))),z.Or(*e.dead[before:])]
        statuses=[];counterexample=None
        partitions=[z.BoolVal(True)]
        if name=='sum' and fuel<=capacity:
            # Partition by the first overflowing prefix, plus no overflow.
            # These disjoint cases exhaust all payloads and expose the reducer
            # branch conditions before bit-vector arithmetic is solved.
            prefix=initial;safe=z.BoolVal(True);partitions=[]
            for item in values[:fuel]:
                next_value=prefix+item
                overflow=z.ULT(next_value,prefix)
                partitions.append(z.And(safe,overflow))
                safe=z.And(safe,z.Not(overflow));prefix=next_value
            partitions.append(safe)
        for oi,obligation in enumerate(obligations):
            for partition in partitions if oi==1 else [z.BoolVal(True)]:
                solver=z.Then('simplify','propagate-values','solve-eqs','elim-uncnstr','qfbv').solver();solver.set(timeout=10000)
                solver.add(z.simplify(obligation),partition)
                status=solver.check();statuses.append(status)
                if status==z.sat:
                    counterexample=str(solver.model())
                    if len(sys.argv)>2 and sys.argv[2]=='counterexample':
                        print(json.dumps({'claims':[{'name':name,'result':'failed','cases':[{'fuel':fuel,'result':'sat','counterexample':counterexample}]}]}))
                        sys.exit(1)
        status='sat' if z.sat in statuses else 'unknown' if z.unknown in statuses else 'unsat'
        checks.append({'fuel':fuel,'result':status,**({'counterexample':counterexample} if counterexample else {})})
    reports.append({'name':name,'result':'unsat' if all(c['result']=='unsat' for c in checks) else 'failed','cases':checks})
print(json.dumps({'claims':reports}))
sys.exit(0 if all(r['result']=='unsat' for r in reports) else 1)
