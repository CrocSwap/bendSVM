from pathlib import Path
import runpy,json
import z3 as z
m=runpy.run_path('verification/collection_entry/connect-metadata.py',run_name='__main__')
entry=m['entry']; paths=m['paths']; v=m['v']; byte=m['byte']; field=m['field']; address=m['address']; run=m['run']; dispatch=m['dispatch']; commits=m['commits']
layout=m['core']['interface']['collection']
assert layout['headerBytes']==56 and layout['lengthOffset']==20 and layout['boundStateOffset']==24 and layout['stride']==4
base=address(2,'data'); mode=byte(entry['cursor']+v(8))
# Only update-mode calls with sufficient allocation can observe stored content.
guard=z.And(dispatch,paths.events['open'],mode==1,z.UGE(field(2,'size'),v(56)))
header=z.And(*[byte(base+v(i))==b for i,b in enumerate(layout['header'])])
key=z.And(*[byte(base+v(24+i))==byte(address(0,'key')+v(i)) for i in range(32)])
length=z.Concat(*[byte(base+v(20+i)) for i in reversed(range(4))])
specs=[('collection_header_matches',1,m['boolv'](header,1)),('collection_state_key_matches',1,m['boolv'](key,1)),('collection_stored_length',32,length)]
bindings=[]
for name,bits,value in specs:
 assert name in paths.inputs
 lhs=z.simplify(z.Extract(bits-1,0,paths.input(name,bits)))
 bindings.append(z.Implies(guard,lhs==value))
constraints=m['constraints']+bindings
update=z.And(commits,mode==1)
conditions=[header,key,z.ULE(z.ZeroExt(32,length),z.UDiv(field(2,'size')-v(56),v(4)))]
rows=[]
for name,condition in zip(['stored-header','stored-state-key','stored-length-within-capacity'],conditions):
 s=z.Solver();s.set(timeout=60000);s.add(*constraints,update,z.Not(condition));r=s.check();print(name,r,flush=True);assert r==z.unsat,(name,r,s.reason_unknown());rows.append({'name':name,'result':str(r)})
# Sizes below are solely existential witnesses, never universal premises.
def witness(s):
 for i,n in enumerate([25,7,68]):s.add(field(i,'size')==v(n))
s=z.Solver();s.set(timeout=60000);s.add(*constraints,update);witness(s);r=s.check();print('update-commit-witness',r,flush=True);assert r==z.sat,(r,s.reason_unknown())
controls=[]
for i,(name,_,_) in enumerate(specs):
 s=z.Solver();s.set(timeout=60000);s.add(*m['constraints'],*[b for j,b in enumerate(bindings) if i!=j],update,z.Not(conditions[i]));witness(s);r=s.check();print('omit-'+name,r,flush=True);assert r==z.sat,(name,r,s.reason_unknown());controls.append({'name':'omit-'+name,'result':str(r),'witness':str(s.model())})
entry['loader_unchanged'](entry['ld']);entry['collection_unchanged'](entry['cd'])
(run/'content.json').write_text(json.dumps({'passed':True,'claims':rows,'updateCommitWitness':'sat','controls':controls,'loaderInputSha256':entry['lr']['inputSha256'],'collectionInputSha256':entry['cr']['inputSha256'],'scope':'Exploratory guarded stored-header/key/length binding into qualified collection helper contracts. Allocation-zero and record payloads remain abstract. No full-memory or SBF theorem.'},indent=2)+'\n')
print(run,flush=True)
