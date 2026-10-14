"""Audit fresh qualification and focused failure controls; not a proof kernel."""
from pathlib import Path
import json,sys
sys.path.insert(0,'verification')
from multi_token_composition import report
from multi_token_composition.common import sha,need
if not __debug__:raise RuntimeError('assertions required')
if len(sys.argv)!=6:raise ValueError('usage: audit.py RECEIPT REPORT_CONTROLS PROCESS_CONTROLS INPUT_CONTROLS OUTPUT')
receipt,reports_path,process_path,inputs_path,out=map(Path,sys.argv[1:])
r=json.loads(receipt.read_text());report.exact(r['passed'],True);run=Path(r['run']);accepted=report.validate(run)
report.exact(accepted,json.loads((run/'accepted.json').read_text()))
report.exact(r['accepted'],str(run/'accepted.json'));report.exact(r['acceptedSha256'],sha(run/'accepted.json'))
report.exact(r['manifestSha256'],sha(run/'manifest.json'));report.exact(r['inputSha256'],sha(run/'fixtures/input.json'))
reports=json.loads(reports_path.read_text());process=json.loads(process_path.read_text());inputs=json.loads(inputs_path.read_text())
base=Path(__file__).resolve().parent
for result in (reports,process,inputs):report.exact(result['passed'],True)
source=Path(reports['sourceRun']);report.exact(process['sourceRun'],str(source));report.exact(inputs['sourceRun'],str(source));report.validate(source)
need(run!=source,'fresh restoration must use a new qualification run')
for value in (reports,process,inputs):report.exact(value['sourceAcceptedSha256'],sha(source/'accepted.json'))
expected_reports=['missing-active-witness','missing-sequential-obligation','float-obligation','unknown-adapter-result','missing-codec-claim','missing-extraction-claim','broadened-byte-frame','missing-writable-role','missing-binding-output','scope-overclaim','numeric-pass','extra-top-key','missing-source-binding','missing-mapping','wrong-mapping-result','equal-mutated-amounts','missing-root-equivalence','missing-root-counterexample','missing-managed-failure','missing-decimals-failure','missing-custody-binding-control','unknown-custody-equivalence','wrong-custody-seed','missing-custody-grammar-control','missing-custody-success-property','missing-caller-custody-fault','unknown-caller-custody','missing-initial-view','forward-initial-reuse','missing-precommit','wrong-serialized-query-hash','missing-pda-pin','missing-snapshot-counterexample','missing-pda-guard-control','missing-native-run','missing-native-artifact','missing-sanitizer','wrong-native-fault-exit','native-scope-overclaim','manifest-extra','manifest-source-omission','manifest-child-path']
from multi_token_composition.physical_controls import NAMES as physical_controls
expected_reports+=physical_controls
report.exact([row['name'] for row in reports['controls']],expected_reports)
need(all(type(row['reason']) is str and row['reason'] for row in reports['controls']),'report controls require refusal reasons')
report.exact(reports['checkerSha256'],sha(base/'report.py'));report.exact(reports['contractSha256'],sha(base/'contract.json'));report.exact(reports['testSha256'],sha(base/'report-controls.py'))
report.exact([row['name'] for row in process['controls']],['missing-python','zero-no-report','exit42','assertions-disabled','timeout']);report.hashes(process['inputHashes'])
for row in process['controls']:
 d=Path(row['run']);report.exact(sha(d/'retired-receipt.json'),row['retiredSha256']);report.exact(sha(d.parent/'process.log'),row['logSha256'])
 report.exact(json.loads((d/'failure.json').read_text()),row['failure']);report.exact(row['failure']['passed'],False)
 need(row['exitCode']!=0 and not (d/'accepted.json').exists() and not (d.parent/'fresh-receipt.json').exists() and not (d.parent/'fresh-receipt.pending.json').exists(),'failed process published evidence')
 report.exact(json.loads((d/'retired-receipt.json').read_text())['acceptedSha256'],sha(source/'accepted.json'))
report.hashes(inputs['inputHashes'])
report.exact([row['name'] for row in inputs['controls']],['missing-fixture','native-header-mismatch','source-root-mismatch','source-schema-mismatch','native-digest-mismatch','missing-artifact-path','unbound-source','positive-pins','invalid-fault-unknown','invalid-fault-managed-byte','same-input-output'])
need(all(type(row['reason']) is str and row['reason'] for row in inputs['controls']),'input controls require refusal reasons')
need((run/'accepted.json').stat().st_mtime_ns>=max(p.stat().st_mtime_ns for p in (reports_path,process_path,inputs_path)),'restoration must follow controls')
value={'passed':True,'receipt':str(receipt),'receiptSha256':sha(receipt),'reportControls':{'path':str(reports_path),'sha256':sha(reports_path),'count':len(expected_reports)},'processControls':{'path':str(process_path),'sha256':sha(process_path),'count':5},'inputControls':{'path':str(inputs_path),'sha256':sha(inputs_path),'count':11},'auditorSha256':sha(Path(__file__)),'scope':'Qualification, source/artifact and exact failure-control inventory audit using the maintained validator; not independent semantic verification.'}
out.parent.mkdir(parents=True,exist_ok=True)
pending=out.with_name(out.name+'.pending');pending.write_text(json.dumps(value,indent=2)+'\n');pending.replace(out);print(json.dumps(value))
