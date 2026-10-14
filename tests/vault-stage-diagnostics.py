"""Failed proof subprocesses must retain their diagnostics and never succeed."""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile

sys.path.insert(0, 'verification')
from vault_adapter_bridge import run_stage

rows = []
with tempfile.TemporaryDirectory(prefix='vault-stage-') as temporary:
    root = pathlib.Path(temporary)
    cases = [
        ('timeout', [sys.executable, '-u', '-c',
                     'import time;print("progress before timeout",flush=True);time.sleep(30)'],
         2, subprocess.TimeoutExpired, 'progress before timeout'),
        ('exit', [sys.executable, '-u', '-c',
                  'import sys;print("specific failure",flush=True);sys.exit(7)'],
         10, RuntimeError, 'specific failure'),
        ('spawn', [str(root / 'missing-interpreter')], 10, FileNotFoundError, ''),
    ]
    for kind, command, timeout, expected_error, diagnostic in cases:
        log = root / (kind + '.log')
        try:
            run_stage(command, os.environ.copy(), log, timeout)
        except expected_error:
            pass
        else:
            raise RuntimeError('Failed subprocess was accepted: ' + kind)
        record = json.loads(log.with_suffix('.failure.json').read_text())
        assert record['passed'] is False and record['kind'] == kind
        assert diagnostic in log.read_text()
        assert record['logSha256'] == hashlib.sha256(log.read_bytes()).hexdigest()
        if kind == 'exit':
            assert record['exitCode'] == 7
        rows.append(kind)
    log = root / 'success.log'
    result = run_stage([sys.executable, '-c', 'print("completed")'], os.environ.copy(), log, 10)
    assert result['exitCode'] == 0 and log.read_text() == 'completed\n'
    assert not log.with_suffix('.failure.json').exists()
print('Vault stage diagnostics: ' + ', '.join(rows) + ' rejected with logs; success accepted')
