"""Compose the parsed CPI validator fact with actual emitted ABI2 adapters.

The component checkers remain separate. This gate re-parses fresh compiler
artifacts, removes the multi-adapter CPI count assumptions, and instantiates the
parsed helper theorem on the exact expressions observed at each validator call
before proving the emitted managed-meta obligations. It does not establish a
whole-program or transaction theorem.
"""
import hashlib
import copy
import importlib
import json
import os
import pathlib
import sys
import time

import z3


HERE = pathlib.Path(__file__).resolve().parent
CHECKER_FILES = (
    HERE / "cpi_adapter_composition.py",
    HERE / "check-cpi-adapter-composition.ts",
)
REUSED_FILES = (
    "verification/multi_adapter_contract.py",
    "verification/adapter_contract_c.py",
    "verification/adapter_contract_sym.py",
    "verification/effect_extraction.py",
    "verification/cpi_composition.py",
    "verification/cpi_validate.py",
    "verification/check-multi-adapter-contract.ts",
    "verification/check-cpi-composition.ts",
    "compiler/backend.ts",
    "compiler/artifacts.ts",
    "compiler/multi-storage.ts",
    "compiler/storage.ts",
    "compiler/schema.ts",
    "compiler/effects.ts",
    "compiler/cpi-effects.ts",
    "compiler/collection-storage.ts",
    "compiler/codecs.ts",
    "compiler/dispatch.ts",
    "compiler/resources.ts",
    "compiler/diagnostics.ts",
    "compiler/primitives.ts",
    "compiler/native-arithmetic.ts",
    "compiler/tagged-sum-ir.ts",
    "runtime/bend_cpi.h",
    "runtime/cpi_abi.h",
    "runtime/solana_min.h",
)
REQUIRED = ("cpi-2", "cpi-3", "cpi-4")


class Fatal(RuntimeError):
    """Missing, incomplete or unknown evidence; never a successful result."""


class BridgeSemantic(Exception):
    def __init__(self, label, witness):
        super().__init__(label)
        self.label = label
        self.witness = witness


def need(ok, message):
    if not ok:
        raise Fatal(message)


def sha(data):
    if isinstance(data, pathlib.Path):
        data = data.read_bytes()
    elif isinstance(data, str):
        data = data.encode()
    return hashlib.sha256(data).hexdigest()


def hashes(paths):
    return {str(path.resolve()): sha(path) for path in paths}


def source_hashes(source_root):
    return {
        str((source_root / relative).resolve()): sha(source_root / relative)
        for relative in REUSED_FILES
    }


def verify_hashes(expected, label):
    for name, digest in expected.items():
        path = pathlib.Path(name)
        need(path.is_file(), f"{label}: missing input {name}")
        need(sha(path) == digest, f"{label}: input changed: {name}")


def load_reused(source_root):
    # Use the caller-selected source root (main for this isolated run, the
    # current tree after integration) without copying or editing its sources.
    sys.path.insert(0, str(source_root / "verification"))
    multi = importlib.import_module("multi_adapter_contract")
    cpi_composition = importlib.import_module("cpi_composition")
    cpi_validate = importlib.import_module("cpi_validate")
    return multi, cpi_composition, cpi_validate


class CompositionExec:
    """Observe real helper calls and effect member reads in MultiExec."""

    def __new__(cls, world):
        multi = cls.multi

        class Observer(multi.MultiExec):
            def __init__(self, w):
                super().__init__(w)
                self.effect_reads = []
                self.meta_reads = []
                self.effect_array_writes = []
                self.loop_bounds = []
                self.loop_stack = []
                self.next_loop_id = 0
                self.account_field_reads = []

            @staticmethod
            def loop_names(st):
                return tuple(sorted(
                    name
                    for scope in st.scopes
                    for name, (_, info) in scope.items()
                    if len(info) > 4 and info[4]
                ))

            def index(self, base, index, st, guard):
                value = super().index(base, index, st, guard)
                if isinstance(base, self.multi.Ref) and base.path[0] == "var":
                    _, array, _ = self.array(st, base.path[1])
                    if array.kind == "effects" and isinstance(value, self.multi.Obj):
                        value.origin_array = base.path[1]
                elif isinstance(base, self.multi.Obj) and base.kind == "metas":
                    if isinstance(value, self.multi.Obj) and value.kind == "meta":
                        value.origin_array = getattr(base, "origin_array", None)
                return value

            def member(self, base, name, st, guard):
                value = super().member(base, name, st, guard)
                if isinstance(base, self.multi.Obj) and base.kind == "account":
                    self.account_field_reads.append({
                        "account": base.f[0],
                        "field": name,
                        "afterExecution": any(event.kind == "execute" for event in st.events),
                        "pc": st.pc,
                    })
                if isinstance(base, self.multi.Obj) and base.kind == "effect":
                    if name in ("active", "count"):
                        self.effect_reads.append({
                            "array": getattr(base, "origin_array", None),
                            "source": base.f[0],
                            "slot": base.f[1],
                            "field": name,
                            "loopNames": self.loop_names(st),
                            "loopIds": tuple(loop_id for loop_id, _ in self.loop_stack),
                            "value": value.e if isinstance(value, self.multi.Int) else None,
                            "pc": st.pc,
                        })
                    elif name == "metas":
                        value.origin_array = getattr(base, "origin_array", None)
                elif isinstance(base, self.multi.Obj) and base.kind == "meta":
                    if name in ("index", "writable"):
                        self.meta_reads.append({
                            "array": getattr(base, "origin_array", None),
                            "source": base.f[0],
                            "slot": base.f[1],
                            "index": base.f[2],
                            "field": name,
                            "loopNames": self.loop_names(st),
                            "loopIds": tuple(loop_id for loop_id, _ in self.loop_stack),
                            "value": value.e if isinstance(value, self.multi.Int) else None,
                            "pc": st.pc,
                        })
                return value

            def loop(self, statement, st):
                loop_id = self.next_loop_id
                self.next_loop_id += 1
                if statement[0] == "for":
                    _, variable, _, condition, _ = statement
                    if condition[0] == "bin" and condition[1] == "<" \
                            and condition[2] == ("id", variable):
                        try:
                            bound = self.ev(condition[3], st)
                        except (self.multi.Grammar, self.multi.Dead):
                            bound = None
                        if isinstance(bound, self.multi.Int):
                            self.loop_bounds.append({
                                "id": loop_id,
                                "variable": variable,
                                "value": bound.e,
                                "loopNames": self.loop_names(st),
                                "pc": st.pc,
                            })
                self.loop_stack.append((loop_id, variable if statement[0] == "for" else ""))
                try:
                    return super().loop(statement, st)
                finally:
                    self.loop_stack.pop()

            def stmt(self, statement, st):
                if statement[0] == "assign" and statement[1] == "transfers":
                    self.effect_array_writes.append(statement)
                return super().stmt(statement, st)

            def ev(self, expression, st, guard=True, top=False):
                value = super().ev(expression, st, guard, top)
                if expression[0] == "call" and expression[1] in (
                    self.m["custody"], self.m["validate"], self.m["execute"]
                ):
                    kind = {
                        self.m["custody"]: "custody",
                        self.m["validate"]: "validate",
                        self.m["execute"]: "execute",
                    }[expression[1]]
                    need(st.events and st.events[-1].kind == kind,
                         "observer: helper call did not produce its expected event")
                    st.events[-1].f["callArguments"] = expression[2]
                return value

            def call_custody(self, name, args, st, guard):
                before = len(st.events)
                value = super().call_custody(name, args, st, guard)
                need(len(st.events) == before + 1 and st.events[-1].kind == "custody",
                     "observer: missing custody event")
                event = st.events[-1]
                event.f.update(
                    accountArray=args[0].path[1] if isinstance(args[0], self.multi.Ref) else None,
                    bumpOutput=args[2].path if isinstance(args[2], self.multi.Ref) else None,
                )
                return value

            def call_validate(self, name, args, st, guard):
                before = len(st.events)
                value = super().call_validate(name, args, st, guard)
                need(len(st.events) == before + 1 and st.events[-1].kind == "validate",
                     "observer: missing validation event")
                event = st.events[-1]
                event.f.update(
                    accountArray=args[1].path[1] if isinstance(args[1], self.multi.Ref) else None,
                    effectRef=args[0].path if isinstance(args[0], self.multi.Ref) else None,
                    result=value.e if isinstance(value, self.multi.Int) else None,
                )
                return value

            def call_execute(self, name, args, st, guard):
                before = len(st.events)
                value = super().call_execute(name, args, st, guard)
                need(len(st.events) == before + 1 and st.events[-1].kind == "execute",
                     "observer: missing execution event")
                event = st.events[-1]
                event.f.update(
                    accountArray=args[1].path[1] if isinstance(args[1], self.multi.Ref) else None,
                    effectRef=args[0].path if isinstance(args[0], self.multi.Ref) else None,
                    result=value.e if isinstance(value, self.multi.Int) else None,
                )
                return value

        Observer.multi = multi
        return Observer(world)


