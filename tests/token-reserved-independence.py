"""Reserved-input independence: actual validator mutation and lemma failures."""
from pathlib import Path
import hashlib
import json
import sys
import uuid

if not __debug__:
    raise RuntimeError('reserved independence tests require assertions')
sys.path.insert(0, 'verification')
from token_semantics import Validation
import token_validate as token

assert token.z3.get_version_string() == '5.1.0'
paths = [Path('runtime') / name for name in ('token.h', 'cpi_abi.h', 'solana_min.h')]
paths += [Path(__file__), Path('verification/token_semantics.py'), Path('verification/token_validate.py')]
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
inputs = {str(path): sha(path) for path in paths}
files = {path.name: path.read_text() for path in paths[:3]}
positive = Validation(files).verify_reserved()
assert positive['result'] == 'unsat'
controls = []

def refuse(name, operation, reason):
    try:
        operation()
    except (AssertionError, RuntimeError) as error:
        assert reason in str(error), (name, str(error))
        controls.append({'name': name, 'reason': str(error)})
    else:
        raise AssertionError('accepted ' + name)

changed = dict(files)
old = 't->mint < 4'
assert changed['token.h'].count(old) == 1
changed['token.h'] = changed['token.h'].replace(old, 't->mint < 3')
refuse('actual-validator-reads-reserved-mint',
       lambda: Validation(changed).verify_reserved(), 'expected unsat, got sat')

source = Path('verification/token_semantics.py').read_text()
old = 'z3.UGE(index, token.bv(4))'
assert source.count(old) == 1
namespace = {}
exec(compile(source.replace(old, 'z3.UGE(index, token.bv(3))'),
             'incorrect-reserved-frame-lemma', 'exec'), namespace)
refuse('incorrect-read-frame-lemma',
       lambda: namespace['Validation'](files).verify_reserved(), 'expected unsat, got sat')

original_solve = token.solve
def unknown(*args, **kwargs):
    raise RuntimeError('Z3 unknown: injected reserved lemma control')
try:
    token.solve = unknown
    refuse('unknown-lemma', lambda: Validation(files).verify_reserved(), 'Z3 unknown:')
finally:
    token.solve = original_solve

assert all(sha(Path(path)) == digest for path, digest in inputs.items())
root = Path('build/token-reserved-independence') / str(uuid.uuid4())
root.mkdir(parents=True)
report = {'passed': True, 'positive': positive, 'controls': controls, 'inputs': inputs}
(root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print('Reserved independence and three failure controls passed:', root / 'report.json')
