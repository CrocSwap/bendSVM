from pathlib import Path
import sys,json,runpy,hashlib
import z3 as z
ns=globals().get('qualified_metadata')
if ns is None:ns=runpy.run_path('verification/collection_entry/connect-metadata.py',run_name='__main__')
entry=ns['entry'];bindings=ns['bindings'];prefix=ns['constraints'][:-len(bindings)];rows=[]
byte,field,address,v=ns['byte'],ns['field'],ns['address'],ns['v'];program=ns['program']
tests=[]
for i,label in [(0,''),(2,'collection_')]:
 at=entry['records'][i]['at'];owned=z.And(*[byte(at+v(40+k))==byte(program+v(k)) for k in range(32)])
 tests += [(label+'owner_equal',z.Not(owned),None),(label+'writable',byte(at+v(2))==0,None),
           (label+'executable',byte(at+v(3))!=0,None),(label+'signer',byte(at+v(1))==0,None)]
tests += [('state_size',field(0,'size')==26,0),('collection_size',field(2,'size')==55,2)]
for name,bad,size_slot in tests:
 index=next(i for i,(lhs,_,_) in enumerate(bindings) if str(lhs)==name)
 solver=z.Solver();solver.set(timeout=60000);solver.add(*prefix,*[eq for i,(_,_,eq) in enumerate(bindings) if i!=index],ns['commits'],bad)
 solver.add(byte(entry['cursor']+v(8))==0)
 for i,size in enumerate([25,7,68]):
  if i!=size_slot:solver.add(field(i,'size')==size)
 status=solver.check();print('missing-'+name,status,flush=True);assert status==z.sat,(name,status,solver.reason_unknown())
 rows.append({'name':'missing-'+name,'result':'sat','witness':str(solver.model())})
entry['loader_unchanged'](entry['ld']);entry['collection_unchanged'](entry['cd'])
(ns['run']/'metadata-controls.json').write_text(json.dumps({'passed':True,'controls':rows,'loaderInputSha256':entry['lr']['inputSha256'],'collectionInputSha256':entry['cr']['inputSha256'],'checkerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n');print(ns['run'])
