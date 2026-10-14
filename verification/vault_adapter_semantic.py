import os,copy,hashlib,json,pathlib,sys
sys.path.insert(0,'verification')
import z3 as z
from effect_semantics import Extraction
from token_semantics import Validation
from token_executor import Execution
import adapter_contract as contract
from adapter_contract_sym import World,Exec
from acyclic_c import Source,C,need,wire
from tagged_sum_c import check_artifacts
from tagged_sum_layout import check_layouts
from semantic_binding import check as audit_bindings
from state_encoding_binding import audit as audit_rows
from codec_semantics import Codecs,PackedDecoder
from vault_adapter_inventory import validate_input
root=pathlib.Path(os.environ['BRIDGE_DIR']);raw=(root/'input.json').read_bytes();data=json.loads(raw);validate_input(data);need(z.get_version_string()=='5.1.0','Z3 pin')
bindings={**data['sourceHashes'],**data['artifactHashes']}
def bound():
 for p,h in bindings.items():need(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==h,p)
bound()
validation_model=Validation(data['fixture']['files']);reserved=validation_model.verify_reserved()
execution_model=Execution(data['fixture']['files'])
validation_model.claims.update(execution_model.claims(validation_model.model,validation_model.actual))
def run(program,mutated=False,arithmetic=False,transfer=False):
 source=Source(program['source']);check_artifacts([program['artifact']]);check_layouts([program['artifact']]);c=C(source,program['artifact']);f=copy.deepcopy(data['fixture']);f['files']['vault.h']=program['artifact']['c'];m=contract.summarize(f['schema'],f['interface'])
 codecs=Codecs(source,{'name':'vault','headerName':'vault.h','schema':f['schema'],'native':f['files']['vault.h'],'codecs':f['files']['vault.wire.h']})
 extraction_model=Extraction(source,f);extraction_evidence=extraction_model.verify()
 for name,digest in validation_model.runtime_hashes.items():need(hashlib.sha256(f['files'][name].encode()).hexdigest()==digest,'shared validator runtime binding')
 class TypedWorld(World):
  latest=None
  def __init__(self,m):
   super().__init__(m);self.bridge=[];self.root_bridge=[];self.state_bridge=[];self.rows=[];self.encodings=[];self.roots=[];self.replay=[];self.effect_values=[];self.validator_values=[];self.SYSCALL=[z.BitVec('token_syscall_result'+str(i),64) for i in range(m['slots'])];TypedWorld.latest=self
   self.state_sort=source.sort(f['interface']['state']);self.ix_sort=source.sort(f['interface']['instruction'])
   self.decoded={'state':PackedDecoder(codecs,f['interface']['state']),'ix':PackedDecoder(codecs,f['interface']['instruction'])};self.decode_ok={name:decoder.ok for name,decoder in self.decoded.items()}
  def axioms(self):return super().axioms()+self.bridge
 class TypedExec(Exec):
  def call_root(self,name,args,st,g):
   context,before,instruction=args;pc=z.And(st.pc,g);words=context.f[0]
   key=c.call(m['key_maker'],list(words[:8]),pc);slot=c.call(m['slot_maker'],list(words[9:]),pc)
   ctx=c.call(m['context_maker'],[key,words[8],slot],pc)
   result=c.call(name,[ctx,before.f[1],instruction.f[1]],pc)
   sort=source.sort(m['result_name']);accepted=sort.recognizer(m['accepted'])(result)
   pairs=[(self.w.ROOT_TAG,z.If(accepted,z.BitVecVal(m['accepted'],32),z.BitVecVal(m['rejected'],32))),(self.w.outf(m['rejected'],0),sort.accessor(m['rejected'],0)(result))]
   equations=[z.Implies(pc,a==b) for a,b in pairs];self.w.root_bridge.extend(equations);self.w.state_bridge.extend(equations);self.w.bridge.extend(equations);self.w.rows.append((pc,pairs))
   next_state=sort.accessor(m['accepted'],0)(result);ok,encoded=codecs.encode(f['interface']['state'],next_state)
   guard=z.And(pc,accepted);pairs=[(self.w.enc_ok(m['accepted'],0),ok)]+list(zip(self.w.enc(m['accepted'],0),encoded))
   self.w.state_bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.rows.append((guard,pairs));self.w.encodings.append((guard,next_state,encoded))
   effects=sort.accessor(m['accepted'],1)(result)
   extracted,slots=extraction_model.extract(effects)
   pairs=[(self.w.ext_ok(m['accepted'],1),extracted)]+[(self.w.eff((m['accepted'],1),i,'active'),slot[('active',)]) for i,slot in enumerate(slots)]
   self.w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.rows.append((guard,pairs));self.w.effect_values.append((guard,slots))
   validation=[validation_model.bind_world(self.w,slot) for slot in slots]
   self.w.validator_values.append((guard,validation))
   pairs=[(self.w.VAL[i],value[0]) for i,value in enumerate(validation)]
   self.w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.rows.append((guard,pairs))
   pairs=[(self.w.EXE[i],execution_model.result(slot,self.w.SYSCALL[i])[0]) for i,slot in enumerate(slots)]
   self.w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.rows.append((guard,pairs))
   self.w.roots.append((pc,key,before.f[1],instruction.f[1],result));self.w.replay.append((pc,[ctx,before.f[1],instruction.f[1]]))
   return super().call_root(name,args,st,g)
 contract.World=TypedWorld;contract.Exec=TypedExec
 adapter=contract.analyse(m,f['adapter'],f['files'],False);w=TypedWorld.latest
 allowed=[w.ROOT_TAG,w.outf(m['rejected'],0),w.enc_ok(m['accepted'],0),*w.enc(m['accepted'],0),w.ext_ok(m['accepted'],1),*[w.eff((m['accepted'],1),i,'active') for i in range(m['slots'])]]
 allowed.extend(w.VAL[:m['slots']]);allowed.extend(w.EXE[:m['slots']])
 binding=audit_rows(w.rows,w.bridge,World.axioms(w),allowed)
 controls=[]
 def equations(rows):return [z.Implies(guard,lhs==rhs) for guard,pairs in rows for lhs,rhs in pairs]
 missing=[(g,[(lhs,rhs) for lhs,rhs in pairs if not lhs.eq(w.enc(m['accepted'],0)[-1])]) for g,pairs in w.rows]
 retarget=[(g,[(w.EXECUTABLE[5] if lhs.eq(w.enc_ok(m['accepted'],0)) else lhs,rhs) for lhs,rhs in pairs]) for g,pairs in w.rows]
 overlap=[(z.BoolVal(True),pairs) for g,pairs in w.rows]
 circular=[(g,[(lhs,lhs if lhs.eq(w.enc(m['accepted'],0)[0]) else rhs) for lhs,rhs in pairs]) for g,pairs in w.rows]
 for label,rows,axioms,reason in [('missing-output',missing,equations(missing),'output inventory'),('input-misclassified-as-output',retarget,equations(retarget),'output inventory'),('missing-equation',w.rows,w.bridge[:-1],'equation inventory'),('overlapping-assignments',overlap,equations(overlap),'assignments-to-shared-outputs-have-disjoint-guards: sat'),('circular-encoding',circular,equations(circular),'circular value')]:
  try:audit_rows(rows,axioms,World.axioms(w),allowed)
  except ValueError as e:need(reason in str(e),'wrong binding refusal '+str(e));controls.append({'name':label,'reason':str(e)})
  else:raise ValueError('binding fault escaped '+label)
 def query(name,formula,expected,base_only=False,state_only=False):
  # State invariants retain the actual root/encoding equations but omit token
  # extraction, validation and executor equations. This enlarges the modeled
  # domain: UNSAT is stronger, while SAT witnesses must use the full bridge.
  need(not (base_only and state_only),'exclusive query domains')
  need(not state_only or expected=='unsat','state domain only for universal claims')
  solver=z.Solver() if base_only or state_only else w.solver();solver.set(timeout=30000);solver.add(World.axioms(w) if base_only or state_only else []);solver.add(w.state_bridge if state_only else []);solver.add(formula)
  if name=='unsigned-root-rejection-reachable' and expected=='sat':
   # Existential witness only: unsigned Initialize with zero mint/slot avoids
   # searching arbitrary arithmetic branches. Retain every caller equation.
   solver.add([b==0 for b in w.IXB]);solver.add(w.SLOT==0)
  if expected=='sat':
   # Equality elimination preserves the full existential assertion set and model.
   original_assertions=list(solver.assertions())
   prepared=z.Then(z.Tactic('simplify',ctx=solver.ctx),z.Tactic('solve-eqs',ctx=solver.ctx),z.Tactic('smt',ctx=solver.ctx)).solver()
   prepared.set(timeout=30000);prepared.add(original_assertions)
   need(len(prepared.assertions())==len(original_assertions) and all(z.eq(a,b) for a,b in zip(prepared.assertions(),original_assertions)),'SAT preprocessing changed assertion inventory')
   solver=prepared
  result=solver.check()
  if result==z.unknown:
   # Retain the actual failed solver assertion set; diagnostics never publish success.
   raw_query=solver.sexpr()+'\n(check-sat)\n';query_hash=hashlib.sha256(raw_query.encode()).hexdigest()
   query_path=root/('unknown-query-'+query_hash+'.smt2');query_path.write_text(raw_query)
   diagnostic={'passed':False,'diagnosticOnly':True,'query':name,'expected':expected,'result':'unknown','reasonUnknown':solver.reason_unknown(),'timeoutMs':30000,'variant':'negative' if mutated else 'arithmetic' if arithmetic else 'transfer' if transfer else 'positive','baseOnly':base_only,'stateOnly':state_only,'assertionCount':len(solver.assertions()),'inputSha256':hashlib.sha256((root/'input.json').read_bytes()).hexdigest(),'checkerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'queryPath':str(query_path),'querySha256':query_hash}
   (root/('unknown-query-'+query_hash+'.json')).write_text(json.dumps(diagnostic,indent=2)+'\n');print(json.dumps(diagnostic),flush=True)
  need(result!=z.unknown,name+': UNKNOWN');need(str(result)==expected,name+': '+str(result));row={'name':name,'result':str(result)}
  if result==z.sat and name in ('deposit-accounting-without-overflow','deposit-plan-destination'):
   model=solver.model();active=[args for guard,args in w.replay if z.is_true(model.eval(guard,model_completion=True))];need(len(active)==1,'unique arithmetic root');signature=program['source']['functions']['vault.process'];row['wireArgs']=[wire(source,t,model.eval(a,model_completion=True)) for t,a in zip(signature['args'],active[0])];row['stateBytes']=[model.eval(b,model_completion=True).as_long() for b in w.D];row['instructionBytes']=[model.eval(b,model_completion=True).as_long() for b in w.IXB]
   if name=='deposit-accounting-without-overflow':
    paths=[p for p in w.paths if z.is_true(model.eval(z.And(p.pc,p.ret==0),model_completion=True))];need(len(paths)==1,'unique arithmetic success path');row['committedBytes']=[model.eval(b,model_completion=True).as_long() for b in contract.final_data(w,paths[0])]
  return row
 claims=[query('actual-root-C-safety',z.Or(c.bad),'unsat',True)]
 def bad_path(p):return z.Or(p.ret==0,z.BoolVal(any(e.kind in ['write','execute','encode'] for e in p.events)))
 unsigned=z.Or([z.And(p.pc,z.Not(w.SIGNER[1]),bad_path(p)) for p in w.paths])
 solver=w.solver();solver.add(unsigned);result=solver.check();need(result!=z.unknown,'unsigned UNKNOWN')
 row={'name':'unsigned-no-success-commit-or-postdecision-effects','result':str(result)}
 if result==z.sat:
  model=solver.model();active=[args for guard,args in w.replay if z.is_true(model.eval(guard,model_completion=True))];need(len(active)==1,'unique active root');signature=program['source']['functions']['vault.process'];row['wireArgs']=[wire(source,t,model.eval(a,model_completion=True)) for t,a in zip(signature['args'],active[0])];row['adapterWitness']=w.describe(model);row['stateBytes']=[model.eval(b,model_completion=True).as_long() for b in w.D];row['instructionBytes']=[model.eval(b,model_completion=True).as_long() for b in w.IXB]
 claims.append(row)
 live=source.sort(f['interface']['state']);wrong_owner=z.Or([z.And(pc,live.recognizer(1)(before),key!=live.accessor(1,0)(before)) for pc,key,before,ix,out in w.roots])
 claims.append(query('wrong-owner-no-success-commit-or-postdecision-effects',z.Or([z.And(p.pc,wrong_owner,bad_path(p)) for p in w.paths]),'sat' if mutated else 'unsat'))
 root_reached=z.Or([entry[0] for entry in w.roots])
 witnesses=[query('authorized-success-reachable',z.Or([z.And(p.pc,p.ret==0,w.SIGNER[1]) for p in w.paths]),'sat'),query('unsigned-root-rejection-reachable',z.Or([z.And(p.pc,root_reached,w.ROOT_TAG==m['rejected'],p.ret==257,z.Not(w.SIGNER[1])) for p in w.paths]),'unsat' if mutated else 'sat')]
 # Observe actual final account bytes from interpreted adapter writes.
 state_claims=[]
 for label,disagreement in [('committed-state-decodes-to-actual-root-state',lambda ok,value,next_state,bytes_:z.Or(z.Not(ok),value!=next_state)),('committed-state-has-canonical-encoding',lambda ok,value,next_state,bytes_:z.Or([a!=b for a,b in zip(bytes_,codecs.encode(f['interface']['state'],next_state)[1])]))]:
  bad=[]
  for path in w.paths:
   committed=contract.final_data(w,path)
   ok,value=codecs.decode(f['interface']['state'],committed[20:])
   for guard,next_state,encoded in w.encodings:bad.append(z.And(path.pc,path.ret==0,guard,disagreement(ok,value,next_state,committed[20:])))
  state_claims.append(query(label,z.Or(bad),'unsat',state_only=True))
 # Independent business equations over the committed byte payload.
 def field(type_name,variant_name,value,field_name):
  t=source.types[type_name];matches=[(i,v) for i,v in enumerate(t['variants']) if v['name'].endswith('.'+variant_name) or v['name']==variant_name];need(len(matches)==1,'law variant');i,variant=matches[0];j=next(j for j,f in enumerate(variant['fields']) if f['name']==field_name);return source.sort(type_name).accessor(i,j)(value)
 def is_(type_name,variant_name,value):
  t=source.types[type_name];i=next(i for i,v in enumerate(t['variants']) if v['name'].endswith('.'+variant_name) or v['name']==variant_name);return source.sort(type_name).recognizer(i)(value)
 def amount(v):
  name=m['slot_name'];return z.Concat(field(name,'U64',v,'hi'),field(name,'U64',v,'lo'))
 state_name=f['interface']['state'];ix_name=f['interface']['instruction'];equations={name:[] for name in ['initialized-balance-zero','initial-owner-and-mint-bound','deposit-accounting-without-overflow','withdraw-accounting-without-underflow','successful-state-is-live','owner-and-mint-preserved-on-update']}
 reachable={name:[] for name in ['Initialize','Deposit','Withdraw']}
 for path in w.paths:
  if z.is_false(z.simplify(path.ret==0)):continue
  committed=contract.final_data(w,path);decoded_ok,new=codecs.decode(state_name,committed[20:]);new_balance=amount(field(state_name,'Live',new,'balance'))
  for guard,actor,before,ix,result in w.roots:
   success=z.And(path.pc,path.ret==0,guard);initial=is_(ix_name,'Initialize',ix);deposit=is_(ix_name,'Deposit',ix);withdraw=is_(ix_name,'Withdraw',ix)
   old_balance=amount(field(state_name,'Live',before,'balance'));incoming=amount(field(ix_name,'Deposit',ix,'amount'));outgoing=amount(field(ix_name,'Withdraw',ix,'amount'));sum65=z.ZeroExt(1,old_balance)+z.ZeroExt(1,incoming)
   equations['initialized-balance-zero'].append(z.And(success,initial,new_balance!=0))
   equations['initial-owner-and-mint-bound'].append(z.And(success,initial,z.Or(field(state_name,'Live',new,'owner')!=actor,field(state_name,'Live',new,'mint')!=field(ix_name,'Initialize',ix,'mint'))))
   equations['deposit-accounting-without-overflow'].append(z.And(success,deposit,z.Or(z.UGT(sum65,2**64-1),z.ZeroExt(1,new_balance)!=sum65)))
   equations['withdraw-accounting-without-underflow'].append(z.And(success,withdraw,z.Or(z.ULT(old_balance,outgoing),new_balance!=old_balance-outgoing)))
   equations['successful-state-is-live'].append(z.And(success,z.Or(z.Not(decoded_ok),z.Not(is_(state_name,'Live',new)))))
   equations['owner-and-mint-preserved-on-update'].append(z.And(success,z.Or(deposit,withdraw),z.Or(field(state_name,'Live',before,'owner')!=field(state_name,'Live',new,'owner'),field(state_name,'Live',before,'mint')!=field(state_name,'Live',new,'mint'))))
   for name,condition in [('Initialize',initial),('Deposit',deposit),('Withdraw',withdraw)]:reachable[name].append(z.And(success,condition,incoming!=0 if name=='Deposit' else outgoing!=0 if name=='Withdraw' else z.BoolVal(True)))
 for name,bad in equations.items():
  fault=arithmetic and name=='deposit-accounting-without-overflow'
  state_claims.append(query(name,z.Or(bad),'sat' if fault else 'unsat',state_only=not fault))
 for name,conditions in reachable.items():witnesses.append(query('committed-'+name.lower()+'-reachable',z.Or(conditions),'unsat' if transfer and name=='Deposit' else 'sat'))
 effect_claims=[]
 for label in ['successful-helper-order-and-active-slots','initialize-extracted-mint-check','deposit-extracted-fields','withdraw-extracted-fields']:
  bad=[]
  for path in w.paths:
   success=z.And(path.pc,path.ret==0)
   if label=='successful-helper-order-and-active-slots':
    observed=[e.slot for e in path.events if e.kind=='execute']
    bad.append(z.And(success,z.Or(z.BoolVal(observed!=[0,1]),w.eff((m['accepted'],1),0,'active')==0,w.eff((m['accepted'],1),1,'active')!=0)))
   else:
    deposit=label.startswith('deposit');initial=label.startswith('initialize');variant='Initialize' if initial else 'Deposit' if deposit else 'Withdraw'
    for (guard,actor,before,ix,result),(effect_guard,slots) in zip(w.roots,w.effect_values):
     slot=slots[0];expected_amount=z.BitVecVal(0,64) if initial else amount(field(ix_name,variant,ix,'amount'))
     comparisons=[slot[('active',)]==1,slot[('source',)]==4,slot[('destination',)]==5,slot[('mint',)]==6,slot[('recipient',)]==(1 if deposit else 0),slot[('authority',)]==(0 if deposit else 1),slot[('amount',)]==expected_amount]
     if initial:comparisons=[slot[('active',)]==2,slot[('mint',)]==4]
     expected_mint=field(ix_name,'Initialize',ix,'mint') if initial else field(state_name,'Live',before,'mint')
     for byte in range(32):
      limb=field(m['key_name'],'Key',expected_mint,chr(ord('a')+byte//4))
      comparisons.append(slot[(('mint_key',),byte)]==z.Extract(8*(byte%4)+7,8*(byte%4),limb))
     bad.append(z.And(success,guard,effect_guard,is_(ix_name,variant,ix),z.Not(z.And(comparisons))))
  effect_claims.append(query(label,z.Or(bad),'unsat'))
 plan_bad=[]
 for (pc,actor,before,ix,result),(guard,slots) in zip(w.roots,w.effect_values):
  plan_bad.append(z.And(pc,guard,w.SIGNER[1],is_(ix_name,'Deposit',ix),slots[0][('destination',)]!=5))
 plan_claims=[query('deposit-plan-destination',z.Or(plan_bad),'sat' if transfer else 'unsat')]
 validator_claims=[]
 for label in w.validator_values[0][1][0][1]:
  bad=[]
  for path in w.paths:
   called=[e.slot for e in path.events if e.kind=='validate']
   for guard,validation in w.validator_values:
    for i in called:bad.append(z.And(path.pc,guard,z.Not(validation[i][1][label])))
  validator_claims.append(query('composed-validator-'+label,z.Or(bad),'unsat'))
 return {'executorBody':execution_model.evidence,'planClaims':plan_claims,'reservedIndependence':reserved,'validatorClaims':validator_claims,'extractionEvidence':extraction_evidence,'effectClaims':effect_claims,'stateClaims':state_claims,'effectSlots':len(w.effect_values[0][1]),'bindingAudit':binding,'bindingFaults':controls,'adapter':adapter,'claims':claims,'witnesses':witnesses,'rootCalls':len(w.roots),'CGuards':len(c.bad),'linkage':'Actual root C result and state encoding constrain adapter execution. Input decoding and state encoding use validated emitted-codec semantics. Actual returned effects constrain extracted slots; Validation uses the parsed token helper; Execution results use an exact reviewed-body summary; syscall behavior and memory isolation remain assumed.'}

positive=run(data['program']);need(positive['claims'][1]['result']=='unsat','positive authorization')
mutant=copy.deepcopy(data['program']);old='return bend_vault_2e_Rejected_make(1u);';need(old in mutant['artifact']['c'],'mutation target');mutant['artifact']['c']=mutant['artifact']['c'].replace(old,'return a1;',1);mutant['artifact']['cSha256']=hashlib.sha256(mutant['artifact']['c'].encode()).hexdigest()
negative=run(mutant,True);need(negative['claims'][1]['result']=='sat','auth mutation escaped')
arithmetic_program=copy.deepcopy(data['program']);old='(a0 + a1)';need(old in arithmetic_program['artifact']['c'],'arithmetic target');arithmetic_program['artifact']['c']=arithmetic_program['artifact']['c'].replace(old,'(a0 - a1)',1);arithmetic_program['artifact']['cSha256']=hashlib.sha256(arithmetic_program['artifact']['c'].encode()).hexdigest();arithmetic_result=run(arithmetic_program,arithmetic=True)
transfer_program=copy.deepcopy(data['program']);old='_Transfer_make(4u, 5u, 6u, a1,';need(old in transfer_program['artifact']['c'],'transfer target');transfer_program['artifact']['c']=transfer_program['artifact']['c'].replace(old,'_Transfer_make(4u, 4u, 6u, a1,',1);transfer_program['artifact']['cSha256']=hashlib.sha256(transfer_program['artifact']['c'].encode()).hexdigest();transfer_result=run(transfer_program,transfer=True)
bound();out={'passed':True,'endToEndVerified':False,'inputSha256':hashlib.sha256(raw).hexdigest(),'sourceHashes':data['sourceHashes'],'artifactHashes':data['artifactHashes'],'checkerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'codecSemanticsSha256':hashlib.sha256(pathlib.Path('verification/codec_semantics.py').read_bytes()).hexdigest(),'tokenSemanticsSha256':hashlib.sha256(pathlib.Path('verification/token_semantics.py').read_bytes()).hexdigest(),'tokenExecutorSha256':hashlib.sha256(pathlib.Path('verification/token_executor.py').read_bytes()).hexdigest(),'effectSemanticsSha256':hashlib.sha256(pathlib.Path('verification/effect_semantics.py').read_bytes()).hexdigest(),'bindingAuditSha256':hashlib.sha256(pathlib.Path('verification/state_encoding_binding.py').read_bytes()).hexdigest(),'positive':positive,'negative':negative,'arithmetic':arithmetic_result,'transfer':transfer_result,'scope':'Byte-to-state-to-byte vault adapter model with actual root C, emitted codec semantics, extracted effect slots and parsed token validation. Executor results use a reviewed-body summary. Syscall behavior/loader/memory/toolchain remain modeled or trusted. Not an SBF theorem.'}
(root/'semantic-report.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'passed':True,'claims':positive['claims'],'mutation':negative['claims'][1],'rootCalls':positive['rootCalls']}))
