"""Universal bounded-integer refinement from exported checked Bend terms.

Trusted: Bend checker/model exporter, this evaluator, pinned Base primitive
specifications, and Z3. This does not prove the C/LLVM/SBF lowering correct.
"""
import hashlib
import json
import sys
import time
import z3 as z


class Evaluator:
    def __init__(self, program):
        self.program = program
        self.types = {t['name']: t for t in program['schema']['types']}
        self.sorts = {'U32': z.BitVecSort(32), 'Bool': z.BoolSort()}
        self.constructors = {}
        self.dead = []
        self.depth = {}
        for name in self.types:
            self.sort(name)

    def sort(self, name):
        if name in self.sorts:
            return self.sorts[name]
        t = self.types[name]
        if t['kind'] == 'u32':
            self.sorts[name] = z.BitVecSort(32)
            return self.sorts[name]
        assert t['kind'] == 'adt'
        data = z.Datatype(name)
        for variant in t['variants']:
            data.declare(variant['name'], *[(f"{variant['name']}.{i}", self.sort(field['type']))
                for i, field in enumerate(variant['fields'])])
        sort = data.create()
        self.sorts[name] = sort
        for i, variant in enumerate(t['variants']):
            self.constructors[variant['name']] = (sort, i)
        return sort

    def default(self, name):
        if self.types[name]['kind'] == 'u32': return z.BitVecVal(0, 32)
        if name == 'Bool': return z.BoolVal(False)
        fields = self.types[name]['variants'][0]['fields']
        return self.sort(name).constructor(0)(*[self.default(f['type']) for f in fields])

    @staticmethod
    def primitive(name, args):
        a = args[0]
        b = args[1] if len(args) == 2 else None
        one, zero = z.BitVecVal(1, 32), z.BitVecVal(0, 32)
        operations = {
            'U32.add': lambda: a+b, 'U32.sub': lambda: a-b,
            'U32.mul': lambda: a*b, 'U32.and': lambda: a&b,
            'U32.div': lambda: z.If(b==zero,zero,z.UDiv(a,b)),
            'U32.is_lt': lambda: z.ULT(a,b), 'U32.is_eq': lambda: a==b,
            'U32.is_ge': lambda: z.UGE(a,b), 'U32.is_zero': lambda: a==zero,
            'U32.or': lambda: a|b, 'U32.shl': lambda: a<<1,
            'Bool.to_u32': lambda: z.If(a,one,zero),
            'Bool.and': lambda: z.And(a,b), 'Bool.or': lambda: z.Or(a,b),
            'Bool.not': lambda: z.Not(a),
        }
        if name not in operations: raise ValueError(f'Unmodeled primitive: {name}')
        return operations[name]()

    def call(self, name, args, path):
        f = self.program['functions'][name]
        assert len(args) == len(f['args'])
        if f['primitive']: return self.primitive(name,args)
        depth = self.depth.get(name, 0)
        if depth > 64:
            self.dead.append(path)
            return self.default(f['result'])
        self.depth[name] = depth + 1
        try:
            return self.body(f['body'],args,{},f['result'],path)
        finally:
            self.depth[name] = depth

    def expression(self, t, env, path):
        kind=t['$']
        if kind=='Var': return env[t['i']]
        if kind in ['U32','Nat']: return z.BitVecVal(t['value'],32)
        if kind=='Ctr':
            if t['k'] in ['Zero','Succ']:
                condition=args[0]==0 if t['k']=='Zero' else args[0]!=0
                fields=[] if t['k']=='Zero' else [args[0]-1]
            elif t['k'] in ['True','False']: return z.BoolVal(t['k']=='True')
            sort,i=self.constructors[t['k']]
            return sort.constructor(i)(*[self.expression(x,env,path) for x in t['x']])
        if kind in ['App','Ref']:
            args=[]
            while t['$']=='App':
                args.insert(0,self.expression(t['x'],env,path));t=t['f']
            assert t['$']=='Ref'
            return self.call(t['k'],args,path)
        if kind=='Let':
            values=[self.expression(v,env,path) for v in t['v']]
            inner=dict(env);inner.update(zip(t['i'],values))
            return self.expression(t['f'],inner,path)
        raise ValueError(f'Unsupported expression: {kind}')

    def body(self,t,args,env,result,path):
        kind=t['$']
        if kind=='Lam':
            assert args
            inner=dict(env);inner[t['i']]=args[0]
            return self.body(t['f'],args[1:],inner,result,path)
        if kind=='Mat':
            assert args
            if t['k'] in ['Zero','Succ']:
                condition=args[0]==0 if t['k']=='Zero' else args[0]!=0
                fields=[] if t['k']=='Zero' else [args[0]-1]
            elif t['k'] in ['True','False']:
                condition=args[0] if t['k']=='True' else z.Not(args[0]);fields=[]
            else:
                sort,i=self.constructors[t['k']]
                condition=sort.recognizer(i)(args[0])
                fields=[sort.accessor(i,j)(args[0]) for j in range(sort.constructor(i).arity())]
            simplified=z.simplify(condition)
            if z.is_true(simplified): return self.body(t['h'],fields+args[1:],env,result,path)
            if z.is_false(simplified): return self.body(t['m'],args,env,result,path)
            yes=self.body(t['h'],fields+args[1:],env,result,z.And(path,condition))
            no=self.body(t['m'],args,env,result,z.And(path,z.Not(condition)))
            return z.If(condition,yes,no)
        if kind=='Efq':
            self.dead.append(path)
            return self.default(result)
        if args:
            assert kind=='Ref'
            return self.call(t['k'],args,path)
        return self.expression(t,env,path)