def parse_actual_adapter(multi, m, fixture, proven_cpi_validation_premises=()):
    CompositionExec.multi = multi
    adapter = fixture["adapter"]
    files = fixture["files"]
    dependencies, wire = multi.audit_dependencies(m, adapter, files)
    accepted = next(v for v in m["_schema"]["types"] if v["name"] == m["result_name"])
    accepted_variant = next(v for v in accepted["variants"] if v["tag"] == m["accepted"])
    effects_type_name = accepted_variant["fields"][1]["type"]
    effect_c = m["types"][m["effect_type"]]["cType"]
    effects_c = m["types"][effects_type_name]["cType"]
    body_tokens = multi.extract_entrypoint(
        files[adapter], wire, m["effect_header"], m["effects"],
        effect_c, effects_c, m["slot_type"])
    parser_types = {
        "u8", "u32", "u64", "unsigned", "Account", "BendClock",
        *[t["cType"] for t in m["types"].values() if t["kind"] == "adt"],
        m["slot_type"],
    }
    parser = multi.MultiParser(body_tokens, parser_types)
    body = []
    while parser.peek() != "}":
        need(parser.peek() != "", "syntax: unterminated entrypoint")
        body.append(parser.statement())
    parser.take("}")
    need(parser.at == len(body_tokens), "syntax: unparsed entrypoint token")
    world = multi.MultiWorld(
        m,
        include_cpi_validation_assumptions=False,
        proven_cpi_validation_premises=proven_cpi_validation_premises,
    )
    world.multi = multi
    audit_world_axioms(world)
    executor = CompositionExec(world)
    raw_paths = executor.run(body)
    audit_world_axioms(world)
    return world, executor, raw_paths, dependencies


def model_witness(world, formula, label):
    sat, solver = world.feasible(formula)
    if not sat:
        return None
    model = solver.model()
    return {
        "label": label,
        "model": world.describe(model),
        "completeModel": world.multi.complete_model(model),
    }


def record_bridge_query(world, label, formula):
    if not hasattr(world, 'bridge_queries'):
        world.bridge_queries = []
    world.bridge_queries.append({'name': label, 'result': 'unsat',
                                 'querySha256': sha(formula.sexpr())})


def required_bridge_queries(slots):
    return [
        "bridge: execution reachable before every validation returned zero",
        "bridge: validator/executor arguments differ from each other or the parsed loader count",
        "bridge: executor bump differs from the successful custody output",
        "bridge: a reached validator call is outside caller account_count 4..12",
    ] + [name for slot in range(slots) for name in (
        f"bridge: slot {slot} helper return instantiation",
        f"bridge: slot {slot} meta loop bound is not its own extracted effect count",
        f"bridge: slot {slot} meta reads lack the validated active count bound",
    )]


def require_unsat(world, formula, label, premises=()):
    witness = model_witness(world, z3.And(*premises, formula), label)
    if witness is not None:
        raise BridgeSemantic(label, witness)
    record_bridge_query(world, label, z3.And(*premises, formula))
    return {"name": label, "result": "unsat"}


def structural_counterexample(world, label, observations=None, formula=None):
    paths = sorted(
        world.paths,
        key=lambda path: (
            sum(event.kind == "execute" for event in path.events),
            sum(event.kind == "validate" for event in path.events),
        ),
        reverse=True,
    )
    for path in paths:
        if formula is not None and callable(formula):
            additional = formula(path)
        else:
            additional = z3.BoolVal(True) if formula is None else formula
        sat, solver = world.feasible(z3.And(path.pc, additional))
        if sat:
            model = solver.model()
            return {
                "label": label,
                "model": world.describe(model),
                "completeModel": world.multi.complete_model(model),
                "observations": observations or {},
                "parsedCallTrace": [
                    {
                        "kind": event.kind,
                        "slot": getattr(event, "slot", None),
                        "accountArray": getattr(event, "accountArray", None),
                        "effectRef": getattr(event, "effectRef", None),
                        "source": getattr(event, "src", None),
                        "count": str(getattr(event, "count", "")),
                    }
                    for event in path.events
                    if event.kind in ("custody", "validate", "execute")
                ],
            }
    raise Fatal(f"{label}: no reachable parsed path for the structural mismatch")


def z3_equal(left, right):
    return z3.is_true(z3.simplify(left == right))


def same_formulas(actual, expected):
    return len(actual) == len(expected) and all(
        z3.eq(left, right) for left, right in zip(actual, expected)
    )


def expected_cpi_assumptions(world):
    src = (world.m["accepted"], 1)
    return [z3.Implies(
        z3.And(world.VAL[slot] == z3.BitVecVal(0, 64),
               world.eff(src, slot, "active") != z3.BitVecVal(0, 32)),
        z3.ULE(world.eff(src, slot, "count"), z3.BitVecVal(8, 32)))
        for slot in range(world.m["slots"])]


def audit_world_axioms(world):
    """Require the entire axiom list, not just presence of named implications.

    The only base axioms in this restricted model relate viewed key bytes to
    key equality. Reconstruct those explicitly rather than calling a base
    method that could acquire an unnoticed new assumption.
    """
    actual = world.axioms()
    seen = sorted(world.viewed)
    base = [(world.KEY[i] == world.KEY[j]) == (world.viewed[i] == world.viewed[j])
            for index, i in enumerate(seen) for j in seen[index+1:]]
    expected = base + (expected_cpi_assumptions(world)
                       if world.include_cpi_validation_assumptions else [])
    expected += list(world.proven_cpi_validation_premises)
    need(same_formulas(actual, expected),
         "cpi assumptions: complete axiom inventory differs from key relations plus declared CPI premises")
    return {"base": len(base), "total": len(actual)}


def audit_cpi_assumption_interface(multi, m):
    """Pin full legacy/disabled axiom inventories and probe every effect slot."""
    disabled = multi.MultiWorld(m, include_cpi_validation_assumptions=False)
    enabled = multi.MultiWorld(m)
    disabled.multi = enabled.multi = multi
    expected = expected_cpi_assumptions(disabled)
    need(same_formulas(disabled.cpi_validation_assumptions(), expected),
         "cpi assumptions: exposed assumptions differ from the exact active-success/count implication")
    disabled_inventory = audit_world_axioms(disabled)
    enabled_inventory = audit_world_axioms(enabled)
    active_witnesses, inactive_witnesses = [], []
    src = (m["accepted"], 1)
    for slot in range(m["slots"]):
        for is_active, destination in [(True, active_witnesses), (False, inactive_witnesses)]:
            active = disabled.eff(src, slot, "active")
            formula = z3.And(disabled.VAL[slot] == z3.BitVecVal(0, 64),
                             active != 0 if is_active else active == 0,
                             disabled.eff(src, slot, "count") == z3.BitVecVal(9, 32))
            witness = model_witness(disabled, formula,
                f"slot {slot}: {'active-success' if is_active else 'inactive'} count nine remains unconstrained")
            need(witness is not None,
                 f"cpi assumptions: hidden count bound for slot {slot}, active={is_active}")
            destination.append({"slot": slot, **witness})
    return {
        "result": "exact complete axiom inventories; no built-in CPI assumptions in composition",
        "defaultBehaviorPreserved": True,
        "disabledAxiomCount": 0,
        "enabledAxiomCount": len(expected),
        "completeInventories": {"disabled": disabled_inventory, "enabled": enabled_inventory},
        "noHiddenActiveSuccessAxiom": active_witnesses,
        "inactiveUnboundedWitness": inactive_witnesses,
        "assumptions": [str(item) for item in expected],
    }


def prove_cpi_validation_premises(multi, m, cpi_model, cpi_actual,
                                  disabled_obligations=()):
    """Derive each adapter premise from the parsed validator, before execution."""
    world = multi.MultiWorld(m, include_cpi_validation_assumptions=False)
    src = (m["accepted"], 1)
    helper_active = cpi_model.fields["active"]
    helper_count = cpi_model.fields["meta_count"]
    premises = []
    proofs = []
    for slot in range(m["slots"]):
        adapter_active = world.eff(src, slot, "active")
        adapter_count = world.eff(src, slot, "count")
        adapter_result = world.VAL[slot]
        adapter_count_argument = z3.Extract(31, 0, world.COUNT)
        bad_terms = [
            cpi_model.pre,
            cpi_model.count == adapter_count_argument,
            helper_active == adapter_active,
            helper_count == adapter_count,
            adapter_result == z3.BitVecVal(0, 64),
            adapter_active != z3.BitVecVal(0, 32),
            z3.UGT(adapter_count, z3.BitVecVal(8, 32)),
        ]
        if "parsed helper return is equated to the actual adapter validation result" \
                not in disabled_obligations:
            bad_terms.append(cpi_actual == adapter_result)
        bad = z3.And(*bad_terms)
        solver = z3.Solver()
        solver.set(timeout=30000)
        solver.add(bad)
        result = solver.check()
        if result == z3.unknown:
            raise Fatal(f"helper premise slot {slot}: Z3 UNKNOWN: {solver.reason_unknown()}")
        if result == z3.sat:
            model = solver.model()
            detached_witness = {
                "label": "parsed validator theorem instantiated on adapter symbols",
                "completeModel": [
                    {"name": str(decl), "value": str(model[decl])}
                    for decl in sorted(model.decls(), key=lambda item: str(item))
                ],
                "witnessValues": [
                    {"name": "helperReturn", "value": str(model.eval(cpi_actual, model_completion=True))},
                    {"name": "adapterValidationResult", "value": str(model.eval(adapter_result, model_completion=True))},
                    {"name": "active", "value": str(model.eval(adapter_active, model_completion=True))},
                    {"name": "count", "value": str(model.eval(adapter_count, model_completion=True))},
                ],
            }
            raise BridgeSemantic(
                f"helper premise slot {slot}: active validator success did not bound the exact adapter count",
                detached_witness,
            )
        premise = z3.Implies(
            z3.And(adapter_result == z3.BitVecVal(0, 64),
                   adapter_active != z3.BitVecVal(0, 32)),
            z3.ULE(adapter_count, z3.BitVecVal(8, 32)),
        )
        premises.append(premise)
        proofs.append({
            "slot": slot,
            "result": "unsat",
            "active": str(adapter_active),
            "count": str(adapter_count),
            "validationResult": str(adapter_result),
            "validatorAccountCountArgument": str(adapter_count_argument),
            "premise": str(premise),
        })
    return tuple(premises), proofs


