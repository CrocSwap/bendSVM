"""Independent symbolic routing check of actual Backend.emit operations.

Values are arbitrary members of an uninterpreted sort. Family/schema and the
checked-term source description are trusted inputs. This does not interpret
C expressions, the renderer, LLVM, or SBF. A separate restricted interpreter
checks maker bodies in the emitted artifacts; its scope is recorded separately.
"""
import copy, hashlib, json, pathlib, sys
import z3
from tagged_sum_c import check_artifacts, mutation_controls
from tagged_sum_rendering import check_renderings
from tagged_sum_layout import check_layouts

U = z3.DeclareSort('OpaqueRuntimeValue')


def need(ok, why):
    if not ok:
        raise ValueError(why)


def keys(obj, names):
    need(isinstance(obj, dict) and set(obj) == set(names), 'unsupported node shape')


def index(n, size):
    need(type(n) is int and 0 <= n < size, 'index out of range')
    return n


def check(evidence):
    keys(evidence, ['family', 'source', 'ir'])
    family, source, ir = (evidence[k] for k in ('family', 'source', 'ir'))
    keys(family, ['name', 'variants'])
    keys(source, ['constructor', 'arguments'])
    need(isinstance(family['name'], str) and family['name'], 'empty family')
    variants = family['variants']
    need(isinstance(variants, list) and variants, 'empty variants')
    for v in variants:
        keys(v, ['name', 'tag', 'maker', 'fields'] + (['sourceName'] if 'sourceName' in v else []))
        need(all(isinstance(v[k], str) and v[k] for k in ('name', 'maker')), 'invalid variant name')
        need(type(v['tag']) is int, 'invalid tag type')
        need(isinstance(v['fields'], list), 'invalid fields')
        for f in v['fields']:
            keys(f, ['name', 'type'])
            need(all(isinstance(f[k], str) and f[k] for k in ('name', 'type')), 'invalid field')
        need(len({f['name'] for f in v['fields']}) == len(v['fields']), 'duplicate field')
    need(len({v['name'] for v in variants}) == len(variants), 'duplicate variant')
    names = [v.get('sourceName', v['name']) for v in variants]
    need(len(set(names)) == len(names), 'ambiguous source constructor')
    need([v['tag'] for v in variants] == list(range(len(variants))), 'noncanonical tags')
    selected = index(names.index(source['constructor']), len(variants))
    source_variant = variants[selected]
    types = source['arguments']
    need(isinstance(types, list) and all(isinstance(t, str) and t for t in types), 'bad argument types')
    need(ir['family'] == family['name'] and ir['constructor'] == source_variant['name'], 'wrong family/identity')
    index(ir['tag'], len(variants))
    args = [z3.Const('argument_'+str(i), U) for i in range(len(types))]
    tags = {i: z3.BitVec('tag_'+str(i), 32) for i,t in enumerate(types) if t == family['name']}
    fields = {(a,v['tag'],i): z3.Const(f'field_{a}_{v["tag"]}_{i}', U)
              for a in tags for v in variants for i in range(len(v['fields']))}
    assumptions = [z3.ULT(tag,z3.BitVecVal(len(variants),32)) for tag in tags.values()]

    def route(ref):
        if ref['kind'] == 'argument':
            keys(ref,['kind','index','type'])
            i=index(ref['index'],len(args))
            need(ref['type']==types[i], 'argument type mismatch')
            return args[i]
        keys(ref,['kind','argument','tag','index','type'])
        need(ref['kind']=='field', 'unsupported route')
        a=index(ref['argument'],len(args)); t=index(ref['tag'],len(variants))
        need(a in tags,'projection of nonsum argument')
        i=index(ref['index'],len(variants[t]['fields']))
        need(ref['type']==variants[t]['fields'][i]['type'],'field type mismatch')
        return fields[a,t,i]

    def differs(actual, expected):
        if len(actual)!=len(expected): return z3.BoolVal(True)
        return z3.Or(*[a!=b for a,b in zip(actual,expected)])

    if ir['kind']=='construct':
        keys(ir,['kind','family','constructor','tag','arguments'])
        need(types==[f['type'] for f in source_variant['fields']], 'source constructor arity/type mismatch')
        need(all(r.get('kind')=='argument' for r in ir['arguments']), 'constructor projection unsupported')
        bad=z3.Or(z3.BoolVal(ir['tag']!=selected),differs([route(r) for r in ir['arguments']],args))
    else:
        need(ir['kind']=='case','unsupported operation')
        keys(ir,['kind','family','constructor','tag','scrutinee','hit','miss'])
        need(types and types[0]==family['name'],'source scrutinee family mismatch')
        route(ir['scrutinee'])
        need(ir['scrutinee']['kind']=='argument' and ir['scrutinee']['index'] in tags,'invalid target scrutinee')
        source_hit=tags[0]==selected
        target_hit=tags[ir['scrutinee']['index']]==ir['tag']
        expected_hit=[fields[0,selected,i] for i in range(len(source_variant['fields']))]+args[1:]
        bad=z3.Or(source_hit!=target_hit,
            z3.And(source_hit,differs([route(r) for r in ir['hit']],expected_hit)),
            z3.And(z3.Not(source_hit),differs([route(r) for r in ir['miss']],args)))
    solver=z3.Solver();solver.set(timeout=10000);solver.add(*assumptions,bad)
    result=solver.check()
    need(result!=z3.unknown,'UNKNOWN is not a proof: '+solver.reason_unknown())
    return str(result), ({str(d):str(solver.model()[d]) for d in solver.model().decls()} if result==z3.sat else None)