def prove(filename):
    raw=open(filename,'rb').read();program=json.loads(raw)
    assert program['version']==1
    evaluator=Evaluator(program)
    first=program['functions'][program['roots'][0]]
    u64=first['args'][0];sort=evaluator.sort(u64)
    assert [f['type'] for f in evaluator.types[u64]['variants'][0]['fields']]==['U32','U32']
    a,b=z.BitVecs('a b',64)
    arg=lambda n:sort.constructor(0)(z.Extract(31,0,n),z.Extract(63,32,n))
    value=lambda n:z.Concat(sort.accessor(0,1)(n),sort.accessor(0,0)(n))
    reports=[]
    for name in program['roots']:
        evaluator.dead=[]
        actual=evaluator.call(name,[arg(a),arg(b)],z.BoolVal(True))
        if name in ['less','equal']:
            correct=actual==(z.ULT(a,b) if name=='less' else a==b)
        else:
            checked=evaluator.sort(program['functions'][name]['result'])
            t=evaluator.types[program['functions'][name]['result']]
            ok=next(i for i,v in enumerate(t['variants']) if v['name'].split('.')[-1]=='Ok')
            err=next(i for i,v in enumerate(t['variants']) if v['name'].split('.')[-1]=='Err')
            if name=='add':
                mathematical=z.ZeroExt(1,a)+z.ZeroExt(1,b)
                fails=z.Extract(64,64,mathematical)==1
                expected=z.Extract(63,0,mathematical);code=1
            elif name=='sub':
                fails=z.ULT(a,b);expected=a-b;code=2
            else: raise ValueError(f'No refinement specification: {name}')
            correct=z.If(fails,z.And(checked.recognizer(err)(actual),checked.accessor(err,0)(actual)==code),
                z.And(checked.recognizer(ok)(actual),value(checked.accessor(ok,0)(actual))==expected))
        violation=z.Or(z.Not(correct),*evaluator.dead)
        solver=z.Solver();solver.set(timeout=30_000);solver.add(violation)
        start=time.monotonic();status=solver.check()
        report={'function':name,'result':str(status),'seconds':round(time.monotonic()-start,3)}
        if status==z.sat:
            model=solver.model();report['counterexample']={str(n):str(model.eval(n,model_completion=True).as_long()) for n in [a,b]}
        if status==z.unknown: report['reason']=solver.reason_unknown()
        reports.append(report)
    return {'solver':z.get_version_string(),'modelSha256':hashlib.sha256(raw).hexdigest(),'claims':reports}


if __name__=='__main__':
    if z.get_version_string()!='5.1.0': raise RuntimeError('This verification run requires Z3 5.1.0')
    report=prove(sys.argv[1]);print(json.dumps(report,indent=2))
    sys.exit(0 if all(c['result']=='unsat' for c in report['claims']) else 1)