def check_call_bridge(multi, world, executor, slots, disabled_obligations=()):
    need(not world.include_cpi_validation_assumptions,
         "bridge: caller checks must run with CPI validation assumptions removed")
    call_claims = {
        "same effect object and slot": 0,
        "same parsed Account array": 0,
        "same invocation account count": 0,
        "validate before execute with zero status": 0,
        "custody output bump passed unchanged": 0,
    }
    success_traces = 0
    status_bad = []
    bump_bad = []
    range_bad = []
    count_bad = []
    zero_return_paths = []
    for path in world.paths:
        events = path.events
        custody = [e for e in events if e.kind == "custody"]
        validates = [e for e in events if e.kind == "validate"]
        executes = [e for e in events if e.kind == "execute"]
        if not validates and not executes:
            continue
        if len(custody) != 1 or not validates or len(validates) > slots:
            raise BridgeSemantic(
                "bridge: every reached validator path must contain one custody call and a nonempty slot prefix",
                structural_counterexample(
                    world, "incomplete validation call trace",
                    {"custodyCalls": len(custody), "validationSlots": [e.slot for e in validates]},
                    lambda candidate: z3.BoolVal(candidate is path),
                ),
            )
        if [e.slot for e in validates] != list(range(len(validates))):
            raise BridgeSemantic(
                "bridge: reached validator calls are not an ordered prefix of extracted slots",
                structural_counterexample(
                    world, "validation slot identity",
                    {"validationSlots": [e.slot for e in validates]},
                    lambda candidate: z3.BoolVal(candidate is path),
                ),
            )
        positions = {id(event): index for index, event in enumerate(events)}
        need(positions[id(custody[0])] < min(positions[id(e)] for e in validates),
             "bridge: custody setup does not precede a reached validation call")
        for validation in validates:
            slot = validation.slot
            account_array_bridge_enabled = \
                "parsed validator Account* is the custody Account array" \
                not in disabled_obligations
            if (account_array_bridge_enabled and validation.accountArray != "accounts") \
                    or validation.effectRef != ("elem", "transfers", slot) \
                    or validation.src != (world.m["accepted"], 1):
                mismatch = z3.BoolVal(
                    validation.accountArray != "accounts"
                    or validation.effectRef != ("elem", "transfers", slot)
                    or validation.src != (world.m["accepted"], 1)
                )
                raise BridgeSemantic(
                    "bridge: validator does not receive the parsed accounts array and its extracted transfers[slot]",
                    structural_counterexample(
                        world, "validation call identity",
                        {"slot": slot, "accountArray": validation.accountArray,
                         "effectRef": validation.effectRef, "source": validation.src},
                        lambda candidate: z3.And(candidate.pc, mismatch),
                    ),
                )
            expected_count = z3.Extract(31, 0, world.COUNT)
            count_bad.append(z3.And(path.pc, validation.count != expected_count))
            count_bad.append(z3.And(
                path.pc,
                validation.result != world.VAL[slot] if validation.result is not None
                else z3.BoolVal(True),
            ))
            low32 = z3.BitVecVal(4, 32)
            high32 = z3.BitVecVal(12, 32)
            low64 = z3.BitVecVal(4, 64)
            high64 = z3.BitVecVal(12, 64)
            # Check both the actual u32 helper argument and the loader's u64
            # count on every reached call, including early validation returns.
            range_bad.append(z3.And(
                path.pc,
                z3.Or(z3.ULT(validation.count, low32), z3.UGT(validation.count, high32),
                      z3.ULT(world.COUNT, low64), z3.UGT(world.COUNT, high64)),
            ))
        if not executes:
            # Validation errors return before execution, but the validator call
            # count/range/argument obligations above still apply.
            continue
        if len(validates) != slots or len(executes) < 1 or len(executes) > slots:
            raise BridgeSemantic(
                "bridge: an execution path lacks every validation call or has an invalid execute prefix",
                structural_counterexample(
                    world, "incomplete helper slot trace",
                    {"validationSlots": [e.slot for e in validates],
                     "executionSlots": [e.slot for e in executes]},
                    lambda candidate: z3.BoolVal(candidate is path),
                ),
            )
        if [e.slot for e in executes] != list(range(len(executes))):
            raise BridgeSemantic(
                "bridge: execution does not use the reached extracted slot prefix in order",
                structural_counterexample(
                    world, "execution slot identity",
                    {"executionSlots": [e.slot for e in executes]},
                    lambda candidate: z3.BoolVal(candidate is path),
                ),
            )
        need(max(positions[id(e)] for e in validates) < min(positions[id(e)] for e in executes),
             "bridge: execution starts before all validations return")
        call_claims["same effect object and slot"] += 1
        call_claims["same parsed Account array"] += 1
        call_claims["same invocation account count"] += 1
        call_claims["validate before execute with zero status"] += 1
        call_claims["custody output bump passed unchanged"] += 1
        if custody[0].accountArray != "accounts" or custody[0].bumpOutput != ("var", "bump") \
                or custody[0].callArguments[2] != ("addr", ("id", "bump")):
            raise BridgeSemantic(
                "bridge: custody setup is not bound to the parsed accounts and bump locals",
                structural_counterexample(
                    world, "custody argument identity",
                    {"accountArray": custody[0].accountArray,
                     "bumpOutput": custody[0].bumpOutput},
                    lambda candidate: z3.BoolVal(candidate is path),
                ),
            )
        if "parsed validator Account* is the custody Account array" not in disabled_obligations \
                and not all(e.accountArray == custody[0].accountArray for e in validates + executes):
            raise BridgeSemantic(
                "bridge: validator/executor Account array differs from custody/preflight",
                structural_counterexample(
                    world, "Account array identity",
                    {"custody": custody[0].accountArray,
                     "validation": [e.accountArray for e in validates],
                     "execution": [e.accountArray for e in executes]},
                    lambda candidate: z3.And(
                        candidate.pc,
                        z3.BoolVal(any(e.accountArray != custody[0].accountArray
                                       for e in validates + executes)),
                    ),
                ),
            )
        if not all(e.effectRef == ("elem", "transfers", e.slot) for e in validates + executes):
            raise BridgeSemantic(
                "bridge: helper stages do not read the same extracted effect slot",
                structural_counterexample(
                    world, "effect object identity",
                    {"effectRefs": [e.effectRef for e in validates + executes]},
                    lambda candidate: z3.BoolVal(any(
                        e.effectRef != ("elem", "transfers", e.slot)
                        for e in validates + executes
                    )),
                ),
            )
        for execution in executes:
            slot = execution.slot
            validation = next(e for e in validates if e.slot == slot)
            if validation.effectRef != execution.effectRef or validation.src != execution.src \
                    or validation.src != (world.m["accepted"], 1):
                raise BridgeSemantic(
                    "bridge: effect object changed between validation and execution",
                    structural_counterexample(
                        world, "effect object identity",
                        {"validation": validation.effectRef,
                         "execution": execution.effectRef},
                        lambda candidate: z3.And(
                            candidate.pc,
                            z3.BoolVal(validation.effectRef != execution.effectRef
                                       or validation.src != execution.src
                                       or validation.src != (world.m["accepted"], 1)),
                        ),
                    ),
                )
            if "parsed validator Account* is the custody Account array" not in disabled_obligations \
                    and validation.accountArray != execution.accountArray:
                raise BridgeSemantic(
                    "bridge: Account array changed between validation and execution",
                    structural_counterexample(
                        world, "Account array identity",
                        {"validation": validation.accountArray,
                         "execution": execution.accountArray},
                        lambda candidate: z3.And(
                            candidate.pc,
                            z3.BoolVal(validation.accountArray != execution.accountArray),
                        ),
                    ),
                )
            count_bad.append(z3.And(path.pc, validation.count != execution.count))
            count_bad.append(z3.And(path.pc, execution.count != z3.Extract(31, 0, world.COUNT)))
            if execution.callArguments[3] != ("id", "bump"):
                raise BridgeSemantic(
                    "bridge: executor does not receive the custody output unchanged",
                    structural_counterexample(
                        world, "custody bump identity",
                        {"executorBumpArgument": execution.callArguments[3]},
                        lambda candidate: z3.And(candidate.pc, z3.BoolVal(True)),
                    ),
                )
            bump_bad.append(z3.And(path.pc, execution.bump != world.BUMP))
        status_bad.append(z3.And(
            path.pc,
            z3.Or([world.VAL[e.slot] != z3.BitVecVal(0, 64) for e in validates]),
        ))
        zero_return_paths.append(z3.And(path.pc, path.ret == z3.BitVecVal(0, 64)))
    require_unsat(world, z3.Or(status_bad),
                  "bridge: execution reachable before every validation returned zero")
    require_unsat(world, z3.Or(count_bad),
                  "bridge: validator/executor arguments differ from each other or the parsed loader count")
    require_unsat(world, z3.Or(bump_bad),
                  "bridge: executor bump differs from the successful custody output")
    require_unsat(world, z3.Or(range_bad),
                  "bridge: a reached validator call is outside caller account_count 4..12")
    sat, _ = world.feasible(z3.Or(zero_return_paths))
    success_traces = 1 if sat else 0
    need(success_traces > 0, "bridge: no ordinary zero-return helper execution witness")
    return {
        "result": "proved on parsed emitted entrypoint paths",
        "claims": {
            "same effect object and slot": "validator and executor receive the same extracted transfers[slot] reference",
            "same parsed Account array": "custody setup, validator, and executor receive the same accounts array",
            "same invocation account count": "validator and executor counts both equal the parsed loader count after the ABI2 range guard",
            "validate before execute with zero status": "all validation calls precede every execution; each executed slot has a zero validation return on that path",
            "custody output bump passed unchanged": "execution receives the same u8 local written by bend_invoke_custody",
        },
        "validatedSlots": list(range(slots)),
        "allReachedValidationCallsChecked": True,
        "accountCountPrecondition": "every reached validator event, including a nonzero-return early-exit path, has u32 argument and loader u64 count in 4..12",
        "ordinaryZeroReturnReachabilityWitnesses": success_traces,
    }


