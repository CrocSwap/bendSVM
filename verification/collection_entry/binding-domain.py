import runpy,json
import z3 as z
r=runpy.run_path('verification/collection_entry/connect-records.py',run_name='__main__')
q=r['q'];c=r['c'];m=r['m'];e=r['entry'];paths=r['paths'];run=r['run']
rows=list(e['bindings'])
rows += [(c['dispatch'],lhs,rhs,eq) for lhs,rhs,eq in m['bindings']]
for (name,bits,rhs),eq in zip(c['specs'],c['bindings']):
 rows.append((c['guard'],z.Extract(bits-1,0,paths.input(name,bits)),rhs,eq))
rows.append((q['guard'],z.Extract(0,0,paths.input('collection_allocation_zero',1)),m['boolv'](q['all_zero'],1),q['binding']))
for i in range(2):
 for j in range(4):
  lhs=z.Extract(7,0,paths.input('record_'+str(i)+'_byte_'+str(j),8));rhs=c['byte'](c['base']+r['offsets'][i]+c['v'](j))
  rows.append((r['guards'][i],lhs,rhs,r['bindings'][i*4+j]))
rows += [(z.And(c['dispatch'],guard),lhs,rhs,z.Implies(c['dispatch'],eq)) for guard,lhs,rhs,eq in m['core']['bindings']]
rows=[tuple(z.simplify(t) for t in row) for row in rows]
assert len(rows)==99
# Traverse quantifier bodies too, retaining bound variables as non-constants.
def names(t):
 found=set();todo=[t];seen=set()
 while todo:
  node=todo.pop()
  if node.get_id() in seen:continue
  seen.add(node.get_id())
  if z.is_const(node) and node.decl().kind()==z.Z3_OP_UNINTERPRETED:found.add(node.get_id())
  todo.extend(node.children())
 return found

def order(rs):
 assert all(z.is_const(lhs) and lhs.decl().kind()==z.Z3_OP_UNINTERPRETED for _,lhs,_,_ in rs),'non-symbol output'
 outputs={lhs.get_id() for _,lhs,_,_ in rs};assert len(outputs)==len(rs),'duplicate output'
 pending=list(rs);done=set();ordered=[]
 while pending:
  ready=[row for row in pending if not ((names(row[0])|names(row[2]))&outputs-done)]
  assert ready,'binding dependency cycle'
  for row in ready:ordered.append(row);done.add(row[1].get_id())
  pending=[row for row in pending if row[1].get_id() not in done]
 return ordered
ordered=order(rows);replacement=[];checks=[]
for guard,lhs,rhs,eq in ordered:
 value=z.substitute(rhs,*replacement) if replacement else rhs
 replacement.append((lhs,value))
 # Each guarded equality must hold for the constructed extension. This checks
 # original equations, including Boolean-to-bit and dispatch guard rewrites.
 claim=z.simplify(z.substitute(eq,*replacement))
 s=z.Solver();s.set(timeout=60000);s.add(z.Not(claim));status=s.check();assert status==z.unsat,(str(lhs),status,s.reason_unknown());checks.append(str(lhs))
print('99-binding-constructive-extension unsat',flush=True)
controls=[]
for label,mutant in [('duplicate-output',rows+[rows[0]]),('self-dependent-output',[(rows[0][0],rows[0][1],rows[0][1]+1,rows[0][3])]+rows[1:])]:
 try:order(mutant)
 except AssertionError as error:controls.append({'name':label,'reason':str(error)})
 else:raise AssertionError('accepted '+label)
e['loader_unchanged'](e['ld']);e['collection_unchanged'](e['cd'])
(run/'binding-domain.json').write_text(json.dumps({'passed':True,'bindings':99,'extensionClaims':checks,'controls':controls,'scope':'Constructive extension of 99 byte/codec/root binding equations, including quantified zero predicate. Helper outputs remain governed by separately qualified contracts; not a non-vacuity theorem for all memory or helper constraints.','loaderInputSha256':e['lr']['inputSha256'],'collectionInputSha256':e['cr']['inputSha256']},indent=2)+'\n');print(run,flush=True)
