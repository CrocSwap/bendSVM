"""Compositional multiplication refinement over checked Bend runtime terms."""
import hashlib
import json
import sys
import z3 as z
from prove import Evaluator
from division_loop import obligation


def word(e,name,value):
    fields=e.types[name]['variants'][0]['fields']
    assert [f['name'] for f in fields]==['lo','hi']
    assert all(f['type']=='U32' for f in fields)
    return e.sort(name).constructor(0)(z.Extract(31,0,value),z.Extract(63,32,value))


def value(e,name,term):
    sort=e.sort(name)
    return z.Concat(sort.accessor(0,1)(term),sort.accessor(0,0)(term))


def wide_word(e,name,n):
    fields=e.types[name]['variants'][0]['fields']
    assert [f['name'] for f in fields]==['low','high']
    assert fields[0]['type']==fields[1]['type']
    w=fields[0]['type']
    return e.sort(name).constructor(0)(word(e,w,z.Extract(63,0,n)),word(e,w,z.Extract(127,64,n)))


def wide_value(e,name,term):
    fields=e.types[name]['variants'][0]['fields'];w=fields[0]['type'];s=e.sort(name)
    return z.Concat(value(e,w,s.accessor(0,1)(term)),value(e,w,s.accessor(0,0)(term)))


def checked(e,name,fails,expected):
    sort=e.sort(name);variants=e.types[name]['variants']
    ok=next(i for i,v in enumerate(variants) if v['name'].split('.')[-1]=='Ok')
    err=next(i for i,v in enumerate(variants) if v['name'].split('.')[-1]=='Err')
    return z.If(fails,sort.constructor(err)(z.BitVecVal(1,32)),
        sort.constructor(ok)(word(e,variants[ok]['fields'][0]['type'],expected)))


def claim(e,name,actual,expected,variables):
    return obligation(name,[],z.And(actual==expected,*[z.Not(p) for p in e.dead]),variables)


def limb_assembly(program,prefix='',only32=False):
    e=Evaluator(program);name=prefix+'mul32_parts';p=z.BitVecs('p0 p1 p2 p3',32)
    actual=e.call(name,list(p),z.BoolVal(True))
    expected=z.ZeroExt(32,p[0])+(z.ZeroExt(32,p[1])<<16)+(z.ZeroExt(32,p[2])<<16)+(z.ZeroExt(32,p[3])<<32)
    first=claim(e,name,value(e,program['functions'][name]['result'],actual),expected,p)
    if only32:return [first]
    e=Evaluator(program);name=prefix+'mul_parts';p=z.BitVecs('p0 p1 p2',64);high_bit=z.BitVec('high',1);high=high_bit==1
    signature=program['functions'][name]
    actual=e.call(name,[*[word(e,t,v) for t,v in zip(signature['args'],p)],high],z.BoolVal(True))
    total=z.ZeroExt(64,p[0])+(z.ZeroExt(64,p[1])<<32)+(z.ZeroExt(64,p[2])<<32)
    fails=z.Or(high,z.UGE(total,z.BitVecVal(1<<64,128)))
    second=claim(e,name,actual,checked(e,signature['result'],fails,z.Extract(63,0,total)),[*p,high_bit])
    return [first,second]