def check_meta_loop_connection(world, executor, slots, cpi_model, cpi_actual,
                               disabled_obligations=()):
    need(not world.include_cpi_validation_assumptions,
         "meta bridge: interpreter still has a built-in CPI validation assumption")
    slots_report = []
    for slot in range(slots):
        active_reads = [
            item for item in executor.effect_reads
            if item["field"] == "active" and item["array"] == "transfers"
            and item["slot"] == slot
        ]
        count_reads = [
            item for item in executor.effect_reads
            if item["field"] == "count" and item["array"] == "transfers"
            and item["slot"] == slot
        ]
        meta_reads = [
            item for item in executor.meta_reads
            if item["array"] == "transfers" and item["slot"] == slot
        ]
        if not active_reads or not count_reads or not meta_reads:
            active = world.eff((world.m["accepted"], 1), slot, "active")
            target_count = world.eff((world.m["accepted"], 1), slot, "count")
            raise BridgeSemantic(
                f"bridge: meta scan slot {slot} lacks an active guard, count read, or meta read",
                structural_counterexample(
                    world, f"meta loop effect identity slot {slot}",
                    {"activeSlots": [item["slot"] for item in active_reads],
                     "countSlots": sorted({item["slot"] for item in executor.effect_reads
                                           if item["field"] == "count"}),
                     "metaSlots": [item["slot"] for item in meta_reads]},
                    lambda path: z3.And(
                        path.pc,
                        world.VAL[slot] == z3.BitVecVal(0, 64),
                        active != z3.BitVecVal(0, 32),
                        z3.UGT(target_count, z3.BitVecVal(0, 32)),
                    ),
                ),
            )
        active = world.eff((world.m["accepted"], 1), slot, "active")
        count = world.eff((world.m["accepted"], 1), slot, "count")
        expected_source = (world.m["accepted"], 1)
        if any(item["source"] != expected_source for item in active_reads + count_reads + meta_reads):
            bad = next(item for item in active_reads + count_reads + meta_reads
                       if item["source"] != expected_source)
            raise BridgeSemantic(
                f"bridge: meta scan slot {slot} reads a different extracted effect",
                structural_counterexample(
                    world, f"meta loop source slot {slot}",
                    {"field": bad["field"], "source": bad["source"]},
                    lambda path: z3.And(path.pc, z3.BoolVal(True)),
                ),
            )

        # The adapter interpreter has no CPI helper axiom in this run. First
        # instantiate the theorem proved from the live parsed helper using the
        # exact values observed at the corresponding parsed validation call.
        validations = [event for path in world.paths for event in path.events
                       if event.kind == "validate" and event.slot == slot]
        need(validations, f"meta bridge: no reached parsed validation call for slot {slot}")
        validation = validations[0]
        need(validation.result is not None,
             f"meta bridge: parsed validation call slot {slot} has no observed result expression")
        adapter_active = world.eff(expected_source, slot, "active")
        adapter_count = world.eff(expected_source, slot, "count")
        observed_active = [item["value"] for item in active_reads]
        observed_count = [item["value"] for item in count_reads]
        need(all(value is not None and z3.eq(value, adapter_active) for value in observed_active),
             f"meta bridge: slot {slot} active read is not the extracted effect value")
        need(all(value is not None and z3.eq(value, adapter_count) for value in observed_count),
             f"meta bridge: slot {slot} count read is not the extracted effect value")
        helper_result_bridge_enabled = \
            "parsed helper return is equated to the actual adapter validation result" \
            not in disabled_obligations
        if helper_result_bridge_enabled:
            need(z3.eq(validation.result, world.VAL[slot]),
                 f"meta bridge: slot {slot} parsed validation result is not MultiWorld's actual call result")
        helper_count = cpi_model.fields["meta_count"]
        helper_active = cpi_model.fields["active"]
        helper_result = cpi_actual
        helper_call_count = cpi_model.count
        helper_bad_terms = [
            cpi_model.pre,
            helper_call_count == validation.count,
            helper_active == adapter_active,
            helper_count == adapter_count,
            validation.result == z3.BitVecVal(0, 64),
            adapter_active != z3.BitVecVal(0, 32),
            z3.UGT(adapter_count, z3.BitVecVal(8, 32)),
        ]
        if helper_result_bridge_enabled:
            helper_bad_terms.append(helper_result == validation.result)
        helper_instantiation_bad = z3.And(*helper_bad_terms)
        solver = z3.Solver()
        solver.set(timeout=30000)
        solver.add(helper_instantiation_bad)
        result = solver.check()
        if result == z3.unknown:
            raise Fatal(f"meta bridge: helper theorem instantiation UNKNOWN for slot {slot}: {solver.reason_unknown()}")
        if result == z3.sat:
            model = solver.model()
            raise BridgeSemantic(
                f"bridge: parsed validator success does not bound the exact slot {slot} meta count",
                {
                    "label": "helper theorem instantiated on parsed effect/status/count call expressions",
                    "completeModel": [
                        {"name": str(decl), "value": str(model[decl])}
                        for decl in sorted(model.decls(), key=lambda item: str(item))
                    ],
                },
            )
        helper_premise = z3.Implies(
            z3.And(validation.result == z3.BitVecVal(0, 64),
                   adapter_active != z3.BitVecVal(0, 32)),
            z3.ULE(adapter_count, z3.BitVecVal(8, 32)),
        )
        need(any(z3.eq(premise, helper_premise)
                 for premise in world.proven_cpi_validation_premises),
             f"meta bridge: slot {slot} helper premise was not supplied to the parsed adapter")

        # A scalar count read is safe before validation. The bound is needed
        # where it controls meta accesses, checked below on those actual paths.
        record_bridge_query(world, f"bridge: slot {slot} helper return instantiation",
                            helper_instantiation_bad)

        meta_loop_ids = {read["loopIds"][-1] for read in meta_reads if read["loopIds"]}
        loop_bounds = [item for item in executor.loop_bounds
                       if item["id"] in meta_loop_ids]
        if not loop_bounds:
            raise BridgeSemantic(
                f"bridge: meta scan slot {slot} has no captured count-derived loop bound",
                structural_counterexample(
                    world, f"meta loop bound missing slot {slot}",
                    {"loopVariables": sorted({name for read in meta_reads
                                               for name in read["loopNames"]})},
                    lambda path: z3.And(
                        path.pc, validation.result == z3.BitVecVal(0, 64),
                        active != z3.BitVecVal(0, 32),
                        z3.UGT(count, z3.BitVecVal(1, 32)),
                    ),
                ),
            )
        loop_bound_bad = []
        for meta_read in meta_reads:
            related = [item for item in loop_bounds
                       if meta_read["loopIds"]
                       and item["id"] == meta_read["loopIds"][-1]]
            if not related:
                raise BridgeSemantic(
                    f"bridge: meta read for slot {slot} is not enclosed by a captured count loop",
                    structural_counterexample(
                        world, f"meta read outside count loop slot {slot}",
                        {"index": meta_read["index"],
                         "loopNames": meta_read["loopNames"]},
                        lambda path: z3.And(
                            meta_read["pc"],
                            validation.result == z3.BitVecVal(0, 64),
                            active != z3.BitVecVal(0, 32),
                            z3.UGT(count, z3.BitVecVal(0, 32)),
                        ),
                    ),
                )
            loop_bound_bad.extend(
                z3.And(
                    meta_read["pc"],
                    validation.result == z3.BitVecVal(0, 64),
                    active != z3.BitVecVal(0, 32),
                    count != bound["value"],
                )
                for bound in related
            )
        require_unsat(
            world, z3.Or(loop_bound_bad),
            f"bridge: slot {slot} meta loop bound is not its own extracted effect count",
        )

        meta_bad = [
            z3.And(
                item["pc"],
                z3.Or(
                    world.VAL[slot] != z3.BitVecVal(0, 64),
                    active == z3.BitVecVal(0, 32),
                    z3.UGT(count, z3.BitVecVal(8, 32)),
                    z3.UGE(z3.BitVecVal(item["index"], 32), count),
                    z3.UGE(z3.BitVecVal(item["index"], 32), z3.BitVecVal(8, 32)),
                ),
            )
            for item in meta_reads
        ]
        require_unsat(
            world, z3.Or(meta_bad),
            f"bridge: slot {slot} meta reads lack the validated active count bound",
        )
        slots_report.append({
            "slot": slot,
            "activeAndCountReadSource": "the same transfers[slot] extracted from Accepted.effects",
            "countReadInMetaLoop": "including a directly hoisted local when its symbolic value is the extracted slot count",
            "metaArrayReads": len(meta_reads),
            "adapterLoopObligations": "UNSAT with the separately proven exact-call helper premise",
            "runtimeHelperFact": "UNSAT after instantiating the parsed validator theorem on this call's actual effect fields, count argument and result",
            "joinedSymbols": {
                "effectActive": str(adapter_active),
                "effectCount": str(adapter_count),
                "validationReturn": str(validation.result),
                "accountCount": str(validation.count),
            },
            "helperTheoremInstantiation": "unsat",
            "onlySuppliedPremise": str(helper_premise),
            "loopBoundExpressions": [
                {"loopId":item["id"],"expression":str(item["value"])}
                for item in loop_bounds
            ],
        })
    return {
        "result": "UNSAT for each emitted CPI slot with the legacy assumptions removed",
        "slots": slots_report,
        "inactiveEffect": "No count<=8 fact is supplied when active==0; a separately solved inactive helper witness has count above eight.",
    }


