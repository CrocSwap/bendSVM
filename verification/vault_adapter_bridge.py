import copy,hashlib,json,os,pathlib,subprocess,sys,uuid,time
from vault_adapter_inventory import validate_inventories
BASE=pathlib.Path('build/vault-adapter-bridge')
def need(ok,message):
    if not ok:raise RuntimeError(message)
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def snapshot():
    paths={'package.json','package-lock.json'}
    for directory in ['compiler','sdk','tests','examples','verification','runtime','scripts']:
        paths.update(str(p) for p in pathlib.Path(directory).rglob('*') if p.is_file() and p.suffix in ['.ts','.py','.bend','.h','.c','.json','.ld'])
    paths.update(str(p) for p in pathlib.Path('.deps/bend/bend2').rglob('*') if p.is_file() and p.suffix in ['.ts','.bend','.h','.py'])
    return {p:sha(p) for p in sorted(paths) if not p.endswith('.pyc')}
ROOT_NAMES=['exact-success-domain','unsigned-never-accepted','wrong-owner-never-accepted','accepted-state-live','owner-binding','mint-binding','initial-balance-zero','deposit-exact-without-overflow','withdraw-exact-without-underflow','one-effect-only','initialize-mint-check','deposit-plan-roles-authority-amount','withdraw-plan-roles-authority-amount','modeled-C-safety']
ADAPTER_NAMES=['commit-only-on-success','root-precondition-and-arguments','effect-slot-order-and-validation-before-execution','success-iff-contract','error-code-soundness','exact-commit-and-return-data','rejection-mapping','helper-code-width','pinned-precedence-return-code','pinned-precedence-event-trace']
def validate(reports,data,input_hash):
    validate_inventories(reports[:3],data)
    from vault_semantic_inventory import validate_semantics
    validate_semantics(reports[3:],data,input_hash)
    a,b,c=reports[:3]
    for r in reports:need(r.get('passed') is True and r.get('endToEndVerified') is False and r.get('inputSha256')==input_hash,'receipt identity')
    need(a['sourceHashes']==data['sourceHashes'] and a['artifactHashes']==data['artifactHashes'],'root input bindings')
    need(b['bindings']=={**data['sourceHashes'],**data['artifactHashes']},'codec input bindings')
    need(a['rootEquivalence']==[{'function':'vault.process','result':'unsat','CGuardObligations':92,'sourceDeadPaths':9}],'equivalence inventory')
    need([(x['name'],x['result']) for x in a['rootInvariants']]==[(n,'unsat') for n in ROOT_NAMES],'root claim inventory')
    for adapter,count in [(a['adapter'],428),(c['positive'],434)]:
        need(adapter['claims']==[{'name':n,'result':'unsat'} for n in ADAPTER_NAMES],'adapter claims')
        need(adapter['obligations']==count,'adapter obligations')
    need(a['adapter']['adapterSha256']==hashlib.sha256(data['fixture']['files']['vault.c'].encode()).hexdigest(),'adapter artifact')
    need(b['primitiveTypes']==['U32','Bool'] and b['primitive']['z3']=='5.1.0','primitive inventory')
    need([x['result'] for x in b['primitive']['claims']]==['unsat','unsat','unsat','sat','unsat','sat','unsat','sat'],'primitive claims')
    need(b['codec']['z3Obligations']==104 and len(b['codec']['claims'])==104 and all(x['result']=='unsat' and x['premise']=='sat' for x in b['codec']['claims']),'codec claims')
    need([x['name'] for x in b['mutations']]==['wrong-high-byte','noncanonical-bool','ignored-child-failure'] and all(x['rejection'] for x in b['mutations']),'codec negatives')
    need([x['name'] for x in c['mutations']]==['noncanonical-signer','undersized-output','overshoot-state-slice'],'call negatives')
    for x,label in zip(c['mutations'],['canonical Bool','encoded[75]','beyond the 96 modeled bytes']):need(x['result']['outcome']=='rejected' and label in x['result']['reason'],'call negative reason')
    need(len(c['calls'])==8 and {x['kind'] for x in c['calls']}=={'decode','root','encode'},'call coverage')
def run_stage(command,env,log,timeout):
    """Stream diagnostics; timeout/nonzero/spawn failures can never publish success."""
    started=time.monotonic()
    try:
        with log.open('w') as stream:
            result=subprocess.run(command,env=env,stdout=stream,stderr=subprocess.STDOUT,text=True,timeout=timeout)
    except (subprocess.TimeoutExpired,OSError) as error:
        failure={'passed':False,'command':command,'kind':'timeout' if isinstance(error,subprocess.TimeoutExpired) else 'spawn',
            'timeoutSeconds':timeout,'seconds':time.monotonic()-started,'log':str(log),'logSha256':sha(log) if log.exists() else None,'error':str(error)}
        log.with_suffix('.failure.json').write_text(json.dumps(failure,indent=2)+'\n')
        raise
    if result.returncode!=0:
        log.with_suffix('.failure.json').write_text(json.dumps({'passed':False,'command':command,'kind':'exit','exitCode':result.returncode,
            'seconds':time.monotonic()-started,'log':str(log),'logSha256':sha(log)},indent=2)+'\n')
    need(result.returncode==0,'stage failed '+str(command)+': '+log.read_text())
    return {'command':command,'exitCode':0,'log':str(log),'logSha256':sha(log)}

