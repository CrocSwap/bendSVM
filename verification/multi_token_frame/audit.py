from pathlib import Path
import hashlib,json,sys
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,str(Path(__file__).resolve().parent));import report
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
receipt_path=Path(sys.argv[1]);r=json.loads(receipt_path.read_text());assert r['passed'] is True
run=Path(r['run']);accepted=report.validate(run)
assert accepted==json.loads((run/'accepted.json').read_text())
assert r['accepted']==str(run/'accepted.json') and r['acceptedSha256']==sha(run/'accepted.json')
assert r['manifestSha256']==sha(run/'manifest.json') and r['inputSha256']==sha(run/'fixtures/input.json')
reports_path=Path(sys.argv[2]);reports=json.loads(reports_path.read_text());assert reports['passed'] is True and len(reports['probes'])==16 and all(row['accepted'] is False for row in reports['probes'])
assert reports['checkerSha256']==sha(Path(report.__file__)) and reports['contractSha256']==sha(Path(report.__file__).with_name('contract.json'))
assert reports['testSha256']==sha(Path(__file__).with_name('report-controls.py'))
process_path=Path(sys.argv[3]);process=json.loads(process_path.read_text());assert process['passed'] is True and len(process['controls'])==4
report.hashes(process['inputHashes'])
for row in process['controls']:
 d=Path(row['run']);assert sha(d/'retired-receipt.json')==row['retiredSha256']
 assert sha(d.parent/'process.log')==row['logSha256'] and not (d/'accepted.json').exists()
 assert json.loads((d/'failure.json').read_text())==row['failure'] and row['exitCode']!=0
out={'passed':True,'receipt':str(receipt_path),'receiptSha256':sha(receipt_path),'reportControls':{'path':str(reports_path),'sha256':sha(reports_path),'count':16},'processControls':{'path':str(process_path),'sha256':sha(process_path),'count':4},'auditorSha256':sha(Path(__file__)),'scope':'Source/artifact/control-inventory audit using the staged report validator; not an independent semantic proof.'}
Path(sys.argv[4]).write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
