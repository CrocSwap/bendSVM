"""Independent expected report inventories for the staged vault bridge."""
import hashlib,pathlib

def need(value,message):
    if not value:raise ValueError(message)
def digest(text):return hashlib.sha256(text.encode()).hexdigest()
def validate_input(data):
    p,f=data['program'],data['fixture'];s=p['source'];a=p['artifact']
    need(s['source']==f['source']=='examples/vault/PROOF.bend','source identity')
    need(s['roots']==[f['root']]==[f['interface']['root']]==['vault.process'],'root identity')
    need(a['fixture']==f['source'],'artifact fixture')
    need(a['c']==f['files']['vault.h'] and a['cSha256']==digest(a['c']),'native artifact identity')
    need(a['schema']==s['schema']==f['schema'],'schema identity')
    need(f['adapter']=='vault.c' and f['files']['vault.c'].startswith('#include "vault.wire.h"\n'),'adapter include')
    need(f['files']['vault.wire.h'].startswith('#include "vault.h"\n'),'codec include')
    artifacts={}
    for path,h in data['artifactHashes'].items():
        name=pathlib.Path(path).name;need(name not in artifacts,'ambiguous artifact basename');artifacts[name]=h
    need(set(artifacts)==set(f['files']),'include closure inventory')
    need(all(digest(text)==artifacts[name] for name,text in f['files'].items()),'artifact content hashes')
    need(f['interface']['stateBytes']==96 and f['interface']['instructionBytes']==35,'wire sizes')

def codec_claims(schema):
    types={t['name']:t for t in schema['types']};need(len(types)==len(schema['types']),'duplicate schema types')
    order=[];active=set();done=set()
    def visit(name):
        need(name in types and name not in active,'missing or cyclic type')
        if name in done:return
        active.add(name);t=types[name]
        for v in t.get('variants',[]):
            for f in v['fields']:visit(f['type'])
        active.remove(name);done.add(name);order.append(name)
    for name in types:visit(name)
    names=[]
    for name in order:
        for v in types[name].get('variants',[]):
            label=f'{name} constructor {v["tag"]}'
            for i,_ in enumerate(v['fields']):names.extend([f'{label} field {i} address relation',f'{label} field {i} bounds'])
            names.append(f'{label} canonical byte assembly')
            if v['tag']==0:names.append(f'{label} all-zero canonical value')
    need(len(names)==len(set(names)),'duplicate codec claim labels')
    return [{'name':n,'result':'unsat','premise':'sat'} for n in names]

PRIMITIVES=[('u32 decode of encoded value','unsat'),('u32 encoding of decoded bytes','unsat'),('u32 decode expression is little-endian','unsat'),('wrong high byte is detected','sat'),('bool accepted bytes are exactly zero or one','unsat'),('missing bool bound is detected','sat'),('Nat accepted words are exactly 0 through 64','unsat'),('missing Nat bound is detected','sat')]
CALLS=[{'kind':'decode','callee':'bend_vault_2e_State_decode','bytes':76,'output':'before','source':"('var', 'empty')"},{'kind':'decode','callee':'bend_vault_2e_State_decode','bytes':76,'output':'before','source':"('data', 0)"}]+[{'kind':'decode','callee':'bend_vault_2e_Instruction_decode','bytes':34,'output':'instruction','source':"('ix',)"}]*2+[{'kind':'root','callee':'bend_vault_2e_process'}]*2+[{'kind':'encode','callee':'bend_vault_2e_State_encode','bytes':76,'output':'encoded'}]*2
PREMISES=['bridge: root signed input is canonical Bool','bridge: state decoder succeeded before root','bridge: instruction decoder succeeded before root']
def validate_inventories(reports,data):
    validate_input(data);a,b,c=reports
    need(b['codec']['claims']==codec_claims(data['fixture']['schema']),'exact codec claim inventory')
    need([(x['name'],x['result']) for x in b['primitive']['claims']]==PRIMITIVES,'exact primitive claim inventory')
    need(c['calls']==CALLS,'exact call inventory')
    need(c['positive']['obligationKinds']==a['adapter']['obligationKinds'][:9]+PREMISES+a['adapter']['obligationKinds'][9:],'exact bridge premise inventory')