def fixture_result(multi, fixture, cpi_premises, require_full=True, only_claim=None):
    m = multi.summarize(fixture["schema"], fixture["interface"])
    need(m["cpi"] and m["slots"] == 2, f"{fixture['name']}: expected a two-slot CPI effect")
    need(len(m["fields"]) == int(fixture["name"][-1]),
         f"{fixture['name']}: schema state-field count differs from fixture identity")
    result = multi.analyse(
        m, fixture, fixture["files"],
        require_witnesses=require_full, only_claim=only_claim,
        include_cpi_validation_assumptions=False,
        proven_cpi_validation_premises=cpi_premises,
    )
    return m, result


def analyze_fixture(multi, cpi_model, cpi_actual, fixture,
                    disabled_obligations=()):
    m = multi.summarize(fixture["schema"], fixture["interface"])
    assumption_obligation = \
        "the exact active-success CPI assumption is inventoried and separately discharged"
    assumption_audit = ({
        "result": "disabled for mutation probe",
        "disabledObligation": assumption_obligation,
    } if assumption_obligation in disabled_obligations else
        audit_cpi_assumption_interface(multi, m))
    cpi_premises, cpi_premise_proofs = prove_cpi_validation_premises(
        multi, m, cpi_model, cpi_actual, disabled_obligations)
    m, adapter_result = fixture_result(multi, fixture, cpi_premises)
    world, executor, raw_paths, dependencies = parse_actual_adapter(
        multi, m, fixture, cpi_premises)
    need(raw_paths > 0 and world.paths, f"{fixture['name']}: emitted adapter has no parsed paths")
    call_bridge = check_call_bridge(
        multi, world, executor, m["slots"], disabled_obligations)
    meta_bridge = check_meta_loop_connection(
        world, executor, m["slots"], cpi_model, cpi_actual,
        disabled_obligations)
    expected_queries = required_bridge_queries(m["slots"])
    queries = getattr(world, 'bridge_queries', [])
    need([query['name'] for query in queries] == expected_queries,
         'bridge solver query inventory missing, duplicated or out of order')
    need(not executor.effect_array_writes,
         f"{fixture['name']}: adapter writes the extracted effect array after extraction")
    post_execution_size_reads = [
        item for item in executor.account_field_reads
        if item["field"] == "size" and item["afterExecution"]
    ]
    need(not post_execution_size_reads,
         f"{fixture['name']}: adapter reads stale Account.size after CPI execution")
    preflight_stages = [
        name for name in adapter_result["witnesses"]
        if name == "distinct-accounts"
        or name.startswith("field-")
        or name in ("account-count", "custody-setup")
    ]
    need("distinct-accounts" in preflight_stages,
         f"{fixture['name']}: missing account-alias preflight evidence")
    need(len([name for name in preflight_stages if name.startswith("field-")]) >= len(m["fields"]),
         f"{fixture['name']}: missing managed-state preflight evidence")
    selected_claims = {
        name: item
        for name, item in adapter_result["claims"].items()
        if name in ("ordered-return-contract", "all-encodes-validation-execution-before-commit")
    }
    need(set(selected_claims) == {
        "ordered-return-contract",
        "all-encodes-validation-execution-before-commit",
    }, f"{fixture['name']}: missing required ABI2 adapter control-flow claims")
    need(all(item["result"] == "unsat" for item in selected_claims.values()),
         f"{fixture['name']}: ABI2 adapter claim was not UNSAT")
    return {
        "name": fixture["name"],
        "managedStates": len(m["fields"]),
        "allowedCallerAccountCount": {"min": 4, "max": 12},
        "adapterAcceptedAccountCount": {"min": m["minimum"], "max": m["maximum"]},
        "effectSlots": m["slots"],
        "adapterSha256": fixture["artifactHashes"][fixture["artifactPaths"][fixture["adapter"]]],
        "schemaSha256": fixture["artifactHashes"][fixture["artifactPaths"][fixture["name"] + ".schema.json"]],
        "interfaceSha256": fixture["artifactHashes"][fixture["artifactPaths"][fixture["name"] + ".interface.json"]],
        "includeClosure": {
            name: fixture["artifactHashes"].get(fixture["artifactPaths"][name], sha(data))
            for name, data in fixture["files"].items()
        },
        "helperRuntimeIncludeClosure": {
            "selectedSourceRoot": fixture["helperRuntimeRoot"],
            "files": fixture["helperRuntimeFiles"],
            "allBytesMatchParsedHelper": True,
        },
        "reusedAdapterClaims": selected_claims,
        "managedStatePreflightAndAliases": {
            "result": "UNSAT return-order contract with stage reachability witnesses",
            "witnessedStages": preflight_stages,
            "claimed": [
                "caller count guard bounds the account array before fixed-account accesses",
                "all provided account keys are checked for aliases before custody/state preflight and helper calls",
                "each managed account owner/executable/writable/size/header/binding/decode stage precedes the Bend root and CPI helpers",
            ],
        },
        "callBridge": call_bridge,
        "bridgeSolverQueries": queries,
        "cpiAssumptionAudit": assumption_audit,
        "cpiPremiseProofs": cpi_premise_proofs,
        "metaLoopBridge": meta_bridge,
        "accountArraySizeRefresh": {
            "result": "no post-execution Account.size reads in the parsed adapter",
            "runtimeWrite": "the exact audited bend_invoke_execute body refreshes local a[i].size from infos[i].data_len after each successful CPI",
            "preExecutionSizeReadCount": sum(
                item["field"] == "size" and not item["afterExecution"]
                for item in executor.account_field_reads
            ),
            "postExecutionSizeReadCount": 0,
            "postExecutionAccountFieldsObserved": sorted({
                item["field"] for item in executor.account_field_reads
                if item["afterExecution"]
            }),
            "scope": "The adapter does not make a later decision from stale Account.size. Account data pointers and arbitrary external account contents remain outside this composition claim.",
        },
        "effectStability": {
            "result": "adapter has no assignment to the extracted effect array; actual helper signatures take const BendInvoke pointers",
            "effectReference": "same transfers[slot] local for validator and executor",
            "conditionalOn": [
                "restricted parser/interpreter and C const behavior",
                "the reviewed sol_invoke_signed_c ABI preserves unrelated local effect objects",
            ],
        },
        "normalReturnOnly": True,
    }


def replace_once(text, old, new, label):
    count = text.count(old)
    need(count == 1, f"mutation target {label!r} occurs {count} times, expected once")
    return text.replace(old, new)


def mutate_account_array(files):
    adapter = files["cpi-2.c"]
    declaration = "  const u8 *p=input+8;"
    adapter = replace_once(
        adapter, declaration, declaration + "\n  Account other_accounts[12]; const u8 *q=input+8;",
        "alternate parsed account array declaration",
    )
    account_read = "p=read_account(p,&accounts[i]); if (!p) return 6;"
    adapter = replace_once(
        adapter, account_read,
        account_read + " q=read_account(q,&other_accounts[i]); if (!q) return 6;",
        "populate alternate account array from same loader records",
    )
    call = "bend_invoke_validate(&transfers[i],accounts,(unsigned)count)"
    adapter = replace_once(
        adapter, call, "bend_invoke_validate(&transfers[i],other_accounts,(unsigned)count)",
        "validator account array identity",
    )
    return {**files, "cpi-2.c": adapter}


def adapter_mutations(fixture):
    adapter_name = fixture["adapter"]
    original = fixture["files"][adapter_name]
    patterns = {
        "wrong validation effect slot": (
            "bend_invoke_validate(&transfers[i],accounts",
            "bend_invoke_validate(&transfers[0],accounts",
            "all-encodes-validation-execution-before-commit",
        ),
        "wrong validation count": (
            "bend_invoke_validate(&transfers[i],accounts,(unsigned)count)",
            "bend_invoke_validate(&transfers[i],accounts,7)",
            "ordered-return-contract",
        ),
        "constant custody bump": (
            "bend_invoke_execute(&transfers[i],accounts,(unsigned)count,bump)",
            "bend_invoke_execute(&transfers[i],accounts,(unsigned)count,0)",
            "all-encodes-validation-execution-before-commit",
        ),
        "dropped CPI validation": (
            "u64 error=bend_invoke_validate(&transfers[i],accounts,(unsigned)count);",
            "u64 error=0;",
            "ordered-return-contract",
        ),
        "truncated validation status width": (
            "u64 error=bend_invoke_validate(&transfers[i],accounts,(unsigned)count);",
            "u32 error=bend_invoke_validate(&transfers[i],accounts,(unsigned)count);",
            "ordered-return-contract",
        ),
    }
    cases = []
    for name, (old, new, claim) in patterns.items():
        cases.append((name, {**fixture["files"], adapter_name:
                             replace_once(original, old, new, name)}, claim, "semantic"))

    order_old = (
        "u64 error=bend_invoke_validate(&transfers[i],accounts,(unsigned)count); "
        "if(error) return error; if(transfers[i].active)"
    )
    order_new = (
        "u64 error=bend_invoke_validate(&transfers[i],accounts,(unsigned)count); "
        "if(transfers[i].active)"
    )
    order_variant = replace_once(original, order_old, order_new, "validation status order")
    order_variant = replace_once(
        order_variant, "return 22; }",
        "return 22; if(error) return error; }",
        "validation status after managed-state scan",
    )
    cases.append(("validation status checked after managed-state scan",
                  {**fixture["files"], adapter_name: order_variant},
                  "ordered-return-contract", "semantic"))

    # The second effect's meta loop must use its own validated count. A literal
    # slot-zero count remains in the parser grammar and is a semantic identity
    # counterexample when slot one has a distinct count.
    count_old = "for(unsigned j=0;j<transfers[i].count;++j)"
    count_new = "for(unsigned j=0;j<transfers[0].count;++j)"
    cases.append(("meta loop takes count from a different effect slot",
                  {**fixture["files"], adapter_name:
                   replace_once(original, count_old, count_new, "meta loop effect count")},
                  "same effect object and slot", "bridge"))

    # Move execution before the complete validation loop: this produces a
    # concrete ordinary-return trace with an executed CPI before the later
    # validator failure branch. No external-account postcondition is inferred.
    validate_start = original.index("  for(unsigned i=0;i<2;++i) { u64 error=")
    execute_start = original.index("  for(unsigned i=0;i<2;++i) if(bend_invoke_execute")
    validate_end = original.index("\n", validate_start)
    execute_end = original.index("\n", execute_start)
    validate_line = original[validate_start:validate_end]
    execute_line = original[execute_start:execute_end]
    order_exec = original[:validate_start] + execute_line + "\n" + validate_line + original[validate_end:]
    cases.append(("execute before every validation succeeds",
                  {**fixture["files"], adapter_name: order_exec},
                  "all-encodes-validation-execution-before-commit", "semantic"))

    alias_old = "for (unsigned j=0;j<i;++j) if (equal_key(accounts[i].key,accounts[j].key)) return 6;"
    cases.append(("managed account alias preflight removed",
                  {**fixture["files"], adapter_name:
                   replace_once(original, alias_old, "for(unsigned j=0;j<i;++j) {}", "alias preflight")},
                  "ordered-return-contract", "semantic"))
    return cases


