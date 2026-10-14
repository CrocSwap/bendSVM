"""Restricted-C translation validation for generated canonical codecs.

The parser accepts only the reviewed codec grammar. Structural induction over
the schema DAG discharges child calls; Z3 checks per-constructor byte assembly
and bounds. This is not a general C verifier or a proof about Clang/SBF.
"""
import hashlib
import json
import pathlib
import re
import sys

import z3


class Rejected(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


TOKEN = re.compile(r'[ \t\n]+|/\*[\s\S]*?\*/|//[^\n]*|"[^"\n]*"|[A-Za-z_]\w*|[0-9]+u?|->|\+\+|!=|==|<=|<<|>>|[{}()[\];:,.&*+|=<>!#/?%^~\-]')


def clean_c(text):
    # Reject alternate physical lines, splices, trigraphs and digraphs before
    # comment removal. Only LF is a line terminator in this restricted grammar.
    require(text.isascii() and all(c in '\t\n' or 32 <= ord(c) <= 126 for c in text)
            and '\\' not in text and '??' not in text
            and not any(d in text for d in ('%:', '<:', ':>', '<%', '%>')),
            'unsupported C preprocessing or non-ASCII text')
    # Tokenization, including string literals, prevents comment markers inside
    # static-assert messages from becoming comment delimiters.
    pieces, at = [], 0
    while at < len(text):
        match = TOKEN.match(text, at)
        require(match is not None, f"unrecognized C token near {text[at:at+45]!r}")
        token = match.group()
        require(not (token == '/' and text[at:at+2] in ('/*', '//')), 'unterminated C comment')
        pieces.append(' ' if token.startswith(('/*', '//')) else token)
        at = match.end()
    return ''.join(pieces)


def lex(text):
    text = clean_c(text)
    return [m.group() for m in TOKEN.finditer(text) if not m.group().isspace()]


def directives(text, wire=False):
    text = clean_c(text)
    seen_pragma = False
    for line in text.split('\n'):
        if '#' not in line:
            continue
        if re.fullmatch(r'[ \t]*#pragma[ \t]+once[ \t]*', line):
            require(not seen_pragma, 'duplicate pragma')
            seen_pragma = True
        else:
            require(wire and re.fullmatch(r'[ \t]*#define[ \t]+[A-Za-z_]\w*_WIRE_SIZE[ \t]+(?:0|[1-9][0-9]*)u?[ \t]*', line),
                    'unsupported or non-line-isolated directive')
    require(seen_pragma, 'missing pragma')
    return text


class Parser:
    def __init__(self, text):
        self.tokens, self.at = lex(text), 0

    def take(self, text):
        tokens = lex(text)
        require(self.tokens[self.at:self.at+len(tokens)] == tokens,
                f"unexpected C at token {self.at}; expected {text!r}")
        self.at += len(tokens)

    def is_(self, text):
        tokens = lex(text)
        return self.tokens[self.at:self.at+len(tokens)] == tokens

    def ident(self):
        token = self.tokens[self.at] if self.at < len(self.tokens) else ''
        require(re.fullmatch(r'[A-Za-z_]\w*', token), 'expected C identifier')
        self.at += 1
        return token

    def number(self):
        token = self.tokens[self.at] if self.at < len(self.tokens) else ''
        require(re.fullmatch(r'(?:0|[1-9][0-9]*)u?', token), 'expected canonical decimal C constant')
        self.at += 1
        value = int(token.rstrip('u'))
        require(value <= 0xffffffff, 'C constant exceeds unsigned 32-bit range')
        return value

    def done(self):
        require(self.at == len(self.tokens), 'unconsumed C text')


def ident(name):
    # Independent implementation of the documented escape scheme; underscores
    # are escaped too. Generated identifiers are compared, not trusted.
    return 'bend_' + ''.join(c if c.isascii() and c.isalnum() else f'_{ord(c):x}_' for c in name)


def layout(schema):
    require(schema['version'] == 1, 'schema version')
    types = {t['name']: t for t in schema['types']}
    require(len(types) == len(schema['types']), 'duplicate type')
    sizes, order, busy = {}, [], set()

    def visit(name):
        require(name in types, 'unknown child type')
        if name in sizes:
            return sizes[name]
        require(name not in busy, 'recursive type')
        busy.add(name)
        t = types[name]
        if t['kind'] in ('u32', 'bool'):
            n = 4 if t['kind'] == 'u32' else 1
            require(t['cType'] == 'bend_u32', 'primitive C type')
            require((name == 'U32' and t['kind'] == 'u32' and 'max' not in t) or
                    (name == 'Nat' and t['kind'] == 'u32' and t.get('max') == 64) or
                    (name == 'Bool' and t['kind'] == 'bool' and 'max' not in t), 'unsupported primitive identity/bound')
            if 'max' in t:
                require(t['kind'] == 'u32' and type(t['max']) is int and 0 <= t['max'] <= 0xffffffff,
                        'unsupported primitive bound')
        else:
            require(t['kind'] == 'adt', 'unknown kind')
            require(t['cType'] == ident(name) + '_t', 'ADT C type')
            variants = t['variants']
            require(1 <= len(variants) <= 256, 'tag count')
            widths = []
            for i, v in enumerate(variants):
                require(v['tag'] == i and v['cMaker'] == ident(v['name']) + '_make', 'variant mapping')
                require(len({f['name'] for f in v['fields']}) == len(v['fields']), 'duplicate field')
                widths.append(1 + sum(visit(f['type']) for f in v['fields']))
            n = max(widths)
        require(1 <= n <= 1024, 'wire bound')
        sizes[name] = n
        order.append(name)
        busy.remove(name)
        return n

    for name in types:
        visit(name)
    return types, sizes, order


def parse_codecs(text, types, sizes):
    p = Parser(directives(text, wire=True))
    p.take('#pragma once')
    result = {}
    while p.at < len(p.tokens):
        p.take('#define')
        macro, size = p.ident(), p.number()
        require(macro.endswith('_WIRE_SIZE'), 'size macro')
        base = macro[:-10]
        require(base not in result, 'duplicate codec')
        matching = [t for t in types.values() if ident(t['name']) == base]
        require(len(matching) == 1, 'unknown or ambiguous codec')
        t = matching[0]
        # Require the exact storage annotation emitted for this schema-derived
        # wire size; no arbitrary attribute syntax is admitted by the parser.
        storage = 'static __attribute__((noinline)) inline' if t['kind'] == 'adt' and sizes[t['name']] >= 256 else 'static inline'
        p.take(f'{storage} int {base}_decode(const unsigned char *p, unsigned long long n, {t["cType"]} *out) {{')
        p.take('if(n!=')
        decode_size = p.number()
        p.take(')return 0;')
        item = {'size': size, 'decode_size': decode_size}
        if t['kind'] != 'adt':
            if t['kind'] == 'u32':
                p.take('*out=(bend_u32)p[0]|((bend_u32)p[1]<<8)|((bend_u32)p[2]<<16)|((bend_u32)p[3]<<24);')
                if 'max' in t:
                    p.take(f'if(*out>{t["max"]}u)return 0;')
            else:
                p.take('if(p[0]>1)return 0;*out=p[0];')
            p.take('return 1;}')
        else:
            p.take('switch(p[0]){')
            cases = []
            while p.is_('case'):
                p.take('case')
                tag = p.number()
                p.take(':{')
                fields = []
                while not p.is_('for') and not p.is_('*out'):
                    ctype, local = p.ident(), p.ident()
                    p.take(';if(!')
                    child = p.ident()
                    require(child.removesuffix('_decode') in result, 'child decoder must be defined before use')
                    p.take('(p+')
                    offset = p.number()
                    p.take(',')
                    width = p.number()
                    p.take(',&')
                    target = p.ident()
                    p.take('))return 0;')
                    fields.append((ctype, local, child, offset, width, target))
                padding = None
                if p.is_('for'):
                    p.take('for(unsigned i=')
                    begin = p.number()
                    p.take(';i<')
                    end = p.number()
                    p.take(';++i)if(p[i]!=0)return 0;')
                    padding = (begin, end)
                p.take('*out=')
                maker = p.ident()
                p.take('(')
                args = []
                if not p.is_(')'):
                    args.append(p.ident())
                    while p.is_(','):
                        p.take(',')
                        args.append(p.ident())
                p.take(');return 1;}')
                cases.append({'tag': tag, 'fields': fields, 'padding': padding, 'maker': maker, 'args': args})
            p.take('default:return 0;}}')
            item['decode'] = cases
            p.take(f'static inline int {base}_write(unsigned char *p,const {t["cType"]} *value){{switch(value->tag){{')
            cases = []
            while p.is_('case'):
                p.take('case')
                tag = p.number()
                p.take(':p[0]=')
                wire_tag = p.number()
                p.take(';')
                calls = []
                while p.is_('if'):
                    p.take('if(!')
                    child = p.ident()
                    require(child.removesuffix('_write').removesuffix('_encode') in result,
                            'child writer must be defined before use')
                    p.take('(p+')
                    offset = p.number()
                    p.take(',')
                    width = None
                    if not p.is_('&'):
                        width = p.number()
                        p.take(',')
                    p.take('&value->as.')
                    variant = p.ident()
                    p.take('.')
                    field = p.ident()
                    p.take('))return 0;')
                    calls.append((child, offset, width, variant, field))
                p.take('return 1;')
                cases.append({'tag': tag, 'wire_tag': wire_tag, 'calls': calls})
            p.take('default:return 0;}}')
            item['write'] = cases
        p.take(f'static inline int {base}_encode(unsigned char *p,unsigned long long n,const {t["cType"]} *value){{if(n!=')
        item['encode_size'] = p.number()
        p.take(')return 0;')
        if t['kind'] == 'u32':
            if 'max' in t:
                p.take(f'if(*value>{t["max"]}u)return 0;')
            p.take('for(unsigned i=0;i<4;++i)p[i]=(unsigned char)(*value>>(8*i));return 1;}')
        elif t['kind'] == 'bool':
            p.take('if(*value>1)return 0;p[0]=(unsigned char)*value;return 1;}')
        else:
            p.take('for(unsigned i=0;i<')
            item['zero_end'] = p.number()
            p.take(f';++i)p[i]=0;return {base}_write(p,value);}}')
        result[base] = item
    p.done()
    require(set(result) == {ident(name) for name in types}, 'missing codec')
    return result


def check_native(header, types):
    # Runtime functions are outside this claim. For each codec constructor we
    # require its actual declaration and exact reviewed aggregate initializer.
    tokens = lex(directives(header).replace('#pragma once', ''))
    require(not {'_Pragma', 'asm', '__asm', '__asm__'}.intersection(tokens), 'native compiler directive')
    forbidden = {ident(t['name']) + suffix for t in types.values()
                 for suffix in ('_decode', '_encode', '_write', '_WIRE_SIZE')}
    require(not forbidden.intersection(tokens), 'native header references a codec identifier')
    # Split top-level declarations/functions with balanced braces. Function
    # bodies outside constructor makers remain explicitly outside the claim.
    chunks, start, depth = [], 0, 0
    for i, token in enumerate(tokens):
        depth += (token == '{') - (token == '}')
        require(depth >= 0, 'unbalanced native declaration')
        if depth == 0 and (token == ';' or (token == '}' and tokens[start] != 'typedef')):
            chunks.append(tokens[start:i+1])
            start = i+1
    require(depth == 0 and start == len(tokens), 'incomplete native declaration')
    word = [c for c in chunks if c[0] == 'typedef' and c[-2] == 'bend_u32']
    require(word == [lex('typedef unsigned int bend_u32;')], 'unsigned native word')
    require(lex('_Static_assert(sizeof(bend_u32) == 4, "Requires 32-bit unsigned int");') in chunks,
            'native word width assertion')
    for t in types.values():
        if t['kind'] != 'adt':
            continue
        ct = t['cType']
        fields = []
        for v in t['variants']:
            members = ' '.join(f'{types[f["type"]]["cType"]} f{i};' for i, f in enumerate(v['fields'])) or 'bend_u32 unused;'
            fields.append(f'struct {{ {members} }} c{v["tag"]};')
        declaration = 'typedef struct { bend_u32 tag; union { ' + ' '.join(fields) + f' }} as; }} {ct};'
        matches = [c for c in chunks if c[0] == 'typedef' and c[-2] == ct]
        require(len(matches) == 1, f'native declaration for {ct}')
        require(matches[0] == lex(declaration), f'native field layout for {ct}')
        for v in t['variants']:
            args = ','.join(f'{types[f["type"]]["cType"]} a{i}' for i, f in enumerate(v['fields'])) or 'void'
            assignments = ','.join(f'.f{i}=a{i}' for i in range(len(v['fields']))) or '.unused=0'
            expected = f'static inline {ct} {v["cMaker"]}({args}){{return ({ct}){{.tag={v["tag"]},.as.c{v["tag"]}={{{assignments}}}}};}}'
            definitions = [c for c in chunks if v['cMaker'] in c[:c.index('{') if '{' in c else len(c)]]
            require(len(definitions) == 1 and definitions[0] == lex(expected), f'native maker {v["cMaker"]}')


def prove(formula, label, premise=True):
    solver = z3.Solver()
    solver.set(timeout=10000)
    solver.add(premise)
    require(solver.check() == z3.sat, f'{label}: infeasible or unknown premise')
    solver.add(formula)
    result = solver.check()
    require(result == z3.unsat, f'{label}: {result}' + (f' {solver.model()}' if result == z3.sat else ''))


def validate(bundle):
    require(re.fullmatch(r'[A-Za-z0-9_-]+\.h', bundle['headerName']), 'unsafe native header name')
    types, sizes, order = layout(bundle['schema'])
    include = f'#include "{bundle["headerName"]}"\n'
    require(bundle['codecs'].startswith(include), 'wire header include')
    parsed = parse_codecs(bundle['codecs'][len(include):], types, sizes)
    check_native(bundle['native'], types)
    obligations, zero_certificates = [], set()
    for name in order:
        t, n, node = types[name], sizes[name], parsed[ident(name)]
        require(node['size'] == node['decode_size'] == node['encode_size'] == n, 'exact codec size guards')
        if t['kind'] != 'adt':
            # Exact reviewed U32/Bool/Nat templates all accept zero.
            zero_certificates.add(name)
            continue
        require(node['zero_end'] == n, 'public encoder must clear the whole region')
        require([c['tag'] for c in node['decode']] == [v['tag'] for v in t['variants']], 'decoder tag coverage')
        require([c['tag'] for c in node['write']] == [v['tag'] for v in t['variants']], 'writer tag coverage')
        for v, dec, enc in zip(t['variants'], node['decode'], node['write']):
            label = f'{name} constructor {v["tag"]}'
            require(dec['maker'] == v['cMaker'] and dec['args'] == [f'f{i}' for i in range(len(v['fields']))], 'decoder constructor mapping')
            require(len(dec['fields']) == len(enc['calls']) == len(v['fields']), 'field count')
            require(enc['wire_tag'] <= 255, 'wire tag exceeds byte')
            index = z3.Int('byte_index')
            expected = z3.If(index == 0, z3.BitVecVal(v['tag'], 8), z3.BitVecVal(0, 8))
            actual = z3.If(index == 0, z3.BitVecVal(enc['wire_tag'], 8), z3.BitVecVal(0, 8))
            zero_children = []
            offset = 1
            for i, (field, read, write) in enumerate(zip(v['fields'], dec['fields'], enc['calls'])):
                require(field['type'] in zero_certificates, 'missing child zero certificate')
                child = types[field['type']]
                width = sizes[field['type']]
                child_id = ident(field['type'])
                require(read[0] == child['cType'] and read[1] == read[5] == f'f{i}' and read[2] == child_id + '_decode', 'decoder child/type/local mapping')
                require(write[0] == child_id + ('_write' if child['kind'] == 'adt' else '_encode'), 'writer child mapping')
                require(write[2] == (None if child['kind'] == 'adt' else width) and write[3:] == (f'c{v["tag"]}', f'f{i}'), 'writer field projection or width')
                require(read[4] == width, 'decoder child width')
                # This discharges the address relation used by the child
                # decoder lemma and readable/writable subregion bounds.
                prove(z3.Or(read[3] + index != offset + index,
                            write[1] + index != offset + index), f'{label}: child address relation')
                prove(z3.Or(read[3]+index < 1, read[3]+index >= n,
                            write[1]+index < 1, write[1]+index >= n), f'{label}: child bounds',
                      z3.And(index >= 0, index < width))
                data = z3.Array(f'child_{i}', z3.IntSort(), z3.BitVecSort(8))
                zero_children.append((data, z3.K(z3.IntSort(), z3.BitVecVal(0, 8))))
                expected = z3.If(z3.And(index >= offset, index < offset+width), z3.Select(data, index-offset), expected)
                actual = z3.If(z3.And(index >= write[1], index < write[1]+width), z3.Select(data, index-write[1]), actual)
                offset += width
                obligations.extend([f'{label} field {i} address relation', f'{label} field {i} bounds'])
            require(dec['padding'] == ((offset, n) if offset < n else None), 'canonical decoder padding range')
            prove(actual != expected, f'{label}: canonical byte assembly', z3.And(index >= 0, index < n))
            obligations.append(f'{label} canonical byte assembly')
            if v['tag'] == 0:
                zero_encoding = z3.substitute(actual, *zero_children) if zero_children else actual
                prove(zero_encoding != 0, f'{label}: all-zero canonical value', z3.And(index >= 0, index < n))
                obligations.append(f'{label} all-zero canonical value')
        zero_certificates.add(name)
    return {'types': len(types), 'adtTypes': sum(t['kind'] == 'adt' for t in types.values()),
            'constructors': sum(len(t.get('variants', [])) for t in types.values()),
            'z3Obligations': len(obligations), 'claims': [{'name': x, 'result': 'unsat', 'premise': 'sat'} for x in obligations],
            'maxWireBytes': max(sizes.values())}


def main():
    require(z3.get_version_string() == '5.1.0', 'Expected Z3 5.1.0')
    output = pathlib.Path(sys.argv[2])
    output.unlink(missing_ok=True)
    path = pathlib.Path(sys.argv[1])
    payload = json.loads(path.read_text())
    require(payload['fixtures'] and payload['mutations'], 'empty validation suite')
    results = [{'fixture': b['name'], **validate(b)} for b in payload['fixtures']]
    mutations = []
    for b in payload['mutations']:
        try:
            validate(b)
        except Rejected as error:
            require(b['expected'] in str(error), f'mutation {b["name"]} failed for wrong reason: {error}')
            mutations.append({'name': b['name'], 'rejection': str(error)})
        else:
            raise Rejected(f'mutation escaped: {b["name"]}')
    report = {'passed': True, 'scope': 'Restricted generated-C conformance and compositional layout checks for recorded schema instances',
              'assumptions': ['restricted C parser/checker and its reviewed semantics are trusted',
                              'unsigned bend_u32 has exactly 32 bits; unsigned char has 8 bits',
                              'p points to n readable/writable bytes; input/output/native value regions do not overlap',
                              'native values have initialized tags and active fields; invalid tags reject before union access',
                              'primitive codec semantics are discharged by verify:codec-primitives',
                              'external callers enter through encode/decode; internal writers require a zeroed region',
                              'schema corresponds to checked Bend; schema extraction is outside this claim',
                              'C compiler, SBF, loader and arbitrary native header functions are outside this claim'],
              'failureSemantics': 'decode/encode may modify local outputs before rejecting; caller must discard them',
              'formalScope': 'Z3 checks address equalities, slice bounds and conditional byte-array assembly after syntactic conformance checks; it does not execute C or prove the parser correct',
              'induction': 'dependency order; verified primitive base cases, exact child type/width/field correspondence, canonical padding, full encoder zeroing, bounded disjoint slices and checked failure propagation',
              'python': sys.version, 'z3': z3.get_version_string(), 'fixtures': results, 'mutations': mutations,
              'inputs': {str(path): hashlib.sha256(path.read_bytes()).hexdigest(),
                         'verification/codec_structures.py': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}}
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(f'Structured codecs: {len(results)} schemas, {sum(r["z3Obligations"] for r in results)} layout obligations checked, {len(mutations)} rejected C/schema mutations')


if __name__ == '__main__':
    try:
        main()
    except Rejected as error:
        raise SystemExit(str(error))
