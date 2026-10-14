"""Recompute arithmetic prerequisites, then prove complete pure handler closures."""
import hashlib,json,pathlib,sys
if not __debug__:raise RuntimeError('native handler checker requires Python assertions')
sys.path.insert(1,'verification')
import z3
import multiplication
import division_step
import native_arithmetic
from native_divmod import PROOF_INPUTS as DIVISION_INPUTS
import modular_c
from native_mul32 import PROOF_INPUTS,CLAIMS,need
sha=lambda raw:hashlib.sha256(raw).hexdigest()
from native_handler_report import SCOPE,snapshot,validate

def run(input_path,output_path):
 need(z3.get_version_string()=='5.1.0','Z3 pin')
 raw=input_path.read_bytes();data=json.loads(raw);need(data['version']==1,'input version')
 need(data['bendCommit']=='7561656155a4285c1e4ccfcb3505ab59524de973','Bend pin')
 need(snapshot(data['sourceHashes'])==data['sourceHashes'],'input source drift')
 paths={}
 for name in ['math','wide','division']:
  path=output_path.parent/(name+'.model.json');path.write_bytes(data['sourceModels'][name].encode());paths[name]=path
 prerequisite=multiplication.prove(paths['math'],paths['wide'])
 need([(c['claim'],c['result']) for c in prerequisite['claims']]==[(n,'unsat') for n in CLAIMS],'unproved multiplication prerequisite')
 proof={'bendCommit':data['bendCommit'],'positive':prerequisite,'hashes':snapshot(PROOF_INPUTS)}
 division_raw=data['sourceModels']['division'].encode()
 division_proof={'bendCommit':data['bendCommit'],'modelSha256':sha(division_raw),'division':division_step.prove_program(json.loads(division_raw)),'native':native_arithmetic.prove(),'hashes':snapshot(DIVISION_INPUTS)}
 division=division_proof['division']
 failed=[row for row in [division['step'],*division.get('induction',[]),*division.get('fastPaths',[]),*division.get('wrappers',[])] if row['result']!='unsat']
 need(not failed,'unproved division prerequisite: '+json.dumps(failed))
 native={'sourceProof':proof,'canonicalModelBytes':data['sourceModels']['math'].encode(),'divisionProof':division_proof,'divisionModelBytes':division_raw}
 results=[]
 for p in data['programs']:
  result=modular_c.check(p,native)
  need(result['passed'] is True,'unproved handler')
  results.append({'fixture':p['artifact']['fixture'],'cSha256':p['artifact']['cSha256'],'proof':result})
 need(snapshot(data['sourceHashes'])==data['sourceHashes'],'source drift during proof')
 report={'passed':True,'endToEndVerified':False,'version':2,'z3':z3.get_version_string(),'runId':data['runId'],'inputSha256':sha(raw),'sourceHashes':data['sourceHashes'],'cSyntax':data['cSyntax'],'prerequisite':proof,'divisionPrerequisite':division_proof,'results':results,'scope':SCOPE}
 validate(report,data,raw)
 output_path.write_text(json.dumps(report,indent=2)+'\n')
 print('Fresh multiplication prerequisite and all three complete handler proofs passed')
if __name__=='__main__':run(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]))