def reject_mutation(multi, cpi_model, cpi_actual, fixture, case):
    name, files, expected, kind = case
    candidate = dict(fixture)
    candidate["files"] = files
    try:
        m = multi.summarize(candidate["schema"], candidate["interface"])
        premises, _ = prove_cpi_validation_premises(multi, m, cpi_model, cpi_actual)
        m, _ = fixture_result(multi, candidate, premises,
                              require_full=False, only_claim=expected)
        if expected in ("same parsed Account array", "same effect object and slot"):
            world, executor, _, _ = parse_actual_adapter(multi, m, candidate, premises)
            if expected == "same parsed Account array":
                # Call tracing is attached by the observer through actual parsed
                # calls; check_call_bridge supplies the model witness.
                try:
                    check_call_bridge(multi, world, executor, m["slots"])
                except BridgeSemantic as error:
                    return {"name": name, "kind": "semantic", "reason": error.label,
                            "counterexample": error.witness}
            if expected == "same effect object and slot":
                try:
                    check_meta_loop_connection(world, executor, m["slots"], cpi_model, cpi_actual)
                except BridgeSemantic as error:
                    return {"name": name, "kind": "semantic", "reason": error.label,
                            "counterexample": error.witness}
        else:
            # The no-mutation path is itself an error. The expected claim was
            # passed to the live interpreter, not tested with a marker matcher.
            raise Fatal(f"semantic mutant survived: {name}")
    except multi.SymSemantic as error:
        # A wrong meta-loop count can fail while the real parsed C interpreter
        # evaluates the out-of-bounds access, before the later identity bridge
        # checker gets to inspect its trace. This is a genuine model
        # counterexample (for example metas[8] outside the eight-element
        # bounded array), not a parser/grammar rejection. Keep this exception
        # narrow to that exact mutant and require the concrete bounds reason.
        if name == "meta loop takes count from a different effect slot":
            need("bounds" in error.label and "metas[" in error.label,
                 f"{name}: interpreter counterexample was not a meta bounds failure: {error.label}")
            need(bool(error.model), f"{name}: missing symbolic model for meta bounds failure")
            return {"name": name, "kind": "semantic", "reason": error.label,
                    "counterexample": error.model}
        if kind != "semantic":
            raise Fatal(f"{name}: semantic counterexample was not expected") from error
        need(expected in error.label or expected == "ordered-return-contract"
             or expected == "all-encodes-validation-execution-before-commit"
             or expected in ("same parsed Account array", "same effect object and slot"),
             f"{name}: unexpected semantic reason {error.label}")
        return {"name": name, "kind": "semantic", "reason": error.label,
                "counterexample": error.model}
    except BridgeSemantic as error:
        if kind not in ("bridge", "semantic"):
            raise Fatal(f"{name}: bridge counterexample was not expected") from error
        return {"name": name, "kind": "semantic", "reason": error.label,
                "counterexample": error.witness}
    except multi.Grammar as error:
        raise Fatal(f"{name}: grammar rejection where a semantic counterexample was required: {error}") from error
    raise Fatal(f"semantic mutant survived without a parsed model counterexample: {name}")


def grammar_mutation(multi, cpi_model, cpi_actual, fixture):
    adapter = fixture["adapter"]
    changed = replace_once(
        fixture["files"][adapter], "bend_invoke_validate(",
        "unreviewed_bend_invoke_validate(",
        "unreviewed CPI helper",
    )
    candidate = {**fixture, "files": {**fixture["files"], adapter: changed}}
    try:
        m = multi.summarize(candidate["schema"], candidate["interface"])
        premises, _ = prove_cpi_validation_premises(multi, m, cpi_model, cpi_actual)
        multi.analyse(
            m, candidate, candidate["files"], require_witnesses=False,
            include_cpi_validation_assumptions=False,
            proven_cpi_validation_premises=premises,
        )
    except multi.Grammar as error:
        return {"name": "unreviewed CPI helper call", "kind": "grammar",
                "reason": str(error), "sourceSha256": sha(changed)}
    except multi.SymSemantic as error:
        raise Fatal(f"unreviewed helper mutant reached a model counterexample: {error.label}") from error
    raise Fatal("unreviewed helper grammar mutant was accepted")


def equivalent_variants(multi, cpi_model, cpi_actual, fixtures):
    results = []
    for fixture in (fixtures[0], fixtures[2]):
        adapter = fixture["adapter"]
        original = fixture["files"][adapter]
        changed = replace_once(
            original, "u64 count = read_le(input,8);",
            "u64 count=read_le(input,8); /* comment decoy: bend_invoke_execute */",
            f"{fixture['name']} spacing/comment",
        )
        candidate = {**fixture, "files": {**fixture["files"], adapter: changed}}
        m = multi.summarize(candidate["schema"], candidate["interface"])
        premises, _ = prove_cpi_validation_premises(multi, m, cpi_model, cpi_actual)
        m, result = fixture_result(multi, candidate, premises, require_full=True)
        world, executor, _, _ = parse_actual_adapter(multi, m, candidate, premises)
        check_call_bridge(multi, world, executor, m["slots"])
        results.append({"name": "comment/whitespace equivalent " + fixture["name"],
                        "result": "accepted", "adapterSha256": sha(changed),
                        "claims": len(result["claims"])})
    fixture = fixtures[0]
    adapter = fixture["adapter"]
    original = fixture["files"][adapter]
    hoisted = replace_once(
        original,
        "if(transfers[i].active) for(unsigned j=0;j<transfers[i].count;++j)",
        "if(transfers[i].active) { unsigned meta_count=transfers[i].count; for(unsigned j=0;j<meta_count;++j)",
        "hoisted local meta count",
    )
    hoisted = replace_once(hoisted, "return 22; }", "return 22; } }",
                           "close hoisted active-meta block")
    candidate = {**fixture, "files": {**fixture["files"], adapter: hoisted}}
    m = multi.summarize(candidate["schema"], candidate["interface"])
    premises, _ = prove_cpi_validation_premises(multi, m, cpi_model, cpi_actual)
    m, result = fixture_result(multi, candidate, premises, require_full=True)
    world, executor, _, _ = parse_actual_adapter(multi, m, candidate, premises)
    check_call_bridge(multi, world, executor, m["slots"])
    check_meta_loop_connection(world, executor, m["slots"], cpi_model, cpi_actual)
    results.append({"name":"hoisted local meta count", "result":"accepted",
                    "adapterSha256":sha(hoisted), "claims":len(result["claims"])})
    before_validation = replace_once(
        original, "for(unsigned i=0;i<2;++i) { u64 error=",
        "for(unsigned i=0;i<2;++i) { unsigned c0=transfers[i].count; u64 error=",
        "hoist scalar count before validation")
    before_validation = replace_once(before_validation, "j<transfers[i].count;", "j<c0;",
                                     "use scalar count hoisted before validation")
    candidate = {**fixture, "files": {**fixture["files"], adapter: before_validation}}
    checked = analyze_fixture(multi, cpi_model, cpi_actual, candidate)
    results.append({"name": "scalar count hoisted before validation", "result": "accepted",
                    "adapterSha256": sha(before_validation),
                    "bridgeSolverQueries": checked["bridgeSolverQueries"]})
    return results


def solver_sat_witness(formula, label, witness_values=()):
    solver = z3.Solver()
    solver.set(timeout=30000)
    solver.add(formula)
    result = solver.check()
    if result == z3.unknown:
        raise Fatal(f"{label}: Z3 UNKNOWN: {solver.reason_unknown()}")
    need(result == z3.sat, f"{label}: expected a SAT mismatch witness")
    model = solver.model()
    return {
        "label": label,
        "completeModel": [
            {"name": str(decl), "value": str(model[decl])}
            for decl in sorted(model.decls(), key=lambda item: str(item))
        ],
        "witnessValues": [
            {"name": name, "value": str(model.eval(expression, model_completion=True))}
            for name, expression in witness_values
        ],
    }


