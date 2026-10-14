"""Structural fingerprints for Boolean/BV/array Z3 DAGs, including Lambdas.

Fingerprints identify syntax, not equivalence or truth. AST IDs are traversal
keys only, scoped to one invocation while strong references retain every node.
Unsupported sorts, quantifiers and declaration parameters fail explicitly.
"""
import hashlib
import json

import z3 as z

SCHEME = 'z3-dag-sha256-v1'


def fingerprint(expression):
    if not isinstance(expression, z.ExprRef):
        raise TypeError('expression required')
    nodes = {}
    hashes = {}
    sorts = {}

    def digest(value):
        return hashlib.sha256(json.dumps(value, ensure_ascii=True,
                                        separators=(',', ':')).encode()).hexdigest()

    def sort_hash(sort):
        key = sort.get_id()
        if key not in sorts:
            if sort.kind() == z.Z3_BOOL_SORT:
                description = ['bool']
            elif z.is_bv_sort(sort):
                description = ['bv', sort.size()]
            elif sort.kind() == z.Z3_ARRAY_SORT:
                if not sort.eq(z.ArraySort(sort.domain(), sort.range())):
                    raise TypeError('multidimensional array sorts are unsupported')
                description = ['array', sort_hash(sort.domain()), sort_hash(sort.range())]
            else:
                raise TypeError('unsupported fingerprint sort: ' + str(sort))
            sorts[key] = digest(description)
        return sorts[key]

    def parameter(value):
        # bool is a subclass of int; tag each parameter type explicitly.
        if type(value) is int:
            return ['int', value]
        if type(value) is str:
            return ['string', value]
        if isinstance(value, z.SortRef):
            return ['sort', sort_hash(value)]
        raise TypeError('unsupported fingerprint declaration parameter: ' + type(value).__name__)

    def children(node):
        if z.is_quantifier(node):
            if not node.is_lambda():
                raise TypeError('only Lambda binders are supported')
            return [node.body()]
        if z.is_var(node):
            return []
        if z.is_app(node):
            return list(node.children())
        raise TypeError('unsupported fingerprint node')

    stack = [(expression, False)]
    while stack:
        node, ready = stack.pop()
        key = node.get_id()
        if key in hashes:
            continue
        nodes[key] = node
        descendants = children(node)
        if not ready:
            stack.append((node, True))
            stack.extend((child, False) for child in reversed(descendants)
                         if child.get_id() not in hashes)
            continue
        child_hashes = [hashes[child.get_id()] for child in descendants]
        result_sort = sort_hash(node.sort())
        if z.is_var(node):
            description = ['bound', result_sort, z.get_var_index(node)]
        elif z.is_quantifier(node):
            description = ['lambda', result_sort,
                           [[str(node.var_name(i)), sort_hash(node.var_sort(i))]
                            for i in range(node.num_vars())], child_hashes]
        else:
            decl = node.decl()
            description = ['app', result_sort, decl.kind(), str(decl.name()),
                           [sort_hash(decl.domain(i)) for i in range(decl.arity())],
                           sort_hash(decl.range()), [parameter(p) for p in decl.params()],
                           child_hashes]
        hashes[key] = digest(description)
    return digest([SCHEME, hashes[expression.get_id()]])
