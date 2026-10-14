"""Restricted whole-function source/C equivalence for an acyclic pure subset.
Trusted: checked-source exporter/primitive semantics, C subset parser/interpreter,
Z3, standard unsigned-32/struct value semantics. No loops, pointers, memory ABI,
Clang or SBF proof. Maker summaries require the separate actual-C/layout checks.
"""
import sys,re,json,pathlib,hashlib
import z3 as z
sys.path.insert(0,'verification')
from prove import Evaluator
from adapter_contract_c import Parser, strict_tokens
from tagged_sum_c import check_artifacts, lexical_subset
from tagged_sum_layout import check_layouts
from tagged_sum_rendering import function_bodies


def need(ok,reason):
    if not ok:raise ValueError(reason)


class CParser(Parser):
    LEVELS=[('||',),('&&',),('|',),('^',),('&',),('==','!='),('<','>','<=','>='),('<<','>>'),('+','-'),('*',)]
    def unary(self):
        if self.peek()=='~':
            self.take('~');return ('complement',self.unary())
        if self.peek()=='(' and self.peek(1)=='bend_u32' and self.peek(2)==')':
            self.take('(','bend_u32',')');return ('unsigned32',self.unary())
        return super().unary()
    def statement(self):
        if self.peek()=='(' and self.peek(1)=='void' and self.peek(2)==')':
            self.take('(','void',')');value=self.expr();self.take(';');return ('discard',value)
        need(self.peek()!='for','loop outside acyclic semantics subset')
        return super().statement()


class Source(Evaluator):
    @staticmethod
    def primitive(name,args):
        if name=='U32.not':return ~args[0]
        return Evaluator.primitive(name,args)


def mangle(name):
    need(name.isascii(),'non-ASCII function naming outside subset')
    return 'bend_'+''.join(c if c.isalnum() else '_'+format(ord(c),'x')+'_' for c in name)


def translation_unit(c, expected_functions, aggregate_types):
    """Consume every top-level token, excluding unmodeled declarations/attributes.

    Layout/maker checks still validate the interiors of their declarations.
    Whole-function evaluation validates called function bodies separately.
    """
    remaining=c;seen=set();assertions=set()
    while remaining.strip():
        remaining=remaining.lstrip()
        scalar=re.match(r'typedef unsigned int bend_u32\s*;',remaining)
        assertion=re.match(r'_Static_assert\s*\(\s*sizeof\s*\(\s*(\w+)\s*\)\s*(==\s*4|<=\s*1536)\s*,\s*\)\s*;',remaining)
        if assertion:
            name,relation=assertion[1],re.sub(r'\s+','',assertion[2])
            need(name not in assertions and ((name=='bend_u32' and relation=='==4') or (name in aggregate_types and relation=='<=1536')),'unsupported translation-unit assertion')
            assertions.add(name)
        simple=scalar or assertion
        if simple:remaining=remaining[simple.end():];continue
        declaration=re.match(r'typedef\s+struct\s*\{',remaining)
        function=re.match(r'static (?:inline|__attribute__\(\(noinline\)\)) \w+ (\w+)\([^()]*\) \{',remaining)
        need(declaration or function,'unsupported translation-unit tokens: '+remaining[:80])
        match=declaration or function;depth=1;end=match.end()
        while end<len(remaining) and depth:
            if remaining[end]=='{':depth+=1
            elif remaining[end]=='}':depth-=1
            end+=1
        need(depth==0,'unterminated translation-unit block')
        if declaration:
            tail=re.match(r'\s*\w+\s*;',remaining[end:]);need(tail is not None,'unsupported type declaration tail');end+=tail.end()
        else:
            need(function[1] in expected_functions and function[1] not in seen,'unexpected/duplicate function definition')
            seen.add(function[1])
        remaining=remaining[end:]
    need(seen==expected_functions,'incomplete function definition inventory')
    need(assertions==aggregate_types|{'bend_u32'},'incomplete assertion inventory')


def unsigned(value):
    if z.is_bool(value):return z.If(value,z.BitVecVal(1,32),z.BitVecVal(0,32))
    need(z.is_bv(value) and value.size()==32,'non-scalar C arithmetic')
    return value


def truth(value):return value if z.is_bool(value) else unsigned(value)!=0


