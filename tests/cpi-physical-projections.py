"""Fresh mathematical projection-driver checks before complete caller integration.

The symbolic event fixtures here test the composition driver; actual parsed
source/caller fixtures are separately required by the public qualification.
"""
if not __debug__:
    raise RuntimeError('assertions required')
from pathlib import Path
from types import SimpleNamespace as N
import sys
sys.path.insert(0, 'verification')
import z3 as z
from cpi_physical import frame as f
from cpi_physical.projections import connect

folder = Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=False)
fields = [{'index': 0, 'stateBytes': 25}, {'index': 4, 'stateBytes': 57}]
data = [[z.BitVec('model_data_' + str(i) + '_' + str(k), 8) for k in range(next((p['stateBytes'] for p in fields if p['index'] == i), 0))] for i in range(12)]
events = []
for number, field in enumerate(fields):
    events += [N(kind='write', physicalSourceKind='local', physicalSourceName='header' + str(number), data=data[field['index']][:20]),
               N(kind='write', physicalSourceKind='local', physicalSourceName='encoded' + str(number), data=data[field['index']][20:])]
w = N(KEY=[z.BitVec('model_key_' + str(i), 256) for i in range(12)],
      OWNER=[z.BitVec('model_owner_' + str(i), 256) for i in range(12)],
      SIZE=[z.BitVec('model_size_' + str(i), 64) for i in range(12)], COUNT=z.BitVec('model_count', 64),
      SIGNER=[z.Bool('model_signer_' + str(i)) for i in range(12)],
      WRITABLE=[z.Bool('model_writable_' + str(i)) for i in range(12)],
      EXECUTABLE=[z.Bool('model_executable_' + str(i)) for i in range(12)],
      D=data, RPLY=[z.BitVec('model_reply_' + str(i), 8) for i in range(11)],
      paths=[N(events=events)], m={'fields': fields})
starts = [z.BitVec('model_start_' + str(i), 64) for i in range(12)]
capacities = [n + f.u64(10240) for n in w.SIZE]
workspace = f.Span(z.BitVec('model_workspace', 64), z.BitVec('model_workspace_size', 64))
descriptor, info = z.BitVecs('model_descriptor model_info', 64)
memories = [z.Array('model_initial', z.BitVecSort(64), z.BitVecSort(8))]
fresh, runtime, caps, active, status = [], [], [], [], []
for slot in range(2):
    fresh.append(z.Array('model_fresh_' + str(slot), z.BitVecSort(64), z.BitVecSort(8)))
    caps.append([z.Bool('model_cap_' + str(slot) + '_' + str(i)) for i in range(12)])
    active.append(z.Bool('model_active_' + str(slot)))
    status.append(z.BitVec('model_status_' + str(slot), 64))
    runtime.append(f.runtime_step(memories[-1], fresh[-1], starts, capacities, caps[-1], [workspace], active[-1]))
    after, _ = f.refresh_descriptors(runtime[-1], descriptor, info, active[-1], status[-1], w.COUNT)
    memories.append(after)
report, _ = connect(w, starts, capacities, memories, runtime, fresh, caps, active, status, workspace, descriptor, info, folder)
assert len(report['descriptorStoreInstances']) == 192
assert len(report['origins']) == 56
assert len(report['frameSelections']) == 112
assert len({q['name'] for q in report['freshProofs']}) == len(report['freshProofs'])
print('Projection ranges, workspace and both actual descriptor-store chains passed')