def run():
    run_id=str(uuid.uuid4());run=BASE/'runs'/run_id;receipt=BASE/'fresh-receipt.json'
    # Retire prior success before any setup that could fail.
    prior=BASE/('previous-'+run_id+'.json')
    if receipt.exists():receipt.rename(prior)
    run.mkdir(parents=True)
    if prior.exists():prior.rename(run/'previous.json')
    before=snapshot();(run/'start.json').write_text(json.dumps(before,indent=2)+'\n');env={**os.environ,'BRIDGE_DIR':str(run),'PYTHONOPTIMIZE':'0'}
    stages=[]
    commands=[['node_modules/.bin/bun','verification/export-vault-adapter.ts'],[os.environ.get('CC','clang'),'-std=c11','-fsyntax-only','-I','runtime',str(run/'vault.c')]]+[[sys.executable,'-B',str(pathlib.Path('verification')/name)] for name in ['vault_adapter_root.py','vault_adapter_codecs.py','vault_adapter_calls.py','codec_roundtrips.py','vault_adapter_semantic.py']]
    for i,command in enumerate(commands):
        # Four connected root variants now include typed extraction and binding controls.
        # Outer process budget includes four variants; per-query solver budgets stay unchanged.
        timeout=900 if command[-1].endswith('vault_adapter_semantic.py') else 180
        stages.append(run_stage(command,env,run/f'stage-{i}.log',timeout))
    data=json.loads((run/'input.json').read_text());paths=[run/n for n in ['report.json','codec-report.json','call-premises-report.json','codec-semantics-report.json','semantic-report.json']];reports=[json.loads(p.read_text()) for p in paths]
    validate(reports,data,sha(run/'input.json'))
    for key,h in {**data['sourceHashes'],**data['artifactHashes']}.items():need(sha(key)==h,'input drift '+key)
    for r,script in zip(reports[1:],['vault_adapter_codecs.py','vault_adapter_calls.py']):need(r['checkerSha256']==before[str(pathlib.Path('verification')/script)],'checker binding')
    after=snapshot();drift=[p for p in sorted(set(before)|set(after)) if before.get(p)!=after.get(p)];(run/'drift.json').write_text(json.dumps(drift));need(not drift,'source drift: '+str(drift))
    rejected=[]
    recipes=[('missing-root',lambda a:a[0]['rootInvariants'].pop()),('root-sat',lambda a:a[0]['rootInvariants'][0].update(result='sat')),('root-unknown',lambda a:a[0]['rootInvariants'][0].update(result='unknown')),('wrong-artifact',lambda a:a[0]['adapter'].update(adapterSha256='0'*64)),('codec-missing',lambda a:a[1]['codec']['claims'].pop()),('codec-unknown',lambda a:a[1]['codec']['claims'][0].update(result='unknown')),('primitive-sat',lambda a:a[1]['primitive']['claims'][0].update(result='sat')),('missing-call-premise',lambda a:a[2]['positive'].update(obligations=428)),('negative-escaped',lambda a:a[2]['mutations'][0]['result'].update(outcome='verified')),('stale-input',lambda a:a[2].update(inputSha256='0'*64))]
    for name,mutate in recipes:
        bad=copy.deepcopy(reports);mutate(bad)
        try:validate(bad,data,sha(run/'input.json'))
        except (RuntimeError,KeyError,TypeError,ValueError):rejected.append(name)
        else:raise RuntimeError('report mutation escaped '+name)
    output={'passed':True,'endToEndVerified':False,'runId':run_id,'sourceHashes':before,'input':str(run/'input.json'),'inputSha256':sha(run/'input.json'),'stages':stages,'reports':{str(p):sha(p) for p in paths},'reportRefusals':rejected,'scope':'Shared-artifact co-validation with modeled call premises; trusted C models, memory/loader/helper/toolchain assumptions remain. No end-to-end SBF theorem.'}
    pending=run/'accepted.json';pending.write_text(json.dumps(output,indent=2)+'\n');publish=run/'publish.json';publish.write_bytes(pending.read_bytes());os.replace(publish,receipt)
    print(json.dumps({'passed':True,'runId':run_id,'reportRefusals':len(rejected),'receipt':str(receipt)}))
if __name__=='__main__':run()
