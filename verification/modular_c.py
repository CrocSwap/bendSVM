"""Compositional equivalence for complete checked acyclic source/C closures.

Callees receive shared uninterpreted summaries only after their own universal
source/C equivalence and safety query passes. A dependency-order induction then
covers requested roots. An optional native leaf requires the bound source
refinement and exact reviewed emitted-C template certificate. A SAT summary model is not necessarily a concrete
whole-program counterexample; concrete replay is separate evidence.

Trusted: checked-source exporter, schema, interpreters, driver and Z3.
Excluded: pointer/memory ABI, recursive or looping C, Clang and SBF preservation.
"""
import sys,json,pathlib,hashlib,time
import z3 as z
from acyclic_c import Source, C as BaseC, CParser, mangle, need, wire, check_artifacts, check_layouts, unsigned

class DivisionParser(CParser):
    LEVELS=CParser.LEVELS[:-1]+[('*','/')]

class C(BaseC):
    parser_class=DivisionParser
    def expr(self,node,env,path):
        if node[0]=='bin' and node[1]=='/':
            left=self.expr(node[2],env,path);right=self.expr(node[3],env,path)
            need(z.is_bv(left) or z.is_bv(right),'signed arithmetic outside subset')
            a,b=unsigned(left),unsigned(right)
            self.bad.append(z.And(path,b==0))
            return z.UDiv(a,b)
        return super().expr(node,env,path)


def refs(t):
    if isinstance(t,dict):
        if t.get('$')=='Ref':yield t['k']
        for value in t.values():yield from refs(value)
    elif isinstance(t,list):
        for value in t:yield from refs(value)

def check(program,native_inputs=None):
    certificates={}
    if native_inputs is None:
        need(program['defaultProductionCMatches'] is True,'not default production C')
    else:
        from native_mul32 import certify
        fields=set(native_inputs)
        need(fields in ({'sourceProof','canonicalModelBytes'},
            {'sourceProof','canonicalModelBytes','divisionProof','divisionModelBytes'}),'native input fields')
        certificate=certify(program,native_inputs['sourceProof'],native_inputs['canonicalModelBytes'])
        certificates[certificate['sourceFunction']]=certificate
        if 'divisionProof' in native_inputs:
            from native_divmod import certify as certify_divmod
            division=certify_divmod(program,native_inputs['divisionProof'],native_inputs['divisionModelBytes'])
            need(division['sourceFunction'] not in certificates,'duplicate native certificate')
            certificates[division['sourceFunction']]=division
    source=Source(program['source']);artifact=program['artifact']
    need(program['source']['schema']==artifact['schema'],'schema mismatch')
    check_artifacts([artifact]);check_layouts([artifact])
    functions=source.program['functions'];done=set();active=set();order=[];dependencies={}
    def visit(name):
        need(name in functions,'unknown source call');need(name not in active,'recursive source closure')
        if name in done:return
        active.add(name);dependencies[name]=[] if name in certificates else sorted(set(refs(functions[name].get('body'))))
        for child in dependencies[name]:visit(child)
        active.remove(name);done.add(name);order.append(name)
    for root in source.program['roots']:visit(root)
    elided=set(functions)-set(order)
    allowed=set().union(*(set(c['sourceClosure'])-{n} for n,c in certificates.items()))
    need(elided<=allowed,'unreachable function inventory')
    source_program={**program['source'],'functions':{name:functions[name] for name in order}}
    proven={};claims=[]
    class ModularSource(Source):
        def call(self,name,args,path):
            need(name in proven,'unproved source callee '+name)
            return proven[name](*args)
    class ModularC(C):
        def call(self,name,args,path):
            if name in self.makers:return super().call(name,args,path)
            need(name in self.functions,'unknown C function '+name)
            target=self.functions[name];need(target in proven,'unproved C callee '+target)
            f=functions[target];need(len(args)==len(f['args']),'summary arity')
            return proven[target](*[self.coerce(a,t,path) for a,t in zip(args,f['args'])])
    for name in order:
        src=ModularSource(source_program);c=ModularC(src,artifact);f=functions[name]
        if name in certificates:
            claims.append({'function':name,'result':'certified-native','certificate':certificates[name]})
            proven[name]=z.Function('proved_'+mangle(name),*[src.sort(t) for t in f['args']],src.sort(f['result']))
            continue
        args=[z.Const('argument_'+str(i),src.sort(t)) for i,t in enumerate(f['args'])]
        expected=Source.call(src,name,args,z.BoolVal(True))
        actual=C.call(c,mangle(name),args,z.BoolVal(True))
        solver=z.Solver();solver.set(timeout=10000);solver.add(z.Or(actual!=expected,*src.dead,*c.bad))
        began=time.monotonic();status=solver.check()
        row={'function':name,'result':str(status),'dependencies':dependencies[name],'CGuardObligations':len(c.bad),'sourceDeadPaths':len(src.dead),'seconds':time.monotonic()-began}
        if status==z.sat:
            row['wireArgs']=[wire(src,t,solver.model().eval(a,model_completion=True)) for a,t in zip(args,f['args'])]
        if status==z.unknown:row['reason']=solver.reason_unknown()
        claims.append(row);print(name+': '+str(status),flush=True)
        if status!=z.unsat:return {'passed':False,'claims':claims}
        proven[name]=z.Function('proved_'+mangle(name),*[src.sort(t) for t in f['args']],src.sort(f['result']))
    result={'passed':True,'claims':claims,'roots':source.program['roots']}
    if native_inputs is not None:result['elidedSourceFunctions']=sorted(elided)
    return result

