import runpy,json
import z3 as z
q=runpy.run_path('verification/collection_entry/connect-zero.py',run_name='__main__')
c=q['c'];m=c['m'];entry=c['entry'];paths=c['paths'];v=c['v'];byte=c['byte'];field=c['field'];base=c['base'];run=c['run'];core=m['core']
# Universal obligations use a weaker quantifier-free premise set. Dropping the
# zero equation cannot hide a counterexample. Update witnesses disable its guard.
base_constraints=c['constraints'];bindings=[];guards=[];offsets=[]
for i in range(2):
 guard=z.And(c['dispatch'],paths.events['record_decode_'+str(i)]);guards.append(guard)
 offset=z.BitVec('record_pointer_'+str(i)+'_offset',64);offsets.append(offset)
 for j in range(4):
  lhs=z.Extract(7,0,paths.input('record_'+str(i)+'_byte_'+str(j),8))
  bindings.append(z.Implies(guard,lhs==byte(base+offset+v(j))))
constraints=base_constraints+bindings;rows=[]
def check(name,extra,expected,cs=constraints):
 s=z.Solver();s.set(timeout=60000);s.add(*cs,*extra);r=s.check();print(name,r,flush=True);assert r==expected,(name,r,s.reason_unknown());rows.append({'name':name,'result':str(r)});return s
for i in range(2):
 guard=guards[i];offset=offsets[i]
 # Independent nonwrapping arithmetic expression for the selected record index.
 expected=v(56)+(z.ZeroExt(32,paths.u32('start'))+v(i))*v(4)
 check('record-'+str(i)+'-offset',[guard,offset!=expected],z.unsat)
 check('record-'+str(i)+'-allocation-span',[guard,z.Or(z.ULT(offset,v(56)),z.UGT(offset,field(2,'size')-v(4)),z.ULT(field(2,'size'),v(4)))],z.unsat)
 raw=z.Concat(*[byte(base+expected+v(j)) for j in reversed(range(4))])
 check('record-'+str(i)+'-decoded-value',[guard,core['record_decoded'][i][1]!=raw],z.unsat)
check('second-record-inactive-for-this-selector',[guards[1]],z.unsat)
# The fixture's Attack{3} returns the selected value unchanged and can commit.
# This makes record-input corruption observable in encoded output.
isort=core['src'].sort(core['f']['args'][2]);instruction=core['instruction']
attack3=z.And(isort.recognizer(2)(instruction),isort.accessor(2,0)(instruction)==3)
active=z.And(c['update'],attack3,guards[0])
raw=z.Concat(*[byte(base+v(56)+z.ZeroExt(32,paths.u32('start'))*v(4)+v(j)) for j in reversed(range(4))])
encoded=z.Concat(*[z.Extract(7,0,paths.input('encoded_record_0_byte_'+str(j),8)) for j in reversed(range(4))])
check('unchanged-record-reaches-encoded-output',[active,encoded!=raw],z.unsat)
witness=[field(i,'size')==v(n) for i,n in enumerate([25,7,68])]
check('active-record-commit-witness',[active,*witness],z.sat)
for j in range(4):
 check('missing-record-byte-'+str(j),[active,*witness,encoded!=raw],z.sat,base_constraints+[b for k,b in enumerate(bindings) if k!=j])
entry['loader_unchanged'](entry['ld']);entry['collection_unchanged'](entry['cd'])
(run/'records.json').write_text(json.dumps({'passed':True,'claims':rows,'bindings':8,'activeBindings':4,'inactiveBindings':4,'loaderInputSha256':entry['lr']['inputSha256'],'collectionInputSha256':entry['cr']['inputSha256'],'scope':'Exploratory record byte connection using qualified pointer/helper contracts. Slot1 unreachable for fixture selector. Universal checks drop initialization-zero equation; update witnesses disable its guard. No global pointer provenance, commit-memory or SBF theorem.'},indent=2)+'\n');print(run,flush=True)
