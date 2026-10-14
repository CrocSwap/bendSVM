"""Bind actual helper syntax and native/SBF layout; replay semantic mutants."""
if not __debug__:
    raise RuntimeError('assertions required')
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, 'verification')
from cpi_composition import audit_executor

folder = Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=False)
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
headers = ['bend_cpi.h', 'cpi_abi.h', 'solana_min.h']
inputs = {str(Path('runtime', name)): sha(Path('runtime', name)) for name in headers}
inputs.update({p: sha(p) for p in ['tests/cpi-physical-native.c', __file__,
                                   'verification/cpi_composition.py']})
files = {name: Path('runtime', name).read_text() for name in headers}
baseline_audit = audit_executor(files)
for name in headers:
    (folder / name).write_text(files[name])
(folder / 'harness.c').write_bytes(Path('tests/cpi-physical-native.c').read_bytes())
rows = []
mutations = [
    ('baseline', None, None, 0, None),
    ('missing-refresh', 'a[i].size=infos[i].data_len;', '(void)infos[i].data_len;', 45,
     'descriptor length refresh differs'),
    ('wrong-refresh-index', 'a[i].size=infos[i].data_len;', 'a[i].size=infos[0].data_len;', 45,
     'descriptor length refresh differs'),
    ('descriptor-pointer-write', 'if(error) return error;', 'if(error) return error; a[0].data=a[1].data;', 46,
     'descriptor pointer or privilege changed'),
    ('pending-effect-write', 'if(error) return error;', 'if(error) return error; ((BendInvoke *)t)->data[0]^=1;', 47,
     'pending effect bytes changed'),
    ('ignored-error', 'if(error) return error;', '(void)error;', 44,
     'helper result differs'),
]
for name, old, new, expected_code, expected_message in mutations:
    changed = files['bend_cpi.h']
    if old:
        assert changed.count(old) == 1
        changed = changed.replace(old, new)
        try:
            audit_executor({**files, 'bend_cpi.h': changed})
        except Exception as error:
            # The same recognized grammar reason must reject every semantic
            # mutation; unrelated parse/spawn errors cannot count as controls.
            assert type(error).__name__ == 'Grammar', (name, type(error).__name__)
            assert 'executor grammar: unsupported access/control/syscall skeleton' in str(error)
            refusal = str(error)
        else:
            raise AssertionError('mutant accepted by helper audit: ' + name)
    else:
        refusal = None
    (folder / 'bend_cpi.h').write_text(changed)
    (folder / (name + '.header')).write_text(changed)
    executable = folder / name
    command = [os.environ.get('CC', 'clang'), '-std=c11', '-O1',
               '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
               '-I', str(folder), str(folder / 'harness.c'), '-o', str(executable)]
    compiled = subprocess.run(command, capture_output=True, text=True, timeout=30)
    (folder / (name + '-compile.log')).write_text(compiled.stdout + compiled.stderr)
    assert compiled.returncode == 0, (name, compiled.stderr)
    child = subprocess.run([str(executable)], capture_output=True, text=True, timeout=10)
    log = folder / (name + '.log')
    log.write_text(child.stdout + child.stderr)
    assert child.returncode == expected_code, (name, child.returncode, child.stderr)
    assert child.stderr == (expected_message + '\n' if expected_message else ''), (name, child.stderr)
    rows.append({'name': name, 'exitCode': child.returncode, 'reason': expected_message,
                 'helperGrammarRefusal': refusal, 'command': command,
                 'executable': str(executable), 'executableSha256': sha(executable),
                 'header': str(folder / (name + '.header')),
                 'headerSha256': sha(folder / (name + '.header')),
                 'log': str(log), 'logSha256': sha(log)})
(folder / 'bend_cpi.h').write_text(files['bend_cpi.h'])
# Pin layouts in a real SBF compilation as well as the sanitizer executable.
layout = folder / 'layout.c'
layout.write_text('#include "bend_cpi.h"\n#include <stddef.h>\n'
    '_Static_assert(sizeof(Account)==64 && offsetof(Account,size)==24,"Account layout");\n'
    '_Static_assert(sizeof(BendAccountInfo)==56 && offsetof(BendAccountInfo,data_len)==16,"info layout");\n'
    '_Static_assert(sizeof(BendInvoke)==464,"effect layout");\n')
llvm = Path(os.environ.get('SBF_TOOLS', str(Path.home() / '.cache/solana/v1.53/platform-tools/llvm/bin')))
compiler = llvm / 'clang'
version = subprocess.run([str(compiler), '--version'], capture_output=True, text=True, timeout=10)
assert version.returncode == 0 and '20.1.7' in version.stdout
layout_command = [str(compiler), '-target', 'sbf', '-ffreestanding', '-std=c11', '-O2',
                  '-I', str(folder), '-c', str(layout), '-o', str(folder / 'layout.o')]
compiled = subprocess.run(layout_command, capture_output=True, text=True, timeout=30)
(folder / 'layout.log').write_text(compiled.stdout + compiled.stderr)
assert compiled.returncode == 0, compiled.stderr
for path, before in inputs.items():
    assert sha(path) == before, ('source drift', path)
report = {'passed': True, 'baselineScenarios': 24, 'rows': rows, 'inputs': inputs,
          'executor': baseline_audit, 'sbfLayout': {'command': layout_command,
          'compiler': str(compiler), 'compilerSha256': sha(compiler),
          'version': version.stdout, 'object': str(folder / 'layout.o'),
          'objectSha256': sha(folder / 'layout.o')},
          'harnessSha256': sha(folder / 'harness.c'),
          'scope': __doc__ + ' Finite syscall doubles, no actual runtime permission or rollback claim.'}
(folder / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print('24 actual helper scenarios, five grammar/native mutants and SBF layout passed')
