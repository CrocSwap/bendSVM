"""Restricted interpretation of constructor maker bodies in actual emitted C.

The schema and C type correspondence are trusted. Only the accepted by-value,
side-effect-free initializer grammar is modeled. C layout, expression callers,
Clang and SBF execution are not proved here.
"""
import hashlib
import re
import z3


def need(ok, why):
    if not ok:
        raise ValueError('constructor C: ' + why)


def lexical_subset(c):
    need(c.isascii() and all(ch in '\t\n' or 32 <= ord(ch) <= 126 for ch in c),
         'unsupported C control or non-ASCII character')
    need(not any(token in c for token in ('%:', '<:', ':>', '<%', '%>')),
         'unsupported C digraph')
    prefix = '/* Generated from checked Bend terms. Do not edit. */'
    need(c.startswith(prefix), 'missing generated C prefix')
    c = c[len(prefix):]
    # The selected artifacts need no comments, escapes, character literals or
    # macros. Reject them instead of matching a fake definition inside one.
    need('/*' not in c and '//' not in c and '\\' not in c and "'" not in c
         and '??' not in c, 'unsupported C lexical form')
    c = re.sub(r'"[^"\n]*"', lambda m: ' ' * len(m[0]), c)
    need('"' not in c, 'unterminated C string')
    directives = re.findall(r'^\s*#.*$', c, re.MULTILINE)
    need([d.strip() for d in directives] == ['#pragma once'], 'unsupported preprocessing')
    c = c.replace('#pragma once', '')
    need('#' not in c, 'unsupported preprocessing token')
    return c


def body(c, maker):
    c = lexical_subset(c)
    pattern = r'\bstatic\s+inline\s+(\w+)\s+' + re.escape(maker) + r'\s*\(([^()]*)\)\s*\{'
    matches = list(re.finditer(pattern, c))
    need(len(matches) == 1, 'missing or duplicate maker: ' + maker)
    match = matches[0]
    start = match.end()
    depth = 1
    for end in range(start, len(c)):
        if c[end] == '{':
            depth += 1
        elif c[end] == '}':
            depth -= 1
        if depth == 0:
            return match.group(1), match.group(2), c[start:end]
    raise ValueError('constructor C: unterminated maker')


def prove_maker(c, type_, variant, types):
    ctype, parameters, text = body(c, variant['cMaker'])
    need(ctype == type_['cType'], 'return type mismatch')
    expected = [(types[f['type']]['cType'], 'a'+str(i)) for i, f in enumerate(variant['fields'])]
    parsed = [] if parameters.strip() == 'void' else [p.strip().split() for p in parameters.split(',')]
    need([tuple(p) for p in parsed] == expected, 'parameter type/order mismatch')
    # Decimal only: rejecting octal/hex/suffixes is an explicit grammar limit.
    decimal = r'(0|[1-9][0-9]*)'
    pattern = r'\s*return\s*\(\s*' + re.escape(ctype) + r'\s*\)\s*\{\s*\.tag\s*=\s*' + decimal
    pattern += r'\s*,\s*\.as\.c' + decimal + r'\s*=\s*\{([^{}]*)\}\s*\}\s*;\s*'
    match = re.fullmatch(pattern, text)
    need(match is not None, 'unsupported maker body')
    tag, union_tag = int(match[1]), int(match[2])
    initializer = match[3].strip()
    count = len(expected)
    assignments = {}
    if not count:
        need(re.fullmatch(r'\.unused\s*=\s*0', initializer) is not None, 'empty variant initializer')
    else:
        for item in initializer.split(','):
            assignment = re.fullmatch(r'\s*\.f'+decimal+r'\s*=\s*a'+decimal+r'\s*', item)
            need(assignment is not None, 'unsupported field assignment')
            dest, source = int(assignment[1]), int(assignment[2])
            need(dest < count and source < count and dest not in assignments, 'invalid field assignment')
            need(expected[dest][0] == expected[source][0], 'ill-typed field assignment')
            assignments[dest] = source
        need(set(assignments) == set(range(count)), 'incomplete field assignments')
    value = z3.DeclareSort('MakerValue')
    args = [z3.Const('maker_argument_'+str(i), value) for i in range(count)]
    bad = z3.Or(z3.BoolVal(tag != variant['tag']), z3.BoolVal(union_tag != variant['tag']),
                *[args[assignments[i]] != args[i] for i in range(count)])
    solver = z3.Solver(); solver.set(timeout=10000); solver.add(bad)
    result = solver.check()
    need(result != z3.unknown, 'UNKNOWN is not a proof: ' + solver.reason_unknown())
    witness = ({str(d): str(solver.model()[d]) for d in solver.model().decls()}
               if result == z3.sat else None)
    return str(result), witness


