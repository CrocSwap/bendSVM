"""Restricted unsigned SBF-Clang AST semantics for the native divmod body.

Parameters are valid generated U64 records. Constructor bodies/layouts are
separately checked by the handler gate. Clang's AST and this interpreter remain
trusted; unsupported statements/types fail closed.
"""
import z3 as z
from native_c64_ast import need,kind,width

def prove(ast,symbol,pin=None):
 kind(ast,'FunctionDecl');need(ast['name']==symbol and symbol.endswith('divmod'),'function identity')
 prefix=symbol[:-6];u64=prefix+'U64_t';result_type=prefix+'DivResult_t'
 need(ast['type']['qualType']==f'{result_type} ({u64}, {u64})','function signature')
 nodes=ast.get('inner',[]);need(len(nodes)==3,'function inventory');params=nodes[:2]
 need(all(p['kind']=='ParmVarDecl' and p['type']['qualType']==u64 for p in params),'parameter types')
 a,b=z.BitVecs('dividend divisor',64)
 def record(x):return {'tag':z.BitVecVal(0,32),'as':{'c0':{'f0':z.Extract(31,0,x),'f1':z.Extract(63,32,x)}}}
 env={p['id']:record(x) for p,x in zip(params,[a,b])};types={p['id']:u64 for p in params};bad=[];returns=[];assertions=0;ops=[]
 def truth(x):
  if z.is_bool(x):return x
  need(z.is_bv(x),'condition type');return x!=0
 def callee(node,conversion='FunctionToPointerDecay'):
  kind(node,'CallExpr');items=node.get('inner',[]);need(bool(items),'call inventory');c=items[0];kind(c,'ImplicitCastExpr');need(c['castKind']==conversion and len(c.get('inner',[]))==1,'callee conversion')
  ref=c['inner'][0];kind(ref,'DeclRefExpr');need(ref['referencedDecl']['kind']=='FunctionDecl','callee kind');return ref['referencedDecl']['name'],items[1:]
 def expr(n,path):
  k=n['kind'];items=n.get('inner',[])
  if k=='DeclRefExpr':
   ref=n['referencedDecl'];need(ref['id'] in env,'unbound reference');need(n['type']['qualType']==types[ref['id']],'reference type');return env[ref['id']]
  if k=='MemberExpr':
   need(len(items)==1 and not n.get('isArrow',False),'member access');base=expr(items[0],path)
   need(isinstance(base,dict) and n['name'] in base,'unknown member');v=base[n['name']]
   if z.is_bv(v):need(width(n)==v.size(),'member width')
   return v
  if k=='IntegerLiteral':
   t=n['type']['qualType'];v=int(n['value']);need(t in ['int','unsigned int'] and 0<=v<(2**31 if t=='int' else 2**32),'literal type/range');return z.BitVecVal(v,32)
  if k=='ParenExpr':need(len(items)==1,'paren');return expr(items[0],path)
  if k in ['ImplicitCastExpr','CStyleCastExpr']:
   need(len(items)==1,'cast arity');v=expr(items[0],path);cast=n['castKind']
   if cast=='LValueToRValue':
    if isinstance(v,dict):need(n['type']['qualType']==u64,'record load type')
    else:need(z.is_bv(v) and width(n)==v.size(),'scalar load type')
    return v
   need(cast=='IntegralCast' and z.is_bv(v),'unsupported cast');bits=width(n)
   return z.ZeroExt(bits-v.size(),v) if bits>v.size() else z.Extract(bits-1,0,v) if bits<v.size() else v
  if k=='UnaryOperator':
   need(n['opcode']=='!' and len(items)==1 and n['type']['qualType']=='int','unary operator');return z.Not(truth(expr(items[0],path)))
  if k=='BinaryOperator':
   need(len(items)==2,'binary arity');op=n['opcode'];left=expr(items[0],path)
   right=expr(items[1],z.And(path,z.Not(truth(left))) if op=='||' else path)
   if op=='||':need(n['type']['qualType']=='int','logical result');return z.Or(truth(left),truth(right))
   need(z.is_bv(left) and z.is_bv(right),'binary operands')
   if op in ['!=','==']:
    need(left.size()==right.size() and n['type']['qualType']=='int','comparison types');return left!=right if op=='!=' else left==right
   need(width(n)==left.size(),'operator result width')
   if op in ['<<','>>']:
    need(items[1]['kind']=='IntegerLiteral','constant shift required');count=int(items[1]['value']);need(0<=count<left.size(),'undefined shift');return left<<count if op=='<<' else z.LShR(left,count)
   need(left.size()==right.size() and op in ['|','/','%','*','+'],'unsigned operator/types');ops.append(op)
   if op in ['/','%']:bad.append(z.And(path,right==0));return z.UDiv(left,right) if op=='/' else z.URem(left,right)
   return left|right if op=='|' else left*right if op=='*' else left+right
  if k=='CallExpr':
   name,args=callee(n);vs=[expr(c,path) for c in args]
   if name==prefix+'U64_make':
    need(len(vs)==2 and all(z.is_bv(v) and v.size()==32 for v in vs) and n['type']['qualType']==u64,'word constructor');return ('word',z.Concat(vs[1],vs[0]))
   if name==prefix+'Division_make':
    need(len(vs)==2 and all(isinstance(v,tuple) and v[0]=='word' for v in vs) and n['type']['qualType']==prefix+'Division_t','division constructor');return ('division',vs[0][1],vs[1][1])
   if name==prefix+'DivOk_make':
    need(len(vs)==1 and isinstance(vs[0],tuple) and vs[0][0]=='division' and n['type']['qualType']==result_type,'success constructor');return ('ok',*vs[0][1:])
   need(name==prefix+'DivErr_make' and len(vs)==1 and z.is_bv(vs[0]) and vs[0].size()==32 and n['type']['qualType']==result_type,'error constructor');return ('error',vs[0])
  raise ValueError('unsupported expression '+k)
 def statement(n,path):
  nonlocal assertions
  k=n['kind'];items=n.get('inner',[])
  if k=='CompoundStmt':
   for child in items:path=statement(child,path)
   return path
  if k=='CStyleCastExpr':need(n['castKind']=='ToVoid' and len(items)==1,'void expression');expr(items[0],path);return path
  if k=='DeclStmt':
   need(len(items)==1,'declaration inventory');decl=items[0]
   if decl['kind']=='StaticAssertDecl':
    x=decl['inner'][0]
    while x['kind']=='ImplicitCastExpr':need(len(x['inner'])==1,'assert cast');x=x['inner'][0]
    kind(x,'BinaryOperator');need(x['opcode']=='==' and len(x['inner'])==2,'assert relation');left,right=x['inner'];kind(left,'UnaryExprOrTypeTraitExpr');need(left['name']=='sizeof' and left['argType']['qualType']=='unsigned long long','assert type')
    while right['kind']=='ImplicitCastExpr':right=right['inner'][0]
    need(right['kind']=='IntegerLiteral' and right['value']=='8','assert width');assertions+=1;return path
   kind(decl,'VarDecl');need(decl['id'] not in env and len(decl.get('inner',[]))==1,'variable inventory');v=expr(decl['inner'][0],path);need(z.is_bv(v) and width(decl)==v.size(),'initializer type');env[decl['id']]=v;types[decl['id']]=decl['type']['qualType'];return path
  if k=='IfStmt':
   need(len(items)==2 and not n.get('hasElse',False) and items[1]['kind'] in ['ReturnStmt','CallExpr'],'if grammar');guard=truth(expr(items[0],path));residual=statement(items[1],z.And(path,guard));return z.Or(z.And(path,z.Not(guard)),residual)
  if k=='CallExpr':
   name,args=callee(n,'BuiltinFnToFnPtr');need(name=='__builtin_unreachable' and not args,'statement call');bad.append(path);return z.BoolVal(False)
  if k=='ReturnStmt':
   need(len(items)==1,'return arity');v=expr(items[0],path);need(isinstance(v,tuple) and v[0] in ['ok','error'],'return type');returns.append((path,v));return z.BoolVal(False)
  raise ValueError('unsupported statement '+k)
 kind(nodes[-1],'CompoundStmt');residual=statement(nodes[-1],z.BoolVal(True));need(assertions==1 and len(returns)==2,'body inventory')
 correct=[]
 for path,v in returns:
  match=z.And(b==0,v[1]==3) if v[0]=='error' else z.And(b!=0,v[1]==z.UDiv(a,b),v[2]==z.URem(a,b))
  correct.append(z.Implies(path,match))
 guards=[p for p,_ in returns]
 goal=z.And(*correct,z.Not(residual),z.Or(*guards),*[z.Not(x) for x in bad],*[z.Not(z.And(p,q)) for i,p in enumerate(guards) for q in guards[i+1:]])
 solver=z.Solver();solver.set(timeout=30000);solver.add(z.Not(goal))
 if pin is not None:need(len(pin)==2,'pin arity');solver.add(a==pin[0],b==pin[1])
 status=solver.check();need(status!=z.unknown,'UNKNOWN: '+solver.reason_unknown());row={'result':str(status),'returns':len(returns),'safetyObligations':len(bad),'operators':ops}
 if status==z.sat:
  m=solver.model();row['witness']={'dividend':m.eval(a,model_completion=True).as_long(),'divisor':m.eval(b,model_completion=True).as_long()}
 return row
