"""Specialize concrete witnesses using only explicitly pinned scalar inputs."""
import z3 as z

SPECIALIZATION = 'exact concrete input assignments; all remaining equations retained'


def specialize(formula, premises, pins):
    assignments = {}
    for pin in pins:
        left = right = None
        if z.is_eq(pin):
            a, b = pin.children()
            for variable, literal in [(a, b), (b, a)]:
                if (z.is_const(variable) and variable.decl().kind() == z.Z3_OP_UNINTERPRETED
                        and (z.is_bv_value(literal) or z.is_true(literal) or z.is_false(literal))):
                    left, right = variable, literal
                    break
        elif z.is_const(pin) and z.is_bool(pin) and pin.decl().kind() == z.Z3_OP_UNINTERPRETED:
            left, right = pin, z.BoolVal(True, ctx=pin.ctx)
        elif z.is_not(pin) and z.is_const(pin.arg(0)) and pin.arg(0).decl().kind() == z.Z3_OP_UNINTERPRETED:
            left, right = pin.arg(0), z.BoolVal(False, ctx=pin.ctx)
        if left is not None:
            previous = assignments.setdefault(left.get_id(), (left, right))
            if not z.eq(previous[1], right):
                raise ValueError('conflicting concrete witness inputs')
    pairs = list(assignments.values())
    # Substitution includes the assignments themselves and every non-assignment
    # pin. Inconsistent array predicates or other equations cannot disappear.
    combined = z.And(*premises, *pins, formula)
    grounded = z.simplify(z.substitute(combined, *pairs)) if pairs else z.simplify(combined)
    inputs = [{'name': str(a), 'value': str(b), 'sort': str(a.sort())} for a, b in pairs]
    return grounded, inputs
