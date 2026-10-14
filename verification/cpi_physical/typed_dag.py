"""Structural fingerprints also covering checked acyclic datatype values.

Fingerprints identify syntax, not equivalence or truth. AST IDs are traversal
keys only, scoped to one invocation while strong references retain every node.
Unsupported sorts, quantifiers and declaration parameters fail explicitly.
"""
import hashlib
import json

import z3 as z

SCHEME = 'z3-typed-dag-sha256-v1'


class Fingerprints:
    """One-context cache retaining all node references for its entire lifetime."""
    def __init__(self):
        self.context = None
        self.nodes, self.hashes, self.sorts, self.datatype_names = {}, {}, {}, {}

    def __call__(self, expression):
        if not isinstance(expression, z.ExprRef):
            raise TypeError('expression required')
        if self.context is None:
            self.context = expression.ctx
        if expression.ctx is not self.context:
            raise ValueError("fingerprint session context differs")
        nodes, hashes, sorts = self.nodes, self.hashes, self.sorts
        active_sorts = set()
        datatype_names = self.datatype_names

        def digest(value):
            return hashlib.sha256(json.dumps(value, ensure_ascii=True,
                                            separators=(',', ':')).encode()).hexdigest()

        def sort_hash(sort):
            key = sort.get_id()
            if key not in sorts:
                if key in active_sorts:
                    raise TypeError('recursive datatype fingerprint is unsupported')
                active_sorts.add(key)
                if sort.kind() == z.Z3_BOOL_SORT:
                    description = ['bool']
                elif z.is_bv_sort(sort):
                    description = ['bv', sort.size()]
                elif sort.kind() == z.Z3_ARRAY_SORT:
                    if not sort.eq(z.ArraySort(sort.domain(), sort.range())):
                        raise TypeError('multidimensional array sorts are unsupported')
                    description = ['array', sort_hash(sort.domain()), sort_hash(sort.range())]
                elif sort.kind() == z.Z3_DATATYPE_SORT:
                    name = str(sort.name())
                    previous = datatype_names.setdefault(name, sort)
                    if not previous.eq(sort):
                        raise TypeError('ambiguous datatype name: ' + name)
                    constructors = []
                    for i in range(sort.num_constructors()):
                        constructor = sort.constructor(i)
                        fields = [[str(sort.accessor(i, j).name()), sort_hash(constructor.domain(j))]
                                  for j in range(constructor.arity())]
                        constructors.append([str(constructor.name()), str(sort.recognizer(i).name()), fields])
                    description = ['datatype', name, constructors]
                else:
                    raise TypeError('unsupported fingerprint sort: ' + str(sort))
                sorts[key] = digest(description)
                active_sorts.remove(key)
            return sorts[key]

        def parameter(value):
            # bool is a subclass of int; tag each parameter type explicitly.
            if type(value) is int:
                return ['int', value]
            if type(value) is str:
                return ['string', value]
            if isinstance(value, z.SortRef):
                return ['sort', sort_hash(value)]
            if isinstance(value, z.FuncDeclRef):
                return ['declaration', value.kind(), str(value.name()),
                        [sort_hash(value.domain(i)) for i in range(value.arity())],
                        sort_hash(value.range()), [parameter(p) for p in value.params()]]
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


def fingerprint(expression):
    return Fingerprints()(expression)
