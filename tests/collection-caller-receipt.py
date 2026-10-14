"""Actual caller parent failures. Run only through collection-caller-receipt.ts."""
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import uuid

if sys.flags.optimize:
    raise RuntimeError('receipt probes require enabled Python assertions')

assert len(sys.argv) == 3, 'private root and nonce required'
root = Path(sys.argv[1]).resolve()
assert (root/'build/.caller-receipt-private').read_text() == sys.argv[2], 'not a private receipt fixture'
assert not (root/'.git').exists(), 'refuse a checkout root'

receipt = root/'build/collection-adapter-contract-refinement.json'
prior = receipt.read_bytes()
assert json.loads(prior)['format'] == 'bend.collection-caller-paths/v3'
probe = root/'build'/('caller-receipt-probes-'+str(uuid.uuid4()))
probe.mkdir()
results = []

def run(name, script, expected):
    wrapper = probe/(name+'.sh')
    wrapper.write_text('#!/bin/sh\nif [ "$#" -eq 4 ]; then exec "$CALLER_REAL_PYTHON" "$@"; fi\n'+script+'\n')
    wrapper.chmod(0o755)
    assert not receipt.exists() or receipt.read_bytes() == prior
    receipt.write_bytes(prior)
    before = set((root/'build/collection-caller-runs').glob('*/result.pending.json'))
    env = {**os.environ,'PYTHON':str(wrapper),'CALLER_REAL_PYTHON':sys.executable}
    child = subprocess.run([str(root/'node_modules/.bin/bun'),'verification/check-collection-adapter-contract.ts'],cwd=root,env=env,capture_output=True,text=True,timeout=300)
    log = child.stdout+child.stderr
    (probe/(name+'.log')).write_text(log)
    assert child.returncode != 0 and re.search(r'^AssertionError: '+re.escape(expected)+r'$', log, re.MULTILINE), (name,child.returncode,log[-3000:])
    assert not receipt.exists(), name+': stale canonical report'
    pending = set((root/'build/collection-caller-runs').glob('*/result.pending.json'))-before
    results.append({'name':name,'exit':child.returncode,'expectedDiagnostic':expected,'pendingEvidence':[str(p) for p in pending]})
    return pending

minimal = run('minimal-forgery', '''printf '{"passed":true}\\n' > "${7}"
exit 0''','caller receipt format mismatch')
assert len(minimal) == 1

pending = run('child-pass-then-failure','''"$CALLER_REAL_PYTHON" "$@"
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi
exit 29''','Collection caller contract exited 29')
assert len(pending) == 1 and json.loads(next(iter(pending)).read_text())['passed'] is True

runtime = root/'runtime/bend_collection_runtime.h'
runtime_before = runtime.read_bytes()
try:
    pending = run('source-drift-after-child','''"$CALLER_REAL_PYTHON" "$@"
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi
printf '\\n/* receipt drift probe */\\n' >> runtime/bend_collection_runtime.h
exit 0''','child input hash binding')
    assert len(pending) == 1 and json.loads(next(iter(pending)).read_text())['passed'] is True
finally:
    runtime.write_bytes(runtime_before)

digest = hashlib.sha256(prior).hexdigest()
archive = root/'build/refinement-reports'/(digest+'.json')
assert archive.read_bytes() == prior
saved = probe/'valid-prior-archive.json'
archive.rename(saved)
try:
    archive.write_bytes(b'corrupt archive fixture\n')
    run('archive-conflict','exit 91','prior caller receipt archive conflict')
    quarantines = list(receipt.parent.glob(receipt.name+'.*.quarantine'))
    assert any(p.read_bytes() == prior for p in quarantines)
    assert archive.read_bytes() == b'corrupt archive fixture\n'
finally:
    archive.rename(probe/'corrupt-archive-fixture.txt')
    saved.rename(archive)

assert runtime.read_bytes() == runtime_before
report = {'passed':True,'nonce':sys.argv[2],'priorSha256':digest,'scope':'real parent process failures in an isolated source copy, not semantic mutation proofs','cases':results}
(probe/'report.json').write_text(json.dumps(report,indent=2)+'\n')
output = root/'build/caller-receipt-probe-result.json'
with output.open('x') as handle:
    json.dump(report,handle,indent=2)
    handle.write('\n')
print('Parent receipt probes PASS:',probe)