class C:
    parser_class=CParser
    def __init__(self,source,artifact):
        self.source=source;self.types=source.types;self.c=lexical_subset(artifact['c'])
        self.bodies=function_bodies(self.c);self.parsed={};self.active=[];self.bad=[]
        self.functions={mangle(name):name for name in source.program['functions']}
        need(len(self.functions)==len(source.program['functions']),'mangled name collision')
        self.makers={v['cMaker']:(t['name'],i) for t in self.types.values() if t['kind']=='adt' for i,v in enumerate(t['variants'])}
        need(not (set(self.functions)&set(self.makers)),'function/maker symbol collision')
        translation_unit(self.c,set(self.functions)|set(self.makers),{t['cType'] for t in self.types.values() if t['kind']=='adt'})
    def coerce(self,value,type_,path):
        if type_=='Bool':
            if z.is_bool(value):return value
            v=unsigned(value);self.bad.append(z.And(path,z.Not(z.Or(v==0,v==1))));return v!=0
        if self.types[type_]['kind']=='u32':return unsigned(value)
        need(value.sort()==self.source.sort(type_),'C aggregate type mismatch');return value
    def aggregate(self,value):
        for name,t in self.types.items():
            if t['kind']=='adt' and value.sort()==self.source.sort(name):return name,self.source.sort(name)
        raise ValueError('member access on scalar')
    def expr(self,node,env,path):
        kind=node[0]
        if kind=='id':need(node[1] in env,'unbound C variable');return env[node[1]]
        if kind=='num':need(node[2]=='u32' and 0<=node[1]<2**32,'unsupported literal');return z.BitVecVal(node[1],32)
        if kind=='unsigned32':return unsigned(self.expr(node[1],env,path))
        if kind=='complement':
            value=self.expr(node[1],env,path);need(z.is_bv(value),'signed complement outside subset');return ~unsigned(value)
        if kind=='not':return z.Not(truth(self.expr(node[1],env,path)))
        if kind=='member':
            if node[2]=='tag':
                v=self.expr(node[1],env,path);name,sort=self.aggregate(v)
                result=z.BitVecVal(len(self.types[name]['variants'])-1,32)
                for i in reversed(range(len(self.types[name]['variants'])-1)):
                    result=z.If(sort.recognizer(i)(v),z.BitVecVal(i,32),result)
                return result
            base=node[1]
            need(re.fullmatch(r'f[0-9]+',node[2]) and base[0]=='member' and re.fullmatch(r'c[0-9]+',base[2])
                 and base[1][0]=='member' and base[1][2]=='as','unsupported projection')
            v=self.expr(base[1][1],env,path);name,sort=self.aggregate(v)
            tag=int(base[2][1:]);field=int(node[2][1:])
            need(tag<len(self.types[name]['variants']) and field<sort.constructor(tag).arity(),'projection range')
            self.bad.append(z.And(path,z.Not(sort.recognizer(tag)(v))))
            return sort.accessor(tag,field)(v)
        if kind in ('land','lor'):
            a=truth(self.expr(node[1],env,path));guard=a if kind=='land' else z.Not(a)
            b=truth(self.expr(node[2],env,z.And(path,guard)))
            return z.And(a,b) if kind=='land' else z.Or(a,b)
        if kind=='bin':
            op=node[1];left=self.expr(node[2],env,path);right=self.expr(node[3],env,path)
            if op in ('<<','>>'):need(z.is_bv(left),'signed shift outside subset')
            if op in ('+','-','*','&','|','^'):need(z.is_bv(left) or z.is_bv(right),'signed arithmetic outside subset')
            a,b=unsigned(left),unsigned(right)
            if op in ('<<','>>'):self.bad.append(z.And(path,z.UGE(b,32)))
            operations={'+':lambda:a+b,'-':lambda:a-b,'*':lambda:a*b,'&':lambda:a&b,'|':lambda:a|b,'^':lambda:a^b,
              '==':lambda:a==b,'!=':lambda:a!=b,'<':lambda:z.ULT(a,b),'>':lambda:z.UGT(a,b),'<=':lambda:z.ULE(a,b),'>=':lambda:z.UGE(a,b),
              '<<':lambda:a<<b,'>>':lambda:z.LShR(a,b)}
            need(op in operations,'unsupported operator');return operations[op]()
        if kind=='cond':
            condition=truth(self.expr(node[1],env,path))
            yes=self.expr(node[2],env,z.And(path,condition));no=self.expr(node[3],env,z.And(path,z.Not(condition)))
            if yes.sort()!=no.sort():yes,no=unsigned(yes),unsigned(no)
            return z.If(condition,yes,no)
        if kind=='call':
            need(node[1] not in env,'call target hidden by local variable')
            return self.call(node[1],[self.expr(n,env,path) for n in node[2]],path)
        raise ValueError('unsupported expression '+kind)
    def call(self,name,args,path):
        if name in self.makers:
            type_,i=self.makers[name];v=self.types[type_]['variants'][i]
            need(len(args)==len(v['fields']),'maker arity')
            return self.source.sort(type_).constructor(i)(*[self.coerce(a,f['type'],path) for a,f in zip(args,v['fields'])])
        need(name in self.functions,'unmodeled C call '+name)
        need(name not in self.active,'recursive C call outside subset')
        f=self.source.program['functions'][self.functions[name]];need(len(args)==len(f['args']),'call arity')
        if name not in self.parsed:
            pat=r'^static (?:inline|__attribute__\(\(noinline\)\)) (\w+) '+re.escape(name)+r'\(([^()]*)\) \{'
            matches=list(re.finditer(pat,self.c,re.MULTILINE));need(len(matches)==1,'missing/duplicate definition')
            signature=matches[0];need(signature[1]==self.types[f['result']]['cType'],'return C type')
            params=signature[2]
            expected=', '.join(self.types[t]['cType']+' a'+str(i) for i,t in enumerate(f['args'])) or 'void'
            need(params==expected,'parameter C types/order')
            parser=self.parser_class(strict_tokens('{'+self.bodies[name]+'}'),[t['cType'] for t in self.types.values()])
            self.parsed[name]=parser.statement();need(parser.at==len(parser.t),'trailing body tokens')
        self.active.append(name)
        try:
            env={'a'+str(i):self.coerce(a,t,path) for i,(a,t) in enumerate(zip(args,f['args']))}
            pending,returns=self.exec(self.parsed[name],[(path,env)],f['result'])
            self.bad.extend(p for p,_ in pending)
            result=self.source.default(f['result'])
            for guard,value in reversed(returns):result=z.If(guard,value,result)
            return result
        finally:self.active.pop()
    def exec(self,node,states,result_type):
        kind=node[0];pending=[];returns=[]
        if kind=='block':
            # Locals expire at block exit; updates to outer bindings survive.
            # Process each incoming environment separately to retain its scope.
            for initial_path,initial_env in states:
                inner_states=[(initial_path,dict(initial_env))]
                for statement in node[1]:
                    inner_states,new=self.exec(statement,inner_states,result_type);returns.extend(new)
                for end_path,end_env in inner_states:
                    restored={key:end_env[key] for key in initial_env}
                    if '$const' in restored:restored['$const']=initial_env['$const']
                    pending.append((end_path,restored))
            return pending,returns
        for path,env in states:
            if z.is_false(z.simplify(path)):continue
            if kind=='return':returns.append((path,self.coerce(self.expr(node[1],env,path),result_type,path)))
            elif kind=='discard':self.expr(node[1],env,path);pending.append((path,env))
            elif kind=='expr':
                need(node[1]==('call','__builtin_unreachable',[]),'unsupported expression statement')
                self.bad.append(path)
            elif kind=='decl':
                _,ctype,const,pointer,name,size,init=node
                need(name not in self.functions and name not in self.makers and name not in {t['cType'] for t in self.types.values()} and name!='__builtin_unreachable','local hides function or type name')
                need(not pointer and size is None and init and init[0]=='expr' and name not in env,'unsupported declaration/shadowing')
                value=self.expr(init[1],env,path)
                # In this subset scalar declarations are bend_u32; aggregate
                # type names have a unique schema entry.
                matching=[t for t in self.types.values() if t['cType']==ctype]
                need(matching,'unknown declaration C type')
                type_='U32' if ctype=='bend_u32' else matching[0]['name']
                inner=dict(env);inner[name]=self.coerce(value,type_,path)
                if const:inner['$const']=env.get('$const',frozenset())|{name}
                pending.append((path,inner))
            elif kind=='assign':
                need(node[1] in env,'assignment to unbound variable')
                need(node[1] not in env.get('$const',()),'assignment to const variable')
                value=self.expr(node[2],env,path);old=env[node[1]]
                if z.is_bv(old):value=unsigned(value)
                need(value.sort()==old.sort(),'assignment sort mismatch')
                inner=dict(env);inner[node[1]]=value;pending.append((path,inner))
            elif kind=='if':
                cond=truth(self.expr(node[1],env,path))
                for branch,guard in [(node[2],cond),(node[3],z.Not(cond))]:
                    branch_states=[(z.And(path,guard),dict(env))]
                    if branch is None:pending.extend(branch_states)
                    else:
                        rest,values=self.exec(branch,branch_states,result_type);pending.extend(rest);returns.extend(values)
            else:raise ValueError('unsupported statement '+kind)
        return pending,returns