def legacy_interpreter_accepts(multi, fixture):
    m = multi.summarize(fixture["schema"], fixture["interface"])
    result = multi.analyse(m, fixture, fixture["files"], require_witnesses=False)
    return m, result


def bridge_negative_checks(multi, cpi_model, cpi_actual, fixture):
    """Actual C, axiom, and parsed-observation negatives, reported separately.

    Observation faults exercise solver obligations but are not C mutants.
    Removing one solver query and admitting a fault is a local sensitivity test,
    not evidence that a separately launched whole gate exited unsuccessfully.
    """
    m = multi.summarize(fixture["schema"], fixture["interface"])
    premises, _ = prove_cpi_validation_premises(multi, m, cpi_model, cpi_actual)
    baseline_world, baseline_executor, _, _ = parse_actual_adapter(multi, m, fixture, premises)
    check_call_bridge(multi, baseline_world, baseline_executor, m["slots"])
    check_meta_loop_connection(baseline_world, baseline_executor, m["slots"], cpi_model, cpi_actual)
    need([q["name"] for q in baseline_world.bridge_queries] == required_bridge_queries(m["slots"]),
         "negative control is missing bridge solver queries")
    def clone():
        world=copy.copy(baseline_world);world.paths=copy.deepcopy(baseline_world.paths);world.bridge_queries=[]
        executor=copy.copy(baseline_executor);executor.w=world
        for key in ['effect_reads','meta_reads','loop_bounds']:setattr(executor,key,copy.deepcopy(getattr(baseline_executor,key)))
        return world,executor

    def change(kind,world,executor):
        if kind=='count':
            for p in world.paths:
                for e in p.events:
                    if e.kind=='validate':e.count=z3.If(z3.Extract(31,0,world.COUNT)==4,z3.BitVecVal(5,32),z3.BitVecVal(4,32))
        elif kind=='bump':
            for p in world.paths:
                for e in p.events:
                    if e.kind=='execute':e.bump=world.BUMP+z3.BitVecVal(1,8)
        elif kind=='status':
            for p in world.paths:
                if any(e.kind=='execute' for e in p.events):
                    p.pc=z3.And(z3.substitute(p.pc,(world.VAL[0],z3.BitVecVal(0,64))),world.VAL[0]==1)
        elif kind=='range':
            for p in world.paths:
                p.pc=z3.And(z3.substitute(p.pc,(world.COUNT,z3.BitVecVal(m['minimum'],64))),world.COUNT==13)
        elif kind=='loop':
            ids={item['loopIds'][-1] for item in executor.meta_reads if item['slot']==0}
            for b in executor.loop_bounds:
                if b['id'] in ids:b['value']=b['value']+z3.BitVecVal(1,b['value'].size())
        elif kind=='meta':
            for item in executor.meta_reads:
                if item['slot']==0:item['index']=8
        else:raise AssertionError(kind)

    labels = dict(zip(['status', 'count', 'bump', 'range'], required_bridge_queries(0)))
    labels['loop'] = 'bridge: slot 0 meta loop bound is not its own extracted effect count'
    labels['meta'] = 'bridge: slot 0 meta reads lack the validated active count bound'
    observation_faults = []
    for kind, label in labels.items():
        world, executor = clone()
        change(kind, world, executor)
        def bridge():
            if kind in ['status', 'count', 'bump', 'range']:
                check_call_bridge(multi, world, executor, m['slots'])
            else:
                check_meta_loop_connection(world, executor, m['slots'], cpi_model, cpi_actual)
        try:
            bridge()
        except BridgeSemantic as error:
            need(error.label == label, f"{kind}: observation fault rejected by wrong query: {error.label}")
            row = {'kind': kind, 'query': label, 'counterexample': error.witness}
        else:
            raise Fatal('parsed-observation fault survived: ' + kind)
        saved = globals()['require_unsat']
        def skip(world, formula, name, premises=()):
            if name != label:
                return saved(world, formula, name, premises)
        try:
            globals()['require_unsat'] = skip
            world, executor = clone()
            change(kind, world, executor)
            bridge()
            row['survivesWithSpecificQueryDisabled'] = True
        finally:
            globals()['require_unsat'] = saved
        observation_faults.append(row)

    account_candidate = {**fixture, 'files': mutate_account_array(fixture['files'])}
    legacy_interpreter_accepts(multi, account_candidate)
    world, executor, _, _ = parse_actual_adapter(multi, m, account_candidate, premises)
    try:
        check_call_bridge(multi, world, executor, m['slots'])
    except BridgeSemantic as error:
        need('validator does not receive the parsed accounts array' in error.label,
             'separate account array rejected for wrong reason')
        account_array = {'reason': error.label, 'counterexample': error.witness,
                         'legacyInterpreterAccepted': True}
    else:
        raise Fatal('separate account array C mutant survived')

    original = multi.MultiWorld.cpi_validation_assumptions
    def unconditional(world):
        src = (world.m['accepted'], 1)
        return [z3.ULE(world.eff(src, slot, 'count'), z3.BitVecVal(8, 32))
                for slot in range(world.m['slots'])]
    try:
        multi.MultiWorld.cpi_validation_assumptions = unconditional
        legacy_interpreter_accepts(multi, fixture)
        try:
            audit_cpi_assumption_interface(multi, m)
        except Fatal as error:
            need('exposed assumptions differ from the exact active-success/count implication' in str(error),
                 'unconditional assumption rejected for wrong reason')
            assumption = {'reason': str(error), 'legacyInterpreterAccepted': True}
        else:
            raise Fatal('unconditional count assumption passed audit')
    finally:
        multi.MultiWorld.cpi_validation_assumptions = original

    try:
        prove_cpi_validation_premises(multi, m, cpi_model, cpi_actual,
            disabled_obligations=('parsed helper return is equated to the actual adapter validation result',))
    except BridgeSemantic as error:
        need('active validator success did not bound the exact adapter count' in error.label,
             'removed helper link rejected for wrong reason')
        helper = {'reason': error.label, 'counterexample': error.witness}
    else:
        raise Fatal('removed helper return link still proves count bound')
    return {'scope': 'local sensitivity checks; observation faults are not emitted-C mutants',
            'observationFaults': observation_faults, 'accountArrayCMutation': account_array,
            'unconditionalAssumptionMutation': assumption, 'removedHelperLink': helper}


