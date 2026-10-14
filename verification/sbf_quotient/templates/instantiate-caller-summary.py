"""Mechanically instantiate proved caller UFs with the certified step formula."""
from pathlib import Path
import ast,hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
if z.get_version_string()!='5.1.0':raise RuntimeError('solver pin')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def check_bindings(report):
 for key in ['inputHashes','reports']:
  for p,h in report.get(key,{}).items():
   if sha(p)!=h:raise RuntimeError('prerequisite drift '+p)
caller_report=base/'caller-calls-report.json';sixteen_report=base/'div16-composition-report.json'
for file in [caller_report,sixteen_report]:
 doc=json.loads(file.read_text())
 if doc['passed'] is not True:raise RuntimeError('failed prerequisite')
 check_bindings(doc)
# Load the exact step function used by the universal inline certificates.
step_file=base/'prove-div16-first-two.py';tree=ast.parse(step_file.read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='next_step')
stepns={'z':z};exec(compile(ast.Module(body=[fn],type_ignores=[]),str(step_file),'exec'),stepns);step=stepns['next_step']
def repeat(q,r,d,n):
 for _ in range(n):q,r=step(q,r,d)
 return q,r
sixteen=json.loads(sixteen_report.read_text());leaf_file=next(Path(p) for p in sixteen['reports'] if p.endswith('div4-composition-report.json'));leaf=json.loads(leaf_file.read_text());check_bindings(leaf)
leaf_driver=next(Path(p) for p in leaf['inputHashes'] if p.endswith('/prove-div4.py'));src=leaf_driver.read_text();fragment=src[src.index('expected_q,expected_r=q,r'):src.index('expected={')]
x,y,d=z.BitVecs('summary_q summary_r summary_d',64);lns={'z':z,'q':x,'r':y,'d':d};exec(compile(fragment,str(leaf_driver),'exec'),lns)
want4=repeat(x,y,d,4)
if not all(z.eq(a,b) for a,b in zip(want4,[lns['expected_q'],lns['expected_r']])):raise RuntimeError('four-step specification mismatch')
a,b=repeat(x,y,d,12);c,e=repeat(a,b,d,4);want16=repeat(x,y,d,16)
if not all(z.eq(a,b) for a,b in zip([c,e],want16)):raise RuntimeError('12+4 is not16')
# The abstract caller theorem is universal in Q/R. Substituting a body for each
# function is sound only if it has the matching argument sorts/order; explicitly
# compare the resulting DAG against a separately constructed32/64-step fold.
cf=base/'check-caller-calls.py';source=cf.read_text();cn={'__file__':str(cf.resolve())};exec(compile(source[:source.index('rows=[];routes=[]')],str(cf),'exec'),cn)
args=[z.Var(i,z.BitVecSort(64)) for i in range(3)];qb,rb=repeat(*args,16);substitutions=[(cn['Q'],qb),(cn['R'],rb)]
rows=[]
for name,n in [('full',4)]:
 q0=z.Concat(z.Extract(31,0,x),z.BitVecVal(0,32)) if n==2 else x
 r0=z.ZeroExt(32,z.Extract(63,32,x)) if n==2 else y
 abstract=cn['fold'](q0,r0,d,n);instantiated=[z.substitute_funs(v,*substitutions) for v in abstract];expected=repeat(q0,r0,d,n*16)
 if not all(z.eq(a,b) for a,b in zip(instantiated,expected)):raise RuntimeError(name+' summary substitution mismatch')
 rows.append({'route':name,'helperCalls':n,'restoringSteps':n*16,'quotientDAGIdentical':True,'remainderDAGIdentical':True})
# Argument order matters: swap q/r in one function body and demand disagreement
# on a concrete valid state, without a large unrolled universal solver query.
wrongQ=z.substitute_vars(qb,args[1],args[0],args[2]);sample=[z.BitVecVal(v,64) for v in [123456789,0,97]]
good=z.simplify(z.substitute_vars(qb,*sample));bad=z.simplify(z.substitute_vars(wrongQ,*sample))
if good.as_long()==bad.as_long():raise RuntimeError('argument-order fault not detected')
for file in [caller_report,sixteen_report]:check_bindings(json.loads(file.read_text()))
report={'passed':True,'exploratory':True,'endToEndVerified':False,'leafSpecMatchesInlineStep':True,'twelvePlusFourDAGIdentical':True,'routes':rows,'argumentOrderFault':{'input':[123456789,0,97],'correct':good.as_long(),'wrong':bad.as_long()},'reports':{str(p):sha(p) for p in [caller_report,sixteen_report,leaf_file]},'inputHashes':{str(p):sha(p) for p in [Path(__file__),step_file,cf,leaf_driver,repo/'verification/sbf_elf.py',cn['elf']]},'scope':'Exact Z3 DAG substitution connects universal caller summaries to16 identical restoring steps and four calls to64 steps. Relies on separately bound machine/caller proofs and valid SBF call-frame ABI. Integer loop interpretation and original application invariant composition remain separate; no full handler/compiler proof.'}
(base/'caller-summary-instantiation-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'routes':rows,'argumentOrderFault':report['argumentOrderFault']}))