def routing(program,root,prefix=''):
    """Check limb selection with abstract partial products, after assembly proofs.

    Congruent uninterpreted products avoid asking a bit-blaster to rediscover
    distributivity of large multipliers. Integer lemmas below supply their
    product interpretation; operand bounds make primitive multiplication exact.
    """
    small=root==prefix+'mul32'
    bits=32 if small else 64
    a,b=z.BitVecs('a b',bits)
    partial=z.Function('partial_'+root,z.BitVecSort(bits//2),z.BitVecSort(bits//2),z.BitVecSort(bits))
    class Summary(Evaluator):
        def __init__(self,p):
            super().__init__(p);self.bounds=[];self.products=0;self.assemblies=0
        def call(self,fn,args,path):
            if fn==('U32.mul' if small else prefix+'mul32'):
                self.products+=1
                if small:
                    self.bounds.append(z.Implies(path,z.And(*[z.ULE(x,65535) for x in args])))
                    return partial(*[z.Extract(15,0,x) for x in args])
                return word(self,self.program['functions'][fn]['result'],partial(*args))
            assembly=prefix+'mul32_parts' if small else ('product_parts' if root=='product' else prefix+'mul_parts')
            if fn==assembly:
                self.assemblies+=1
                out=self.program['functions'][fn]['result']
                if small:
                    total=sum(z.ZeroExt(32,x)<<shift for x,shift in zip(args,[0,16,16,32]))
                    return word(self,out,total)
                p=[value(self,t,x) for t,x in zip(self.program['functions'][fn]['args'],args[:4 if root=='product' else 3])]
                total=sum(z.ZeroExt(64,x)<<shift for x,shift in zip(p,[0,32,32,64]))
                if root=='product':return wide_word(self,out,total)
                return checked(self,out,z.Or(args[3],z.UGE(total,z.BitVecVal(1<<64,128))),z.Extract(63,0,total))
            return super().call(fn,args,path)
    e=Summary(program);sig=program['functions'][root]
    args=[a,b] if small else [word(e,t,x) for t,x in zip(sig['args'],[a,b])]
    actual=e.call(root,args,z.BoolVal(True))
    half=bits//2
    al,ah=z.Extract(half-1,0,a),z.Extract(bits-1,half,a)
    bl,bh=z.Extract(half-1,0,b),z.Extract(bits-1,half,b)
    pairs=[(al,bl),(al,bh),(ah,bl),(ah,bh)]
    terms=[z.ZeroExt(bits,partial(x,y))<<shift for (x,y),shift in zip(pairs,[0,half,half,bits])]
    if small:expected=word(e,sig['result'],sum(terms))
    elif root=='product':expected=wide_word(e,sig['result'],sum(terms))
    else:
        total=sum(terms[:3])
        expected=checked(e,sig['result'],z.Or(z.And(ah!=0,bh!=0),z.UGE(total,z.BitVecVal(1<<64,128))),z.Extract(63,0,total))
    assert e.products==(3 if root==prefix+'mul' else 4),f'{root}: unexpected partial-product count'
    assert e.assemblies==1,f'{root}: expected one assembly'
    return obligation(root+'-routing',[],z.And(actual==expected,*e.bounds,*[z.Not(p) for p in e.dead]),[a,b])


def integer_products():
    reports=[]
    for bits in [16,32]:
        base=1<<bits;al,ah,bl,bh=z.Ints('al ah bl bh')
        bounds=[z.And(x>=0,x<base) for x in [al,ah,bl,bh]]
        p=[al*bl,al*bh,ah*bl,ah*bh]
        total=p[0]+base*(p[1]+p[2])+base*base*p[3]
        product=(al+base*ah)*(bl+base*bh)
        reports.append(obligation(f'limb-{bits}-expansion',[],z.simplify(total-product,som=True)==0))
        reports.append(obligation(f'limb-{bits}-bounds',bounds,
            z.And(*[z.And(x>=0,x<base*base) for x in p],product>=0,product<base**4)))
        if bits==32:
            low=p[0]+base*(p[1]+p[2])
            reports.append(obligation('checked-multiply-overflow',bounds,
                (product>=base*base)==z.Or(z.And(ah!=0,bh!=0),low>=base*base)))
    return reports


def wide_assembly(program):
    e=Evaluator(program);signature=program['functions']['add'];name=signature['result']
    a,b=z.BitVecs('a b',128)
    actual=e.call('add',[wide_word(e,name,a),wide_word(e,name,b)],z.BoolVal(True))
    first=claim(e,'wide-add',wide_value(e,name,actual),a+b,[a,b])
    if first['result']!='unsat':return [first]
    class Summary(Evaluator):
        def call(self,fn,args,path):
            if fn!='add':return super().call(fn,args,path)
            return wide_word(self,name,wide_value(self,name,args[0])+wide_value(self,name,args[1]))
    e=Summary(program);signature=program['functions']['product_parts'];p=z.BitVecs('p0 p1 p2 p3',64)
    actual=e.call('product_parts',[word(e,t,v) for t,v in zip(signature['args'],p)],z.BoolVal(True))
    expected=z.ZeroExt(64,p[0])+(z.ZeroExt(64,p[1])<<32)+(z.ZeroExt(64,p[2])<<32)+(z.ZeroExt(64,p[3])<<64)
    second=claim(e,'wide-product-parts',wide_value(e,name,actual),expected,p)
    return [first,second]


def prove(math_path,wide_path):
    math_raw=open(math_path,'rb').read();wide_raw=open(wide_path,'rb').read()
    math=json.loads(math_raw);wide=json.loads(wide_raw)
    reports=limb_assembly(math)+wide_assembly(wide)+limb_assembly(wide,'math.',only32=True)
    # No theorem summary may be used unless its checked implementation passed.
    if all(c['result']=='unsat' for c in reports):
        reports+=integer_products()
    if all(c['result']=='unsat' for c in reports):
        reports+=[routing(math,'mul32'),routing(wide,'math.mul32','math.')]
    if all(c['result']=='unsat' for c in reports):
        reports+=[routing(math,'mul'),routing(wide,'product','math.')]
    return {'solver':z.get_version_string(),'models':{'math':hashlib.sha256(math_raw).hexdigest(),
        'wide':hashlib.sha256(wide_raw).hexdigest()},'claims':reports}


if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(sys.argv[1],sys.argv[2]);print(json.dumps(report,indent=2))
    sys.exit(0 if all(c['result']=='unsat' for c in report['claims']) else 1)
