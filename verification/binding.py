"""Exact checked function/type closure binding across import namespaces."""

def bind_closure(program, reference, root, prefixes):
    prefixes=sorted(prefixes.items(),key=lambda pair:len(pair[0]),reverse=True)
    def rename(value):
        if isinstance(value,str):
            for source,target in prefixes:
                if value.startswith(source):return target+value[len(source):]
            return value
        if isinstance(value,list):return [rename(v) for v in value]
        if isinstance(value,dict):return {rename(k):rename(v) for k,v in value.items() if k not in ['cType','cMaker']}
        return value
    seen=set()
    def visit(name):
        if name in seen:return
        seen.add(name)
        assert rename(program['functions'][name])==reference['functions'][rename(name)],f'Imported definition mismatch: {name}'
        def walk(term):
            if isinstance(term,dict):
                if term.get('$')=='Ref':visit(term['k'])
                for value in term.values():walk(value)
            elif isinstance(term,list):
                for value in term:walk(value)
        walk(program['functions'][name]['body'])
    visit(root)
    types={t['name']:t for t in program['schema']['types']}
    expected={t['name']:t for t in reference['schema']['types']}
    visited=set()
    def check_type(name):
        if name in visited:return
        visited.add(name)
        assert rename(types[name])==rename(expected[rename(name)]),f'Imported type mismatch: {name}'
        for variant in types[name].get('variants',[]):
            for field in variant['fields']:check_type(field['type'])
    for name in seen:
        fn=program['functions'][name]
        for type_name in [*fn['args'],fn['result']]:check_type(type_name)
    return {'root':root,'result':'checked','functions':sorted(seen),'types':sorted(visited)}
