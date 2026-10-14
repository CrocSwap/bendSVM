"""Conditional emitted-C caller verification over parsed execution paths and shared helper contracts."""
import json
import pathlib
import sys
import z3
import collection_contracts
import collection_caller_syntax as api
from collection_caller_paths import Paths, EntryPaths, PathFailure, check_declarations, check_run_arguments
from collection_caller_cases import candidate_cases


RUNTIME_CONTRACT = {
    'bend_collection_runtime.h': 'e4e000b47f08426e4cb7353b5edaf2cfa1e8cda0beb29838b43726c69bee3f78',
    'solana_min.h': '103aa5bd910cf4f0b29dbe8d1b956a6bb7d6cb90e79f156a17857a05b18b8b06',
}


def analyze(text, schema, interface, capture=False):
    model = api.assert_schema(schema, interface)
    model['_interface'] = interface
    check_declarations(api, text, interface)
    body = api.function_body(text, 'bend_collection_run', set())
    entry = api.function_body(text, 'entrypoint', set())
    check_run_arguments(api, body, model)
    paths = Paths(api, model)
    proofs = {'run': paths.prove(body), 'entry': EntryPaths(api, model).prove(entry)}
    return (proofs, paths.observations) if capture else proofs


def main():
    api.need(len(sys.argv) == 3, 'usage: collection_adapter_contract.py PAYLOAD OUTPUT')
    payload_path, output = map(pathlib.Path, sys.argv[1:])
    api.need(not output.exists(), 'fresh child output path required')
    api.need(z3.get_version_string() == '5.1.0', 'Z3 version must be 5.1.0')
    payload = json.loads(payload_path.read_text())
    manifest, schema, interface, source, files = api.validate_input(payload)
    api.need(set(files) == {'collection-store.c','collection-store.h','collection-store.wire.h',*RUNTIME_CONTRACT}, 'exact include closure required')
    for name, expected in RUNTIME_CONTRACT.items():
        api.need(api.hash_file(files[name]) == expected, 'runtime contract source revision mismatch: '+name)
    before = api.sha_inputs(payload, files)
    proofs, observations = analyze(source, schema, interface, capture=True)
    cases, equivalents = candidate_cases(source)
    mutations = []
    for name, changed, kind in cases:
        try:
            analyze(changed, schema, interface)
        except PathFailure as error:
            api.need(kind == 'semantic', name+': unexpected semantic rejection')
            mutations.append({'name':name,'kind':kind,'claim':error.label,'counterexample':error.model})
        except api.Grammar as error:
            api.need(kind == 'grammar', name+': unintended grammar rejection: '+str(error))
            mutations.append({'name':name,'kind':kind,'reason':str(error)})
        else:
            raise api.Fatal('mutation accepted: '+name)
    for equivalent in equivalents: analyze(equivalent, schema, interface)
    api.validate_input(payload)
    after = api.sha_inputs(payload, files)
    api.need(before == after, 'source, artifact or checker drift during proof')
    report = {
        'format':'bend.collection-caller-paths/v3', 'passed':True,
        'compositionRunId':__import__('os').environ.get('COLLECTION_COMPOSITION_RUN_ID'),
        'contractInterface':collection_contracts.CONTRACT_DOCUMENT,
        'contractInterfaceHash':collection_contracts.CONTRACT_INTERFACE_HASH,
        'artifactPaths':{suffix:str(pathlib.Path(payload[key]).resolve()) for suffix,key in {
            'collection-store.c':'adapterPath','collection-store.h':'headerPath',
            'collection-store.wire.h':'wirePath','collection-store.schema.json':'schemaPath',
            'collection-store.interface.json':'interfacePath','collection-store.manifest.json':'manifestPath'}.items()},
        'includePaths':{name:str(pathlib.Path(path).resolve()) for name,path in payload['includeFiles'].items()},
        'payloadSha256':api.hash_file(payload_path),
        'scope':'Conditional C caller paths for the exact pure ABI3 two-U32 collection fixture.',
        'obligationCounts':{k:{'instances':len(v),'distinctLabels':len(set(p['name'] for p in v))} for k,v in proofs.items()},
        'proofs':proofs, 'callObservations':observations,
        'mutations':mutations, 'equivalentVariants':len(equivalents),
        'assumptions':[
            'Input pointer and serialized allocation bounds are valid under the pinned loader contract. read_account refuses unsupported duplicate markers and produces truthful Account fields; key equality and little-endian reads have their specified byte semantics.',
            'open, codecs, select, plan and checked Bend roots are free of externally observable effects (including CPI, logging and return-data changes) before commit; each modeled stage is required to execute at most once on a path, and repeated invocations reject as unsupported. Helpers and codecs initialize only their specified outputs; failure preserves managed account data.',
            'The parsed open, select, record, plan and commit calls instantiate the shared bend.collection-helper-contracts/v1 typed AST. Successful open outputs feed select; select outputs feed record and plan; plan outputs and accepted record encoders feed commit. Exact object argument spellings are source grammar facts and are not reported as SMT pointer-equality claims. Run also assumes count=3, mode<=1 and initialize=(mode==0), discharged by the exact checked entry dispatch.',
            'The imported commit contract is no-fail under the accepted plan and writes exactly its specified collection bytes. Distinct local scratch objects, account objects and loaded account allocations are disjoint. Return-data syscall has its declared no-result ABI.',
            'Generated headers must match the fixed reviewed byte allowlist, independently of the candidate manifest. This restriction does not prove their bodies: codecs and Bend roots obey their recorded schema and type layouts by assumption. Context constructors and byte-read primitives have their specified pure semantics.',
            'The restricted parser, symbolic executor, Python interpreter, proof driver and Z3 are trusted. Scalar operations outside the modeled unsigned ABI subset reject rather than receive guessed C semantics.',
        ],
        'runtimeContractRevision':RUNTIME_CONTRACT,
        'generatedHeaderContractRevision':api.GENERATED_HEADER_CONTRACT,
        'notClaimed':['No general C memory-safety, full ABI3, LLVM/SBF, deployment or end-to-end compiler theorem.'],
        'inputs':{'before':before,'after':after,'manifest':manifest['inputs']},
    }
    output.write_text(json.dumps(report,indent=2)+'\n')
    print(f"Caller paths: {sum(map(len,proofs.values()))} UNSAT obligations, {len(mutations)} rejected mutations, {len(equivalents)} equivalent rewrites")


if __name__ == '__main__':
    try: main()
    except (api.Fatal, api.Grammar, PathFailure) as error:
        raise SystemExit('collection caller verification failed: '+str(error))
