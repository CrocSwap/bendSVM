"""Check existential PDA application substitution admits a total UF extension."""
import z3 as z
NAMES={'custody_pda_result':64,'custody_pda_key':256,'custody_pda_bump':8}
def rewrite(conditions,pins):
 applications={};pending=list(conditions);seen=set()
 while pending:
  term=pending.pop()
  if term.get_id() in seen:continue
  seen.add(term.get_id())
  if z.is_app(term) and term.decl().kind()==z.Z3_OP_UNINTERPRETED and str(term.decl().name()) in NAMES:applications[term.sexpr()]=term
  pending.extend(term.children())
 assert applications,'missing PDA applications'
 supplied={};functions={}
 for term,value in pins:
  assert term.sexpr() in applications and term.sexpr() not in supplied,'application inventory'
  name=str(term.decl().name());assert name in NAMES
  assert term.decl().arity()==2 and all(term.decl().domain(i)==z.BitVecSort(256) for i in range(2)),'PDA input signature'
  assert term.sort()==value.sort()==z.BitVecSort(NAMES[name]) and z.is_bv_value(value),'PDA output signature'
  key=term.decl().get_id()
  if key in functions:assert z.eq(functions[key][1],value),'inconsistent constant interpretation'
  functions[key]=(term.decl(),value);supplied[term.sexpr()]=value
 assert set(supplied)==set(applications),'missing application pin'
 # Constant total functions are valid interpretations of otherwise unconstrained
 # deterministic syscall UFs. Check the proposed term replacements are exactly
 # that interpretation, including under array lambdas and shared expressions.
 constants=list(functions.values());result=[]
 for condition in conditions:
  replaced=z.substitute(condition,*pins)
  interpreted=z.substitute_funs(condition,*constants)
  assert z.eq(z.simplify(replaced),z.simplify(interpreted)),'replacement differs from total function interpretation'
  result.append(replaced)
 return result