def main():
    payload=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])
    need(not out.exists(),'fresh output required')
    checker_hash=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    need(z3.get_version_string()=='5.1.0','unsupported Z3 binding')
    input_bytes=payload.read_bytes()
    data=json.loads(input_bytes);need(data['version']==3,'wrong input version')
    keys(data, ['version', 'runId', 'fixtures', 'sourceHashes', 'operations', 'artifacts'])
    need(isinstance(data['operations'], list) and data['operations'], 'empty operations')
    need(isinstance(data['sourceHashes'], dict) and data['sourceHashes'], 'empty source inventory')
    for name,digest in data['sourceHashes'].items():
        need(hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==digest,'source drift: '+name)
    constructor_proofs=check_artifacts(data['artifacts'])
    layout_checks=check_layouts(data['artifacts'])
    c_mutations,c_grammar=mutation_controls(data['artifacts'])
    rendering_checks=check_renderings(data['artifacts'],data['operations'])
    unique={json.dumps(e,sort_keys=True,separators=(',',':'),ensure_ascii=False) for e in data['operations']}
    counts={'construct':0,'case':0}; proofs=[]
    for encoded in sorted(unique):
        e=json.loads(encoded); status,_=check(e);need(status=='unsat','routing counterexample: '+encoded)
        counts[e['ir']['kind']]+=1
        proofs.append({'operationSha256':hashlib.sha256(encoded.encode()).hexdigest(),'result':'UNSAT'})
    # Semantically wrong but well-formed mutations of actual emitted operations.
    cases=[e for e in data['operations'] if e['ir']['kind']=='case']
    constructors=[e for e in data['operations'] if e['ir']['kind']=='construct']
    negatives=[]
    def mutant(name,e,mutate):
        e=copy.deepcopy(e);mutate(e['ir']);status,witness=check(e)
        need(status=='sat',name+' did not produce a semantic counterexample')
        negatives.append({'name':name,'result':'SAT','witness':witness})
    e=next(e for e in cases if len(e['family']['variants'])>1)
    mutant('wrong match tag',e,lambda ir:ir.update(tag=(ir['tag']+1)%len(e['family']['variants'])))
    e=next(e for e in constructors if len(e['ir']['arguments'])>=2 and e['source']['arguments'][0]==e['source']['arguments'][1])
    mutant('swapped constructor arguments',e,lambda ir:ir['arguments'].__setitem__(slice(0,2),list(reversed(ir['arguments'][:2]))))
    e=next(e for e in cases if len(e['ir']['hit'])>=2 and all(r['kind']=='field' for r in e['ir']['hit'][:2]) and e['ir']['hit'][0]['type']==e['ir']['hit'][1]['type'])
    mutant('swapped projected fields',e,lambda ir:ir['hit'].__setitem__(slice(0,2),list(reversed(ir['hit'][:2]))))
    e=next(e for e in cases if len(e['family']['variants'])>1)
    mutant('dropped fallback scrutinee',e,lambda ir:ir['miss'].pop(0))
    for name,digest in data['sourceHashes'].items():
        need(hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==digest,'source changed during proof: '+name)
    need(hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()==checker_hash,'checker changed during proof')
    need(payload.read_bytes()==input_bytes, 'input changed during proof')
    report={'schema':3, 'layoutChecks':layout_checks, 'layoutScope':'Restricted declaration/schema correspondence; C physical layout and compiler execution assumed', 'renderingChecks':rendering_checks, 'renderingScope':'Textual C routing and exact branch-block inventory; opaque inputs and continuation association trusted; branch body semantics not proved', 'constructorCScope':'Restricted by-value maker initializers; schema/types/C layout trusted, no caller or whole-translation-unit semantics', 'constructorCProofs':constructor_proofs, 'constructorCMutations':c_mutations, 'constructorCGrammarRefusals':c_grammar, 'runId':data['runId'], 'passed':True,'checkerSha256':checker_hash,'sourceHashes':data['sourceHashes'],'scope':__doc__,'inputSha256':hashlib.sha256(payload.read_bytes()).hexdigest(),
        'z3':z3.get_version_string(),'productionInstances':len(data['operations']),'uniqueOperations':len(unique),
        'counts':counts,'proofs':proofs,'semanticMutations':negatives}
    with out.open('x') as handle:
        handle.write(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ['passed','productionInstances','uniqueOperations','counts']}))

if __name__=='__main__': main()