def wire(source,type_,value):
    t=source.types[type_]
    if t['kind']=='u32':return value.as_long()
    if t['kind']=='bool':return z.is_true(value)
    variant=next(v for v in t['variants'] if v['name']==str(value.decl().name()))
    return {'constructor':variant['name'],'fields':{f['name']:wire(source,f['type'],value.arg(i)) for i,f in enumerate(variant['fields'])}}


def check(program):
    source=Source(program['source']);artifact=program['artifact']
    need(program['source']['schema']==artifact['schema'],'source and C schema mismatch')
    check_artifacts([artifact]);check_layouts([artifact])
    results=[]
    for name in program['source']['roots']:
        source.dead=[];c=C(source,artifact);f=program['source']['functions'][name]
        args=[z.Const('argument_'+str(i),source.sort(t)) for i,t in enumerate(f['args'])]
        expected=source.call(name,args,z.BoolVal(True));actual=c.call(mangle(name),args,z.BoolVal(True))
        solver=z.Solver();solver.set(timeout=10000);solver.add(z.Or(actual!=expected,*source.dead,*c.bad))
        status=solver.check();need(status!=z.unknown,'UNKNOWN is not proof: '+solver.reason_unknown())
        row={'function':name,'result':str(status),'CGuardObligations':len(c.bad),'sourceDeadPaths':len(source.dead)}
        if status==z.sat:
            row['counterexample']={str(a):str(solver.model().eval(a,model_completion=True)) for a in args}
            row['wireArgs']=[wire(source,t,solver.model().eval(a,model_completion=True)) for a,t in zip(args,f['args'])]
        results.append(row)
    return results

