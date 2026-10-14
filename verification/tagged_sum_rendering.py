"""Check recorded production renderer outputs and their occurrence in emitted C.

Input expressions and source-to-operation/continuation association are trusted.
This is a restricted textual translation check, not a C evaluator or a proof
that branch bodies implement their source continuations.
"""
from collections import Counter
import hashlib
import json
import re
from tagged_sum_c import lexical_subset


def need(ok, reason):
    if not ok:
        raise ValueError('sum rendering: ' + reason)


def normalized(lines):
    return '\n'.join(line.strip() for line in lines)


def constructor_calls(c, schema):
    names = [v['cMaker'] for t in schema['types'] if t['kind'] == 'adt' for v in t['variants']]
    need(len(names) == len(set(names)), 'duplicate constructor maker symbol')
    calls = []
    for name in names:
        for match in re.finditer(r'\b'+re.escape(name)+r'\(', c):
            line_prefix = c[c.rfind('\n', 0, match.start())+1:match.start()]
            if re.fullmatch(r'\s*static\s+inline\s+\w+\s+', line_prefix):
                continue
            depth = 1
            for end in range(match.end(), len(c)):
                if c[end] == '(':
                    depth += 1
                elif c[end] == ')':
                    depth -= 1
                if depth == 0:
                    calls.append(c[match.start():end+1]); break
            else:
                raise ValueError('sum rendering: unterminated constructor call')
    return calls


def function_bodies(c):
    pattern = r'^static (?:inline|__attribute__\(\(noinline\)\)) \w+ (\w+)\([^()]*\) \{'
    functions = {}
    for match in re.finditer(pattern, c, re.MULTILINE):
        name = match[1]
        need(name not in functions, 'duplicate emitted function')
        need(c[:match.start()].count('{') == c[:match.start()].count('}'), 'nested function definition')
        start = match.end()
        depth = 1
        for end in range(start, len(c)):
            if c[end] == '{':
                depth += 1
            elif c[end] == '}':
                depth -= 1
            if depth == 0:
                functions[name] = c[start:end]; break
        else:
            raise ValueError('sum rendering: unterminated function')
    need(functions, 'no supported functions')
    return functions


def check_renderings(artifacts, operations):
    checks = []
    offset = 0
    for artifact in artifacts:
        need(artifact['operationOffset'] == offset, 'operation offset mismatch')
        records = artifact['renderings']
        need([r['operation'] for r in records] == list(range(len(records))), 'incomplete rendering inventory')
        c = lexical_subset(artifact['c'])
        functions = function_bodies(c)
        actual_blocks, actual_calls = [], []
        for function_name, function_body in functions.items():
            actual_calls.extend((function_name, call) for call in constructor_calls(function_body, artifact['schema']))
            lines = function_body.splitlines()
            for at, line in enumerate(lines):
                if not re.fullmatch(r'\s*if \(.*\.tag == [0-9]+u\) \{', line):
                    continue
                depth = 0
                for end in range(at, len(lines)):
                    depth += lines[end].count('{') - lines[end].count('}')
                    if depth == 0:
                        actual_blocks.append((function_name, normalized(lines[at:end+1]))); break
                else:
                    raise ValueError('sum rendering: unterminated branch block')
        need(Counter(call for _, call in actual_calls) == Counter(constructor_calls(c, artifact['schema'])),
             'constructor call outside supported function')
        expected_blocks = []
        expected_calls = []
        for record in records:
            index = offset + record['operation']
            need(index < len(operations), 'extra rendering operation')
            evidence = operations[index]
            ir, family, source = (evidence[k] for k in ('ir', 'family', 'source'))
            inputs = record['inputs']
            need(isinstance(inputs, list) and len(inputs) == len(source['arguments'])
                 and all(isinstance(x, str) and x for x in inputs), 'input expression inventory')
            need(record['kind'] == ir['kind'], 'rendering kind mismatch')
            owner = record['functionName']
            need(owner in functions, 'unknown rendering function')
            if ir['kind'] == 'construct':
                need(set(record) == {'kind','operation','functionName','inputs','expression'}, 'constructor record shape')
                expected = family['variants'][ir['tag']]['maker'] + '(' + ', '.join(inputs[a['index']] for a in ir['arguments']) + ')'
                need(record['expression'] == expected, 'constructor expression differs from routing')
                expected_calls.append((owner, expected))
            else:
                need(set(record) == {'kind','operation','functionName','inputs','condition','hit','miss','block'}, 'case record shape')
                def route(ref):
                    if ref['kind'] == 'argument':
                        return inputs[ref['index']]
                    return '('+inputs[ref['argument']]+').as.c'+str(ref['tag'])+'.f'+str(ref['index'])
                expected = '('+inputs[ir['scrutinee']['index']]+').tag == '+str(ir['tag'])+'u'
                need(record['condition'] == expected, 'condition differs from routing')
                need(record['hit'] == [route(r) for r in ir['hit']], 'hit expressions differ from routing')
                need(record['miss'] == [route(r) for r in ir['miss']], 'miss expressions differ from routing')
                need(record['block'] and record['block'][0] == 'if ('+expected+') {', 'branch header mismatch')
                expected_blocks.append((owner, normalized(record['block'])))
            encoded = json.dumps(record, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
            checks.append({'fixture':artifact['fixture'], 'operation':index,
                           'renderingSha256':hashlib.sha256(encoded.encode()).hexdigest(),
                           'cSha256':artifact['cSha256'], 'result':'MATCH'})
        need(Counter(expected_calls) == Counter(actual_calls),
             'actual constructor call inventory differs from recorded calls')
        need(Counter(expected_blocks) == Counter(actual_blocks), 'actual branch block inventory differs from recorded blocks')
        offset += len(records)
    need(offset == len(operations), 'uncovered production operations')
    return checks