def main():
    started = time.monotonic()
    need(z3.get_version_string() == "5.1.0",
         f"Expected Z3 5.1.0, found {z3.get_version_string()}")
    need(len(sys.argv) == 3, "usage: cpi_adapter_composition.py INPUT.json RESULT.json")
    payload_path = pathlib.Path(sys.argv[1]).resolve()
    output_path = pathlib.Path(sys.argv[2]).resolve()
    pending_path = output_path.with_suffix(output_path.suffix + ".pending")
    payload = json.loads(payload_path.read_text())
    need(payload.get("runNonce") and isinstance(payload["runNonce"], str),
         "payload is missing its per-run nonce")
    need(not output_path.exists() and not pending_path.exists(),
         "refuse to overwrite an existing child receipt or pending file")
    payload_digest = sha(payload_path)
    source_root = pathlib.Path(payload["sourceRoot"]).resolve()
    source_start = source_hashes(source_root)
    checker_start = hashes(CHECKER_FILES)
    verify_hashes(payload["immutableInputs"], "before checking")
    need(z3.get_version_string() == payload["expectedZ3"], "payload Z3 pin mismatch")
    need({item["name"] for item in payload["fixtures"]} == set(REQUIRED),
         "fresh fixture coverage must be exactly cpi-2, cpi-3 and cpi-4")
    need(payload["coverage"] == list(REQUIRED), "payload coverage declaration mismatch")
    need(payload.get("compiler") and payload.get("fixtures"),
         "compiler-generated fixture receipt is incomplete")
    multi, cpi, cpi_validate = load_reused(source_root)
    for fixture in payload["fixtures"]:
        need(fixture["interface"]["version"] == 2,
             f"{fixture['name']}: emitted interface is not ABI2")
        need(fixture["interface"]["effects"] == "cpi-v1",
             f"{fixture['name']}: emitted effect type is not CPI v1")
        need(fixture["artifactPaths"] and fixture["files"],
             f"{fixture['name']}: artifact/include closure is incomplete")
        for name, digest in fixture["artifactHashes"].items():
            path = pathlib.Path(name)
            need(path.is_file() and sha(path) == digest,
                 f"{fixture['name']}: artifact changed before proof: {name}")
        for name, content in fixture["files"].items():
            expected = fixture["artifactPaths"].get(name)
            need(expected is not None and pathlib.Path(expected).is_file(),
                 f"{fixture['name']}: missing include closure artifact {name}")
            need(pathlib.Path(expected).read_text() == content,
                 f"{fixture['name']}: in-memory include closure differs from disk: {name}")
    runtime, runtime_bytes = cpi.load_runtime()
    for name, data in runtime_bytes.items():
        for fixture in payload["fixtures"]:
            closure_files = fixture["files"]
            need(name in closure_files and closure_files[name].encode() == data,
                 f"{fixture['name']}: runtime/helper byte mismatch between its actual ABI2 include closure and CPI proof: {name}")
            need(pathlib.Path(fixture["artifactPaths"][name]).resolve()
                 == (source_root / "runtime" / name).resolve(),
                 f"{fixture['name']}: runtime include did not resolve under selected source root: {name}")
    cpi_model, cpi_interpreter, cpi_actual, validator_claims = cpi.validator_relation(runtime)
    executor_audit = cpi.audit_executor(runtime)
    need(executor_audit["result"] == "accepted restricted live-body grammar",
         "actual CPI executor did not match its reviewed inactive-first body")
    validator_results = []
    for name, claim in validator_claims.items():
        cpi_validate.solve(cpi_model, z3.Not(claim), "unsat")
        validator_results.append({"name": name, "result": "unsat"})
    active_success, conditional_facts, helper_witnesses = cpi.prove_conditional_validator_facts(
        cpi_model, cpi_actual)
    need(any(
        item["name"] == "active success bounds meta count to 8" and item["result"] == "unsat"
        for item in conditional_facts
    ), "actual parsed CPI helper did not establish the required active count bound")
    unknown_probe = cpi.unknown_solver_probe(cpi_model)
    need(unknown_probe["forcedUnknownRejected"],
         "Z3 UNKNOWN was not rejected by the reused CPI solver")

    positive = []
    for fixture in payload["fixtures"]:
        positive.append(analyze_fixture(multi, cpi_model, cpi_actual, fixture))
    by_name = {item["name"]: item for item in payload["fixtures"]}
    cpi_two = by_name["cpi-2"]
    semantic_mutants = []
    grammar_rejections = []
    for case in adapter_mutations(cpi_two):
        try:
            semantic_mutants.append(
                reject_mutation(multi, cpi_model, cpi_actual, cpi_two, case))
        except BridgeSemantic as error:
            semantic_mutants.append({"name": case[0], "kind": "semantic",
                                     "reason": error.label, "counterexample": error.witness})
    grammar_rejections.append(grammar_mutation(multi, cpi_model, cpi_actual, cpi_two))
    bridge_negatives = bridge_negative_checks(
        multi, cpi_model, cpi_actual, cpi_two)
    equivalents = equivalent_variants(multi, cpi_model, cpi_actual, payload["fixtures"])
    need(len(semantic_mutants) == 9, "semantic mutation matrix is incomplete")
    required_mutants = {
        "wrong validation effect slot",
        "wrong validation count",
        "constant custody bump",
        "dropped CPI validation",
        "truncated validation status width",
        "validation status checked after managed-state scan",
        "meta loop takes count from a different effect slot",
        "execute before every validation succeeds",
        "managed account alias preflight removed",
    }
    need({item["name"] for item in semantic_mutants} == required_mutants,
         "semantic mutation names do not match the required bridge cases")
    need(all(item["kind"] == "semantic" and item.get("counterexample")
             for item in semantic_mutants),
         "every semantic mutation must carry a model counterexample")
    need({item['kind'] for item in bridge_negatives['observationFaults']} ==
         {'status', 'count', 'bump', 'range', 'loop', 'meta'}, 'observation fault matrix incomplete')
    need(grammar_rejections and all(item["kind"] == "grammar" and item.get("reason")
                                    for item in grammar_rejections),
         "grammar rejection receipt is incomplete")
    need(len(equivalents) >= 2 and all(item["result"] == "accepted" for item in equivalents),
         "equivalent source forms were not accepted")

    input_end = source_hashes(source_root)
    checker_end = hashes(CHECKER_FILES)
    need(input_end == source_start, "reused source/runtime inputs changed while checking")
    need(checker_end == checker_start, "new checker source changed while checking")
    verify_hashes(payload["immutableInputs"], "after checking")
    need(sha(payload_path) == payload_digest, "fixture payload changed while checking")
    for fixture in payload["fixtures"]:
        for name, digest in fixture["artifactHashes"].items():
            need(sha(pathlib.Path(name)) == digest,
                 f"{fixture['name']}: artifact changed while checking: {name}")

    report = {
        "passed": True,
        "z3": z3.get_version_string(),
        "solverFailureBehavior": {
            **unknown_probe,
            "solverTimeoutMs": 30000,
            "hostChildTimeoutMs": payload["hostChildTimeoutMs"],
            **payload["parentProbes"],
            "parentNonzeroProbeRejected": payload["parentProbes"]["nonzeroRejected"],
            "partialReceiptProbeRejected": payload["parentProbes"]["partialReceiptRejected"],
        },
        "scope": (
            "Conditional composition for fresh compiler-emitted pure-CPI ABI2 adapters "
            "with two CPI slots and two, three or four managed state accounts. The gate "
            "parses actual adapter control flow, reuses the parsed CPI validator, and "
            "connects its active count<=8 implication to the same extracted effect slot, "
            "Account array, invocation count and validation return used by the adapter."
        ),
        "coverage": [
            {"fixture": item["name"], "managedStates": item["managedStates"],
             "effectSlots": item["effectSlots"]} for item in positive
        ],
        "inputs": {
            "runNonce": payload["runNonce"],
            "payloadSha256": payload_digest,
            "sourceRoot": str(source_root),
            "helperRuntimeIncludeClosureByFixture": [
                {
                    "fixture": fixture["name"],
                    "selectedSourceRoot": fixture["helperRuntimeRoot"],
                    "files": fixture["helperRuntimeFiles"],
                }
                for fixture in payload["fixtures"]
            ],
            "compiler": payload["compiler"],
            "immutableSourceAndArtifactInputs": payload["immutableInputs"],
            "reusedSourceHashes": source_start,
            "checkerHashes": checker_start,
            "runtimeHelperBytes": {
                name: sha(data) for name, data in sorted(runtime_bytes.items())
            },
            "runtimeIncludeClosure": sorted(runtime_bytes),
        },
        "conditionalConnection": {
            "result": "established for the exact recorded generated fixtures under listed assumptions",
            "validatorComponent": {
                "actualParsedHelper": True,
                "claims": validator_results,
                "conditionalFacts": conditional_facts,
                "activeSuccessWitnesses": helper_witnesses,
                "requiredFact": "active!=0 && bend_invoke_validate(...)==0 implies count<=8",
            },
            "executorComponent": {
                "actualRuntimeBody": executor_audit,
                "inactiveEffect": (
                    "The exact executor body returns on inactive effects before reading "
                    "the unbounded inactive count or entering the meta loop."
                ),
                "scope": (
                    "Restricted token grammar for the exact recorded live helper body; "
                    "not general C execution or syscall semantics."
                ),
            },
            "fixtures": positive,
        },
        "mutations": {
            "semanticCounterexamples": semantic_mutants,
            "bridgeNegatives": bridge_negatives,
            "grammarRejections": grammar_rejections,
            "counts": {
                "semanticCounterexamples": len(semantic_mutants),
                "parsedObservationFaults": len(bridge_negatives["observationFaults"]),
                "grammarRejections": len(grammar_rejections),
            },
        },
        "equivalents": equivalents,
        "outcomeScope": {
            "ordinaryReturns": (
                "The parsed adapter model covers explicit C return values. On every "
                "execution path the adapter reaches execution only after all validator "
                "calls returned zero."
            ),
            "runtimeOrCpiAbort": (
                "A VM/runtime/CPI abort is not an ordinary C return path and is outside "
                "the parser model. Solana transaction rollback remains a separate runtime assumption."
            ),
            "externalAccountContents": (
                "No postcondition is claimed for account contents after CPI. A prior "
                "successful CPI may have changed external account data before a later "
                "ordinary helper error or runtime abort."
            ),
            "managedAccountContents": (
                "This composition gate uses only managed-state preflight, alias checks "
                "and execution ordering from the ABI2 adapter contract. It does not "
                "import modeled state-byte postconditions across arbitrary CPI behavior."
            ),
        },
        "assumptions": [
            "Bun, Python, the proof driver and Z3 are trusted executable components. Fresh nonces and hashes reject stale replay and drift, not a driver that deliberately forges fresh evidence.",
            "The reused restricted C parser/interpreter, reviewed runtime signatures and exact recorded include closure are trusted; this is not general C semantics.",
            "The compiler/artifact hashes bind the actual generated ABI2 fixture bytes and schema, but source-to-LLVM/SBF/deployed-binary correspondence is not established here.",
            "The ABI2 adapter supplies a loader account count whose actual generated guard accepts only each fixture's declared minimum through 12; caller input is within 4..12.",
            "The CPI validator's other semantic properties are not composed to Bend business rules or arbitrary executor effects; only its active successful count bound is connected to the adapter meta scan.",
            "CPI syscall behavior preserves unrelated local effect objects while calls execute. No general aliasing or memory safety theorem is established.",
            "Custody helper seeds/PDA correctness are not proved here; the gate binds the helper's u8 output variable unchanged to each executor call.",
            "Bend root behavior, codec correctness, syscall behavior, loader behavior, SBF resource bounds, external callee behavior, and transaction atomic rollback remain separate assumptions.",
        ],
        "notClaimed": [
            "A whole-program or end-to-end verified compiler theorem.",
            "Opcode, program authorization, arbitrary CPI semantics, or preservation of external account data.",
            "Runtime abort behavior or transaction rollback as a theorem.",
            "Custody PDA/seeds derivation correctness.",
            "Any ABI3 behavior or fixtures.",
        ],
        "elapsedSeconds": round(time.monotonic() - started, 3),
    }
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    pending_path.write_text(json.dumps(report, indent=2) + "\n")
    pending_path.replace(output_path)
    print(
        f"ABI2 CPI composition: {len(positive)} generated fixtures, "
        f"{len(semantic_mutants)} semantic model counterexamples, "
        f"{len(grammar_rejections)} grammar rejection, {len(equivalents)} equivalents; "
        f"{output_path}"
    )


if __name__ == "__main__":
    try:
        main()
    except (Fatal, BridgeSemantic, AssertionError, RuntimeError) as error:
        raise SystemExit(f"ABI2 CPI adapter composition failed: {error}")