def check_artifacts(artifacts):
    need(isinstance(artifacts, list) and artifacts, 'empty artifact inventory')
    proofs = []
    for artifact in artifacts:
        schema = artifact['schema']
        need(schema['version'] == 1, 'unsupported schema')
        types = {t['name']: t for t in schema['types']}
        need(len(types) == len(schema['types']), 'duplicate schema type')
        c = artifact['c']
        need(hashlib.sha256(c.encode()).hexdigest() == artifact['cSha256'], 'artifact hash mismatch')
        for type_ in schema['types']:
            if type_['kind'] != 'adt':
                continue
            for index, variant in enumerate(type_['variants']):
                need(variant['tag'] == index, 'noncanonical variant tags')
                status, witness = prove_maker(c, type_, variant, types)
                need(status == 'unsat', 'maker counterexample: ' + variant['cMaker'] + ' ' + str(witness))
                proofs.append({'fixture': artifact['fixture'], 'maker': variant['cMaker'],
                               'cSha256': artifact['cSha256'], 'result': 'UNSAT'})
    need(proofs, 'no constructor proofs')
    return proofs


def mutation_controls(artifacts):
    candidates = [(a, t, v) for a in artifacts for t in a['schema']['types']
                  if t['kind'] == 'adt' for v in t['variants']]
    a, t, v = next((a, t, v) for a, t, v in candidates
                   if len(v['fields']) >= 2 and v['fields'][0]['type'] == v['fields'][1]['type'])
    c = a['c']; types = {t['name']: t for t in a['schema']['types']}
    _, _, original = body(c, v['cMaker'])
    mutations = [
        ('wrong maker tag', re.sub(r'\.tag\s*=\s*[0-9]+', '.tag = '+str(v['tag']+1), original, count=1)),
        ('wrong maker union member', re.sub(r'\.as\.c[0-9]+', '.as.c'+str(v['tag']+1), original, count=1)),
        ('swapped maker fields', original.replace('.f0 = a0', '.f0 = a1').replace('.f1 = a1', '.f1 = a0')),
    ]
    controls = []
    for name, changed in mutations:
        need(changed != original, 'ineffective mutation ' + name)
        status, witness = prove_maker(c.replace(original, changed, 1), t, v, types)
        need(status == 'sat', 'missing semantic counterexample: ' + name)
        controls.append({'name': name, 'result': 'SAT', 'witness': witness})
    grammar = [
        ('extra maker statement', 'side_effect();'+original),
        ('octal maker tag', re.sub(r'\.tag\s*=\s*[0-9]+', '.tag = 010', original, count=1)),
        ('incomplete maker fields', original.replace('.f0 = a0, ', '', 1)),
    ]
    refusals = []
    for name, changed in grammar:
        need(changed != original, 'ineffective grammar mutation ' + name)
        try:
            prove_maker(c.replace(original, changed, 1), t, v, types)
        except ValueError as error:
            refusals.append({'name': name, 'result': 'REJECTED', 'reason': str(error)})
        else:
            raise ValueError('constructor C: unsupported grammar accepted: ' + name)
    return controls, refusals
