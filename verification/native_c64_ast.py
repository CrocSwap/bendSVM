"""Typed-Clang-AST model, unsigned scalar native leaf only."""
import hashlib,json,pathlib,subprocess
import z3 as z
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,msg):
 if not ok:raise ValueError(msg)
def kind(n,k):need(n['kind']==k,'expected '+k)
def width(n):
 t=n['type'].get('desugaredQualType',n['type']['qualType']);need(t in ['unsigned int','unsigned long long'],'unsupported scalar type '+t);return 32 if t=='unsigned int' else 64
def prove(ast,expected_name,pin=None):
 kind(ast,'FunctionDecl');need(ast['name']==expected_name,'function name')
 params=ast['inner'][:-1];need(len(params)==2 and all(p['kind']=='ParmVarDecl' and width(p)==32 for p in params),'parameters')
 a,b=z.BitVecs('a b',32);env={p['id']:v for p,v in zip(params,[a,b])}
 def expr(n):
  k=n['kind'];children=n.get('inner',[])
  if k=='DeclRefExpr':
   ref=n['referencedDecl'];need(ref['id'] in env,'unbound reference');v=env[ref['id']];need(width(n)==v.size(),'reference type');return v
  if k=='IntegerLiteral':
   need(n['type']['qualType']=='int' and 0<=int(n['value'])<2**31,'literal');return z.BitVecVal(int(n['value']),32)
  if k=='ParenExpr':need(len(children)==1,'paren');return expr(children[0])
  if k in ['ImplicitCastExpr','CStyleCastExpr']:
   need(len(children)==1,'cast arity');v=expr(children[0]);cast=n['castKind']
   if cast=='LValueToRValue':need(width(n)==v.size(),'load width');return v
   need(cast=='IntegralCast','unsupported cast '+cast);bits=width(n)
   return z.ZeroExt(bits-v.size(),v) if bits>v.size() else z.Extract(bits-1,0,v) if bits<v.size() else v
  if k=='BinaryOperator':
   need(len(children)==2,'binary arity');left,right=map(expr,children);op=n['opcode'];need(width(n)==left.size(),'result width')
   if op=='>>':
    need(children[1]['kind']=='IntegerLiteral','only constant shifts');count=int(children[1]['value']);need(0<=count<left.size(),'undefined shift');return z.LShR(left,count)
   need(left.size()==right.size() and op in ['*','+'],'binary operator/types');return left*right if op=='*' else left+right
  raise ValueError('unsupported expression '+k)
 body=ast['inner'][-1];kind(body,'CompoundStmt');returned=None;assertions=0
 for node in body['inner']:
  need(returned is None,'statement after return');k=node['kind']
  if k=='CStyleCastExpr':need(node['castKind']=='ToVoid','expression statement');expr(node['inner'][0]);continue
  if k=='DeclStmt':
   need(len(node['inner'])==1,'declaration arity');decl=node['inner'][0]
   if decl['kind']=='StaticAssertDecl':
    x=decl['inner'][0]
    while x['kind']=='ImplicitCastExpr':x=x['inner'][0]
    kind(x,'BinaryOperator');need(x['opcode']=='==','assertion relation');left,right=x['inner']
    kind(left,'UnaryExprOrTypeTraitExpr');need(left['name']=='sizeof' and left['argType']['qualType']=='unsigned long long','asserted type')
    while right['kind']=='ImplicitCastExpr':right=right['inner'][0]
    need(right['kind']=='IntegerLiteral' and right['value']=='8','asserted width');assertions+=1;continue
   kind(decl,'VarDecl');need(decl['id'] not in env and len(decl['inner'])==1,'variable declaration')
   value=expr(decl['inner'][0]);need(value.size()==width(decl),'initializer width');env[decl['id']]=value;continue
  kind(node,'ReturnStmt');need(len(node['inner'])==1,'return arity');call=node['inner'][0];kind(call,'CallExpr');need(len(call['inner'])==3,'maker arity')
  callee=call['inner'][0];kind(callee,'ImplicitCastExpr');need(callee['castKind']=='FunctionToPointerDecay','callee conversion');ref=callee['inner'][0];kind(ref,'DeclRefExpr')
  need(ref['referencedDecl']['name']==expected_name[:-len('mul32')]+'U64_make','return constructor')
  lo,hi=map(expr,call['inner'][1:]);need(lo.size()==hi.size()==32,'return fields');returned=z.Concat(hi,lo)
 need(assertions==1 and returned is not None,'body inventory')
 expected=z.ZeroExt(32,a)*z.ZeroExt(32,b);solver=z.Solver();solver.set(timeout=30000);solver.add(returned!=expected)
 if pin is not None:solver.add(a==pin[0],b==pin[1])
 result=solver.check();need(result!=z.unknown,'UNKNOWN: '+solver.reason_unknown());row={'result':str(result)}
 if result==z.sat:
  m=solver.model();row['witness']={k:m.eval(v,model_completion=True).as_long() for k,v in [('a',a),('b',b),('actual',returned),('expected',expected)]}
 return row
