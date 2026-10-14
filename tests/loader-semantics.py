"""Mutate the actual qualified header; reject for the intended semantic/grammar reason."""
from pathlib import Path
import sys,json,copy,subprocess,hashlib,uuid
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from loader_report import validate,unchanged,sha
receipt=json.loads(Path('build/loader/fresh-receipt.json').read_bytes());raw=Path(receipt['inputArtifact']).read_bytes();data=json.loads(raw);report=json.loads(Path(receipt['reportArtifact']).read_bytes());validate(report,data,raw);unchanged(data)
original=Path(data['headerArtifact']).read_text();root=Path(receipt['inputArtifact']).parent/('mutants-'+str(uuid.uuid4()));root.mkdir();rows=[]
variants=[
 ('owner','a->owner = p + 40;','a->owner = p + 41;','owner-address sat'),
 ('signer','a->signer = p[1] != 0;','a->signer = p[0] != 0;','signer-flag sat'),
 ('size','a->size = read_le(p + 80, 8);','a->size = read_le(p + 72, 8);','read-bounds-rent sat'),
 ('alignment','(next + 7) & ~(u64)7','(next + 0) & ~(u64)7','rent-address sat'),
 ('duplicate','if (p[0] != 255)','if (p[0] == 0)','read-bounds-size sat'),
 ('marker-read','if (p[0] != 255)','if (p[8] != 255)','read-bounds-marker sat'),
 ('flag-read','a->signer = p[1] != 0;','a->signer = p[20000] != 0;','read-bounds-signer sat'),
 ('size-read','a->size = read_le(p + 80, 8);','a->size = read_le(p + 12000, 8);','read-bounds-size sat'),
 ('rent-read','a->data + a->size + 10240','a->data + a->size + 20480','read-bounds-rent sat'),
 ('signed-u64','typedef unsigned long long u64;','typedef signed long long u64;','header declarations/signatures'),
 ('short-size','  u64 size;','  u32 size;','header declarations/signatures'),
 ('wrong-reader-return','static inline u64 read_le','static inline u32 read_le','header declarations/signatures'),
 ('reader-initial','u64 v = 0;','u64 v = 1;','read-le8 sat'),
 ('reader-shift','<< (8 * i)','<< (7 * i)','read-le8 sat'),
 ('reader-skip','for (unsigned i = 0; i < n; ++i) v |=','for (unsigned i = 1; i < n; ++i) v |=','read_le loop'),
 ('reader-cast','v |= (u64)p[i]','v |= (u32)p[i]','v|=(u32)p[i]'),
]
for name,old,new,reason in variants:
 assert original.count(old)==1;run=root/name;run.mkdir();header=run/'solana_min.h';header.write_text(original.replace(old,new));d=copy.deepcopy(data)
 unit=run/'syntax.c';unit.write_bytes(Path(data['cSyntax']['unit']).read_bytes());log=run/'syntax.log'
 c=subprocess.run([data['cSyntax']['compiler'],'-std=c11','-fsyntax-only',str(unit)],capture_output=True,text=True,timeout=30);log.write_text(c.stdout+c.stderr);assert c.returncode==0,(name,c.stderr)
 d.update(headerArtifact=str(header),headerSha256=sha(header.read_bytes()))
 d['cSyntax'].update(unit=str(unit),unitSha256=sha(unit.read_bytes()),log=str(log),logSha256=sha(log.read_bytes()))
 input_path=run/'input.json';input_path.write_text(json.dumps(d,indent=2)+'\n');output=run/'unexpected.json'
 r=subprocess.run([sys.executable,'-B','verification/loader_model.py',str(input_path),str(output)],capture_output=True,text=True,timeout=90)
 log=run/'proof.log';log.write_text(r.stdout+r.stderr);assert r.returncode==1 and reason in r.stdout+r.stderr and not output.exists(),(name,r.stdout,r.stderr)
 rows.append({'name':name,'reason':reason,'kind':'semantic' if reason.endswith(' sat') else 'grammar','files':{str(p):sha(p.read_bytes()) for p in run.iterdir()}})
unchanged(data)
with Path(sys.argv[1]).open('x') as stream:json.dump({'passed':True,'inputSha256':receipt['inputSha256'],'reportSha256':receipt['reportSha256'],'controls':rows},stream,indent=2)
print('16 emitted-header controls passed: 11 semantic counterexamples and five grammar refusals')
