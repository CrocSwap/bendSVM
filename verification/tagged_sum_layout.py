"""Restricted correspondence of emitted tagged-sum declarations and schema.

Checks declaration tokens, not Clang's layout algorithm or SBF memory safety.
The checked-source schema and standard C unsigned-int/struct/union semantics
remain assumptions; the emitted static assertions are required, not proved.
"""
import hashlib
import re
from tagged_sum_c import lexical_subset


def need(ok, reason):
    if not ok:
        raise ValueError('sum layout: ' + reason)


def tokens(text):
    return re.findall(r'[A-Za-z_][A-Za-z0-9_]*|[0-9]+|\S', text)


def declarations(c):
    found = {}
    for match in re.finditer(r'\btypedef\s+struct\s*\{', c):
        need(c[:match.start()].count('{') == c[:match.start()].count('}'), 'nested type declaration')
        start = match.end(); depth = 1
        for end in range(start, len(c)):
            if c[end] == '{': depth += 1
            elif c[end] == '}': depth -= 1
            if depth == 0:
                tail = re.match(r'\s*([A-Za-z_]\w*)\s*;', c[end+1:])
                need(tail is not None, 'unsupported type alias')
                name = tail[1]
                need(name not in found, 'duplicate type alias')
                found[name] = tokens(c[start:end]); break
        else:
            raise ValueError('sum layout: unterminated type declaration')
    return found


def check_layouts(artifacts):
    checks = []
    for artifact in artifacts:
        need(hashlib.sha256(artifact['c'].encode()).hexdigest() == artifact['cSha256'], 'artifact hash mismatch')
        c = lexical_subset(artifact['c'])
        need(len(re.findall(r'\btypedef\s+unsigned\s+int\s+bend_u32\s*;', c)) == 1,
             'missing unsigned 32-bit base declaration')
        need(len(re.findall(r'_Static_assert\s*\(\s*sizeof\s*\(\s*bend_u32\s*\)\s*==\s*4\s*,\s*\)\s*;', c)) == 1,
             'missing 32-bit size assertion')
        types = artifact['schema']['types']
        by_name = {t['name']:t for t in types}
        need(len(by_name) == len(types), 'duplicate schema type')
        for t in types:
            need(t['kind'] in ('u32','bool','adt'), 'unsupported schema type')
            need(re.fullmatch(r'[A-Za-z_]\w*',t['cType']) is not None, 'invalid C type identifier')
            if t['kind'] != 'adt': need(t['cType'] == 'bend_u32', 'scalar C type mismatch')
        expected = {}
        for t in types:
            if t['kind'] != 'adt': continue
            need(t['cType'] != 'bend_u32' and t['cType'] not in expected, 'aliased C types')
            need(t['variants'], 'empty variant table')
            parts = ['bend_u32 tag; union {']
            for index, v in enumerate(t['variants']):
                need(type(v['tag']) is int and v['tag'] == index, 'noncanonical variant tag')
                fields = []
                for i,f in enumerate(v['fields']):
                    need(f['type'] in by_name, 'unknown field type')
                    fields.append(by_name[f['type']]['cType']+' f'+str(i)+';')
                parts.append('struct { '+' '.join(fields or ['bend_u32 unused;'])+' } c'+str(index)+';')
            parts.append('} as;')
            expected[t['cType']] = tokens(' '.join(parts))
            assertion = r'_Static_assert\s*\(\s*sizeof\s*\(\s*'+re.escape(t['cType'])+r'\s*\)\s*<=\s*1536\s*,\s*\)\s*;'
            need(len(re.findall(assertion, c)) == 1, 'missing native bound assertion')
            checks.append({'fixture':artifact['fixture'],'type':t['name'],'cType':t['cType'],
                           'cSha256':artifact['cSha256'],'result':'MATCH'})
        need(declarations(c) == expected, 'declaration differs from schema')
    need(checks, 'empty layout check inventory')
    return checks
