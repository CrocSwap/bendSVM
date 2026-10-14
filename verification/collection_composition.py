"""Fresh-run composition of ABI-3 collection helpers with the parsed caller.

This checker consumes the helper receipts and caller receipt produced by the
TypeScript parent for one run.  It reparses the exact emitted C, replays its
restricted path model, and instantiates the same versioned contract AST used
by both helper body checkers.
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import sys
from collections import Counter
from typing import Any

import z3
import collection_contracts
import collection_caller_syntax as api
import collection_lifecycle
from collection_caller_paths import Paths, check_declarations, check_run_arguments

ROOT = pathlib.Path(__file__).resolve().parent.parent


class CompositionFailure(Exception):
    pass


def sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: pathlib.Path) -> str:
    return sha_bytes(path.read_bytes())


def require(ok: bool, message: str) -> None:
    if not ok:
        raise CompositionFailure(message)


def solver(formula: z3.BoolRef, premises=(), label="query"):
    s = z3.SolverFor("QF_BV")
    s.set(timeout=30000)
    s.add(*premises, formula)
    status = s.check()
    if status == z3.unknown:
        raise CompositionFailure(f"UNKNOWN is not a proof ({label}): {s.reason_unknown()}")
    return s, status


def prove(label: str, bad: z3.BoolRef, premises=()) -> dict[str, Any]:
    if os.environ.get("COLLECTION_COMPOSITION_TEST_UNKNOWN") == "1":
        raise CompositionFailure(f"UNKNOWN is not a proof ({label}): injected UNKNOWN test status")
    s, status = solver(bad, premises, label)
    if status == z3.sat:
        model = s.model()
        values = {str(d): str(model[d]) for d in sorted(model.decls(), key=lambda d: str(d))}
        raise CompositionFailure(f"SAT composition counterexample ({label}): {json.dumps(values, sort_keys=True)}")
    return {"name": label, "result": "UNSAT", "_bad": bad, "_premises": list(premises)}


def sat_witness(label: str, formula: z3.BoolRef, fields: dict[str, z3.ExprRef], premises=()) -> dict[str, Any]:
    s, status = solver(formula, premises, label)
    if status == z3.unsat:
        raise CompositionFailure(f"composition witness is unreachable ({label})")
    model = s.model()
    return {"name": label, "result": "SAT", "values": {
        name: str(model.eval(term, model_completion=True)) for name, term in fields.items()
    }}


RUNTIME_ASSUMPTIONS = [
    "No range precondition is placed on the modeled u32 collection/window/scalar fields; length > capacity is included and select must refuse it.",
    "Collection, window, and output pointers designate valid, non-null, disjoint objects of the declared types; writable outputs have the required write permission. Pointer validity and bounds are assumed, not proved in this slice.",
    "u8/u32/u64 have widths 8/32/64 as asserted in runtime/solana_min.h; the reusable C parser, this local interpreter and Z3 bridge implement the listed restricted C semantics correctly.",
    "Only normally returning helper control flow is modeled. Clang/LLD/SBF preservation, loader behavior, codecs, roots, open/record/commit, ABI-3 callers and transaction rollback are outside scope.",
]

RUNTIME_INPUTS = {
    "runtime/bend_collection_runtime.h", "runtime/solana_min.h",
    "verification/adapter_contract_c.py", "verification/collection_contracts.py",
    "verification/collection_runtime.py", "verification/check-collection-runtime.ts",
    "tests/collection-runtime.c",
}
LIFECYCLE_INPUTS = {
    "runtime/bend_collection_runtime.h", "runtime/solana_min.h",
    "verification/collection_lifecycle.py", "verification/check-collection-lifecycle.ts",
    "verification/collection_runtime.py", "verification/adapter_contract_c.py",
    "verification/collection_contracts.py",
}

CALLER_ASSUMPTIONS = [
    "Input pointer and serialized allocation bounds are valid under the pinned loader contract. read_account refuses unsupported duplicate markers and produces truthful Account fields; key equality and little-endian reads have their specified byte semantics.",
    "open, codecs, select, plan and checked Bend roots are free of externally observable effects (including CPI, logging and return-data changes) before commit; each modeled stage is required to execute at most once on a path, and repeated invocations reject as unsupported. Helpers and codecs initialize only their specified outputs; failure preserves managed account data.",
    "The parsed open, select, record, plan and commit calls instantiate the shared bend.collection-helper-contracts/v1 typed AST. Successful open outputs feed select; select outputs feed record and plan; plan outputs and accepted record encoders feed commit. Exact object argument spellings are source grammar facts and are not reported as SMT pointer-equality claims. Run also assumes count=3, mode<=1 and initialize=(mode==0), discharged by the exact checked entry dispatch.",
    "The imported commit contract is no-fail under the accepted plan and writes exactly its specified collection bytes. Distinct local scratch objects, account objects and loaded account allocations are disjoint. Return-data syscall has its declared no-result ABI.",
    "Generated headers must match the fixed reviewed byte allowlist, independently of the candidate manifest. This restriction does not prove their bodies: codecs and Bend roots obey their recorded schema and type layouts by assumption. Context constructors and byte-read primitives have their specified pure semantics.",
    "The restricted parser, symbolic executor, Python interpreter, proof driver and Z3 are trusted. Scalar operations outside the modeled unsigned ABI subset reject rather than receive guessed C semantics.",
]


def inventory(report: dict[str, Any], name: str) -> list[dict[str, Any]]:
    values = report.get(name)
    require(isinstance(values, list), f"receipt {name} must be an array")
    return values


def exact_unsat_inventory(items: list[dict[str, Any]], expected: list[str], label: str,
                          result_token: str = "UNSAT") -> None:
    names = [item.get("name") for item in items]
    require(names == expected, f"{label} claim inventory missing, duplicate, extra or reordered")
    require(all(item.get("result") == result_token for item in items), f"{label} contains a non-UNSAT claim")


OPEN_CLAIMS = [
    "open exact ordered error/success contract", "open C reads stay within caller-provided objects",
    "open every path returns", "open return paths are exclusive", "refusal preserves output object",
    "success writes exact collection fields", "open Account object remains unchanged on success and refusal",
    "open refusal preserves the Account object", "open evaluated signed arithmetic and shifts avoid C undefined behavior",
    "open C short-circuit skips undefined arithmetic in an unevaluated operand",
    "open unsigned division/remainder yields exact capacity payload relation",
]
RECORD_CLAIMS = [
    "record size input matches its C bitvector", "record length input matches its C bitvector",
    "record capacity input matches its C bitvector", "record stride input matches its C bitvector",
    "record start input matches its C bitvector", "record reserved input matches its C bitvector",
    "record loaded input matches its C bitvector", "record local input matches its C bitvector",
    "record exact null/non-null guard", "record address is exact 56 + (start + local) * stride",
    "record u32 index addition does not wrap", "record C-width address arithmetic does not wrap",
    "record returned stride lies within opened allocation", "record names a logical active record",
    "record intermediate pointer formations and evaluated byte reads stay within caller-provided objects",
]
COMMIT_CLAIMS = [
    "commit size input matches its C bitvector", "commit length input matches its C bitvector",
    "commit capacity input matches its C bitvector", "commit stride input matches its C bitvector",
    "commit start input matches its C bitvector", "commit reserved input matches its C bitvector",
    "commit loaded input matches its C bitvector", "commit written input matches its C bitvector",
    "commit next length input matches its C bitvector", "commit scratch extent input matches its C bitvector",
    "commit exact header/length/key/window bytes and unchanged outside",
    "commit writes the planned logical length", "commit record range stays disjoint from header",
    "commit parsed pointer formations and byte spans match bounded object ranges",
    "commit C-width count, stride and address calculations do not wrap",
    "commit actual C subscripts match summarized copy addresses",
    "commit copy summaries match C address/count values and terminate",
]
LIFECYCLE_CLAIMS = OPEN_CLAIMS + RECORD_CLAIMS + COMMIT_CLAIMS

RUNTIME_HISTOGRAMS = {
    "select": {
        "select: source paths cover all u32 inputs": 1,
        "select: exact return and output contract": 1,
        "select: evaluated u32 subtraction cannot underflow": 5,
        "select: output fields do not mutate on refusal": 1,
        "select: exact start/reserved/loaded outputs on success": 1,
        "select: collection input is unchanged": 1,
    },
    "plan": {
        "plan: source paths cover all u32 inputs": 1,
        "plan: exact return and output contract": 1,
        "plan: evaluated u32 subtraction cannot underflow": 34,
        "plan: collection and window inputs are unchanged": 1,
    },
}
RANGE_HISTOGRAMS = {
    "select": {name: 1 for name in [
        "select: start is within old logical length", "select: reservation addition does not wrap",
        "select: reserved end is within capacity", "select: loaded count does not exceed reservation",
        "select: loaded end addition does not wrap", "select: loaded end is within old logical length",
    ]},
    "plan": {name: 1 for name in [
        "plan: written record count fits selected reservation", "plan: written range addition does not wrap",
        "plan: written range fits collection capacity", "plan: loaded prefix is retained by count",
        "plan: next logical length is bounded", "plan: additions equal logical length growth",
        "plan: appends extend exactly from old tail", "plan: loaded end addition does not wrap",
        "plan: old length plus additions does not wrap",
        "plan: old plus appended count equals next length without u32 wrap",
    ]},
}
FIRST_REFUSAL = {
    "select": [
        "select first refusal: length_exceeds_capacity", "select first refusal: start_exceeds_length",
        "select first refusal: count_exceeds_maximum", "select refusal guard 3: unreachable after earlier guards",
        "select first refusal: count_exceeds_remaining_capacity",
    ],
    "plan": [
        "plan first refusal: nested_select_refuses", "plan first refusal: selected_loaded_mismatch",
        "plan first refusal: written_below_loaded", "plan first refusal: written_above_reserved",
        "plan first refusal: next_length_below_old", "plan first refusal: next_length_above_capacity",
        "plan refusal guard 6: unreachable after earlier guards",
        "plan first refusal: append_count_differs_from_length_delta",
    ],
}


def validate_helper_reports(runtime: dict[str, Any], lifecycle: dict[str, Any], run_id: str) -> list[str]:
    require(runtime.get("compositionRunId") == run_id, "runtime helper receipt has a stale or mixed run id")
    require(lifecycle.get("compositionRunId") == run_id, "lifecycle helper receipt has a stale or mixed run id")
    require(runtime.get("status") == "PASS" and runtime.get("passed") is True,
            "runtime helper receipt is not a fresh PASS")
    require(lifecycle.get("status") == "PASS" and lifecycle.get("passed") is True,
            "lifecycle helper receipt is not a fresh PASS")
    require(runtime.get("assumptions") == RUNTIME_ASSUMPTIONS, "runtime helper assumptions were narrowed or changed")
    require(lifecycle.get("assumptions") == collection_lifecycle.EXPECTED_ASSUMPTIONS,
            "lifecycle helper assumptions, including the span/BV caveat, were narrowed or changed")
    require(runtime.get("contractInterface") == collection_contracts.CONTRACT_DOCUMENT and
            runtime.get("contractInterfaceHash") == collection_contracts.CONTRACT_INTERFACE_HASH,
            "runtime contract AST changed or does not match the shared source interface")
    require(lifecycle.get("contractInterface") == collection_contracts.CONTRACT_DOCUMENT and
            lifecycle.get("contractInterfaceHash") == collection_contracts.CONTRACT_INTERFACE_HASH,
            "lifecycle contract AST changed or does not match the shared source interface")
    for report, names, label in ((runtime, RUNTIME_INPUTS, "runtime"),
                                 (lifecycle, LIFECYCLE_INPUTS, "lifecycle")):
        hashes = report.get("source_hashes_at_start")
        require(isinstance(hashes, dict) and set(hashes) == names,
                f"{label} source hash inventory missing, duplicate or extra")
        require(all(isinstance(value, str) and len(value) == 64 and
                    all(ch in "0123456789abcdef" for ch in value) for value in hashes.values()),
                f"{label} source hash malformed")
        require(report.get("source_hashes_at_end") == hashes and
                report.get("source_hashes_at_publication") == hashes,
                f"{label} source hash receipt drifted during its child run")
    require(runtime.get("source_hash_comparison") == "MATCH" and
            lifecycle.get("source_hash_comparison") == "MATCH",
            "helper source hash comparison is not MATCH")
    require(lifecycle.get("inputs") == lifecycle.get("source_hashes_at_start"),
            "lifecycle source hash inventory differs from its inputs")
    expected_lifecycle_imports = {
        "verification/collection_runtime.py", "verification/adapter_contract_c.py",
        "verification/collection_contracts.py",
    }
    require(isinstance(lifecycle.get("helperImports"), dict) and
            set(lifecycle["helperImports"]) == expected_lifecycle_imports,
            "lifecycle helper-import inventory missing, duplicate or extra")
    require(all(lifecycle["helperImports"][name] == lifecycle["inputs"][name]
                for name in expected_lifecycle_imports),
            "lifecycle helper imports are not hash-bound to this run")
    rp = runtime.get("proofs")
    require(isinstance(rp, dict) and set(rp) == {"select", "plan"}, "runtime helper proof sections changed")
    for kind in ("select", "plan"):
        section = rp[kind]
        obs = section.get("obligations")
        rng = section.get("range_and_append_obligations")
        first = section.get("first_refusal_witnesses")
        require(isinstance(obs, list) and dict(Counter(x.get("label") for x in obs)) == RUNTIME_HISTOGRAMS[kind],
                f"runtime {kind} obligation inventory changed")
        require(all(x.get("result") == "UNSAT" for x in obs), f"runtime {kind} has a non-UNSAT obligation")
        require(isinstance(rng, list) and dict(Counter(x.get("label") for x in rng)) == RANGE_HISTOGRAMS[kind],
                f"runtime {kind} range/append inventory changed")
        require(all(x.get("result") == "UNSAT" for x in rng), f"runtime {kind} has a non-UNSAT range claim")
        require(isinstance(first, list) and [x.get("label") for x in first] == FIRST_REFUSAL[kind],
                f"runtime {kind} refusal witness inventory changed")
        require(all(x.get("result") in ("SAT", "UNREACHABLE") for x in first),
                f"runtime {kind} refusal witness malformed")
    exact_unsat_inventory(inventory(lifecycle, "claimResults"), LIFECYCLE_CLAIMS, "lifecycle", "unsat")
    commit_ast = collection_contracts.CONTRACT_DOCUMENT["contracts"]["commit"]
    expected_imports = [{
        "contractFormula": formula,
        "source": binding["source"],
        "sourceClaims": binding["claims"],
        "disposition": "CHECKED_BY_FRESH_COMPOSITION_PARENT",
    } for formula, binding in zip(commit_ast["precondition"]["args"], commit_ast["preconditionImports"])]
    require(len(expected_imports) == len(commit_ast["precondition"]["args"]),
            "shared commit precondition import table is incomplete")
    require(lifecycle.get("commit", {}).get("contractPreconditionImports") == expected_imports,
            "lifecycle precondition imports differ from the shared contract AST")
    runtime_unsat = {item["label"] for kind in ("select", "plan")
        for field in ("obligations", "range_and_append_obligations")
        for item in rp[kind][field] if item.get("result") == "UNSAT"}
    lifecycle_unsat = {item["name"] for item in lifecycle["claimResults"] if item.get("result") == "unsat"}
    for item in expected_imports:
        if item["source"] in ("select", "plan"):
            require(set(item["sourceClaims"]) <= runtime_unsat,
                    "precondition import names an absent or non-UNSAT runtime helper claim")
        elif item["source"] == "open":
            require(set(item["sourceClaims"]) <= lifecycle_unsat,
                    "precondition import names an absent or non-UNSAT open helper claim")
        else:
            require(item["source"] == "composition" and item["sourceClaims"] == [
                "eight-byte record scratch covers written times four-byte stride"],
                "precondition import names an unexpected caller claim")
    return sorted({item["label"] for kind in ("select", "plan")
                   for field in ("obligations", "range_and_append_obligations")
                   for item in rp[kind][field]} | set(LIFECYCLE_CLAIMS))


CALLER_COMPOSITION_PRECONDITIONS = [
    "record 0 read within loaded window",
    "record 1 read within loaded window",
    "commit consumes an accepted bounded plan",
    "commit consumes initialized state encoding",
    "commit consumes initialized record 0",
    "commit consumes initialized record 1",
]


def checked_caller_preconditions(paths: Paths, proofs: list[dict[str, Any]]) -> list[dict[str, str]]:
    proof_inventory = Counter(item.get("name") for item in proofs)
    check_inventory: dict[str, list[z3.BoolRef]] = {}
    for name, formula in paths.checks:
        check_inventory.setdefault(name, []).append(formula)
    rows = []
    for name in CALLER_COMPOSITION_PRECONDITIONS:
        require(proof_inventory[name] == 1 and check_inventory.get(name) and
                len(check_inventory[name]) == 1,
                f"fresh caller proof lacks the unique required precondition: {name}")
        proof = next(item for item in proofs if item.get("name") == name)
        require(proof.get("result") == "unsat", f"caller precondition was not proved: {name}")
        rows.append({"name": name, "result": "UNSAT", "formula": check_inventory[name][0].sexpr(),
                     "disposition": "REPROVED_FROM_FRESH_PARSED_CALLER"})
    return rows


EXPECTED_OBSERVATIONS = [
    ("bend_collection_open", ["&accounts[2]", "program", "state->key", "collection_header", "4", "initialize", "&collection"], "open_error", None),
    ("bend_collection_select", ["&collection", "selection.as.c1.f0.as.c0.f0", "selection.as.c1.f0.as.c0.f1", "2", "&selected"], "select_ok", None),
    ("bend_collection_record", ["&collection", "&selected", "0"], None, "record_pointer_0"),
    ("bend_collection_record", ["&collection", "&selected", "1"], None, "record_pointer_1"),
    ("bend_collection_plan", ["&collection", "&selected", "written", "next"], "plan_ok", None),
    ("bend_collection_commit", ["&collection", "&selected", "written", "next", "encoded_records", "collection_header", "state->key"], None, None),
]


def _b32(value: int) -> z3.BitVecRef:
    return z3.BitVecVal(value, 32)


def _b64(value: int) -> z3.BitVecRef:
    return z3.BitVecVal(value, 64)


def _and_event(paths: Paths, name: str, property: z3.BoolRef) -> z3.BoolRef:
    return z3.And(paths.events.get(name, z3.BoolVal(False)), z3.Not(property))


def compose_queries(paths: Paths, caller_preconditions: list[dict[str, str]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    checked_names = [row["name"] for row in caller_preconditions]
    require(checked_names == CALLER_COMPOSITION_PRECONDITIONS,
            "fresh caller precondition inventory missing, extra or reordered")
    check_formulas = {name: formula for name, formula in paths.checks}
    base = [*paths.constraints, *(check_formulas[name] for name in checked_names)]
    q: list[dict[str, Any]] = []
    inp = paths.input
    event = lambda name: paths.events.get(name, z3.BoolVal(False))

    open_status = inp("open_error", 64)
    open_scalars = paths.observation_terms[0]
    q.append(prove("open call status is the shared ordered open contract",
        z3.And(event("open"), open_status != paths.open_contract["status"]), base))
    q.append(prove("successful open outputs feed collection length and capacity",
        z3.And(event("open"), open_status == 0,
               z3.Or(paths.opened_length != paths.open_contract["outputs"]["length"],
                     paths.opened_capacity != paths.open_contract["outputs"]["capacity"],
                     paths.opened_stride != _b32(4),
                     open_scalars[4] != _b32(4),
                     open_scalars[5] != paths.input("initialize"))), base))

    selector_start = paths.u32("selector_start")
    selection_count = paths.u32("selection_count")
    select_scalars = paths.observation_terms[1]
    select_ok = inp("select_ok", 1) != 0
    q.append(prove("parsed select scalar arguments and status match the shared select contract",
        z3.And(event("select_window"), z3.Or(
            paths.select_contract["status"] != z3.If(select_ok, _b32(1), _b32(0)),
            select_scalars[1] != selector_start,
            select_scalars[2] != selection_count,
            select_scalars[3] != _b32(2),
            paths.select_contract["outputs"]["start"] != paths.u32("start"),
            paths.select_contract["outputs"]["reserved"] != paths.u32("reserved"),
            paths.select_contract["outputs"]["loaded"] != paths.u32("loaded"))), base))
    q.append(prove("successful select establishes the full bounded window precondition",
        z3.And(event("select_window"), select_ok, z3.Not(paths.select_contract["success"])), base))
    q.append(prove("successful open establishes well-formed collection metadata",
        z3.And(event("open"), open_status == 0,
            z3.Or(z3.UGT(paths.opened_length, paths.opened_capacity),
                  paths.opened_stride != _b32(4))), base))

    record_contracts = []
    for i in range(2):
        name = f"record_{i}"
        rc = paths.record_contracts[i]
        record_contracts.append(rc)
        record_scalar = paths.observation_terms[2 + i][2]
        record_event = event(f"record_decode_{i}")
        q.append(prove(f"record {i} call is reachable only for a loaded local index",
            z3.And(record_event, z3.ULE(paths.u32("loaded"), _b32(i))), base))
        q.append(prove(f"record {i} returns the contract pointer for the parsed call",
            z3.And(record_event, z3.Or(
                z3.Bool(f"record_pointer_{i}_nonnull") != rc["result_nonnull"],
                z3.BitVec(f"record_pointer_{i}_offset", 64) != rc["result_offset"],
                record_scalar != _b32(i))), base))
        q.append(prove(f"record {i} four-byte decode lies inside the active record",
            z3.And(record_event, rc["active"], z3.Not(rc["activeSpan"])), base))

    plan_ok = inp("plan_ok", 1) != 0
    plan_success = paths.plan_contract["success"]
    plan_scalars = paths.observation_terms[4]
    q.append(prove("parsed plan status matches the shared plan contract",
        z3.And(event("plan"), z3.Or(
            paths.plan_contract["status"] != z3.If(plan_ok, _b32(1), _b32(0)),
            plan_scalars[2] != paths.u32("written"),
            plan_scalars[3] != paths.u32("next"))), base))
    q.append(prove("successful plan establishes every record and append precondition",
        z3.And(event("plan"), plan_ok, z3.Not(paths.plan_contract["success"])), base))
    q.append(prove("accepted plan keeps written count, next length and append tail bounded",
        z3.And(event("plan"), plan_ok,
            z3.Or(z3.ULT(paths.u32("written"), paths.u32("loaded")),
                  z3.UGT(paths.u32("written"), paths.u32("reserved")),
                  z3.ULT(paths.u32("next"), paths.opened_length),
                  z3.UGT(paths.u32("next"), paths.opened_capacity),
                  z3.Not(plan_success))), base))

    commit_scalars = paths.observation_terms[5]
    commit_environment = {
        "byte_index": z3.BitVec("composition_commit_byte_index", 64),
        "data_size": inp("collection_size", 64), "next_length": paths.u32("next"),
        "post_data_byte": z3.BitVec("composition_commit_post_byte", 8),
        "old_data": z3.Array("composition_old_data", z3.BitVecSort(64), z3.BitVecSort(8)),
        "encoded": z3.Array("composition_encoded_records", z3.BitVecSort(64), z3.BitVecSort(8)),
        "header": z3.Array("composition_collection_header", z3.BitVecSort(64), z3.BitVecSort(8)),
        "state_key": z3.Array("composition_state_key", z3.BitVecSort(64), z3.BitVecSort(8)),
        "start": paths.u32("start"), "stride": paths.opened_stride,
        "written": commit_scalars[2], "capacity": paths.opened_capacity,
        "length": paths.opened_length, "reserved": paths.u32("reserved"),
        "loaded": paths.u32("loaded"), "scratch_extent": _b64(8),
    }
    commit_instance = collection_contracts.instantiate("commit", commit_environment)
    imported_open_extent_claim = "open unsigned division/remainder yields exact capacity payload relation"
    commit_event = event("commit")
    q.append(prove("commit executes only after an accepted plan and successful encoders",
        z3.And(commit_event, z3.Or(z3.Not(plan_ok),
            inp("state_encode", 1) == 0,
            z3.And(z3.UGT(paths.u32("written"), _b32(0)), inp("record_encode_0", 1) == 0),
            z3.And(z3.UGT(paths.u32("written"), _b32(1)), inp("record_encode_1", 1) == 0))), base))
    q.append(prove("commit call satisfies every shared precondition including allocation extent",
        z3.And(commit_event, z3.Or(z3.Not(commit_instance["precondition"]),
            commit_scalars[2] != paths.u32("written"),
            commit_scalars[3] != paths.u32("next"))), base))
    q.append(prove("eight-byte record scratch covers written times four-byte stride",
        z3.And(commit_event, z3.UGT(commit_instance["recordCount"], _b64(8))), base))
    q.append(prove("successful commit path reaches both state writes and return data",
        z3.And(commit_event, z3.Or(z3.Not(event("state_header_write")),
                                  z3.Not(event("state_payload_write")),
                                  z3.Not(event("return_data")))), base))
    q.append(prove("open, select and plan refusal exits do not reach commit",
        z3.Or(z3.And(event("open"), open_status != 0, commit_event),
              z3.And(event("select_window"), z3.Not(select_ok), commit_event),
              z3.And(event("plan"), z3.Not(plan_ok), commit_event)), base))
    return q, {"record": record_contracts, "commit": commit_instance, "planSuccess": plan_success,
               "importedOpenExtentClaim": imported_open_extent_claim}


BRIDGE_QUERY_DEPENDENCIES = {
    "open call status is the shared ordered open contract": ["open_status"],
    "successful open outputs feed collection length and capacity": ["open_outputs"],
    "parsed select scalar arguments and status match the shared select contract": ["select_status"],
    "successful select establishes the full bounded window precondition": ["select_status"],
    "successful open establishes well-formed collection metadata": ["open_outputs"],
    "record 0 returns the contract pointer for the parsed call": ["record_pointer_0"],
    "record 0 four-byte decode lies inside the active record": ["open_outputs"],
    "record 1 returns the contract pointer for the parsed call": ["record_pointer_1"],
    "record 1 four-byte decode lies inside the active record": ["open_outputs"],
    "parsed plan status matches the shared plan contract": ["plan_status"],
    "successful plan establishes every record and append precondition": ["plan_status"],
    "accepted plan keeps written count, next length and append tail bounded": ["plan_status"],
    "commit call satisfies every shared precondition including allocation extent": ["plan_status"],
}

BRIDGE_EVENT_SENSITIVITY = {
    "eight-byte record scratch covers written times four-byte stride": "commit",
    "record 0 call is reachable only for a loaded local index": "record_decode_0",
    "record 1 call is reachable only for a loaded local index": "record_decode_1",
    "commit executes only after an accepted plan and successful encoders": "commit",
    "successful commit path reaches both state writes and return data": "return_data",
    "open, select and plan refusal exits do not reach commit": "commit",
}


def bridge_sensitivity(paths: Paths, queries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """For each imported-contract claim, show its disabled link admits a SAT fault."""
    by_name = {query["name"]: query for query in queries}
    require(set(BRIDGE_QUERY_DEPENDENCIES) | set(BRIDGE_EVENT_SENSITIVITY) == set(by_name),
            "every substantive composition query must have an exact sensitivity case")
    rows = []
    for name in [query["name"] for query in queries]:
        query = by_name[name]
        if name in BRIDGE_QUERY_DEPENDENCIES:
            links = BRIDGE_QUERY_DEPENDENCIES[name]
            link_terms = [formula for link in links for formula in paths.contract_links.get(link, [])]
            require(bool(link_terms), f"bridge sensitivity has no source link for {name}")
            removed = {formula.sexpr() for formula in link_terms}
            premises = [formula for formula in query["_premises"] if formula.sexpr() not in removed]
            bad = query["_bad"]
            method = "disabled shared-contract link"
            disabled = links
        else:
            event_name = BRIDGE_EVENT_SENSITIVITY[name]
            event_formula = paths.events.get(event_name)
            require(event_formula is not None, f"bridge sensitivity has no parsed event for {name}")
            disabled_event = z3.Bool("sensitivity_disabled_event_" + event_name + "_" + str(len(rows)))
            if name == "successful commit path reaches both state writes and return data":
                # Commit and return-data reachability can simplify to the same
                # formula. Replace only the observed consequence, preserving
                # the real commit antecedent; global structural substitution
                # would also rewrite that antecedent and mask the fault.
                bad = z3.And(paths.events["commit"], z3.Or(
                    z3.Not(paths.events["state_header_write"]),
                    z3.Not(paths.events["state_payload_write"]),
                    z3.Not(disabled_event)))
            else:
                bad = z3.substitute(query["_bad"], (event_formula, disabled_event))
            premises = list(query["_premises"])
            method = "disabled parsed-control-flow event"
            disabled = [event_name]
        s, status = solver(bad, premises, "sensitivity: " + name)
        require(status == z3.sat,
                f"disabling {disabled} did not admit a counterexample to {name}")
        model = s.model()
        witness = {str(d): str(model[d]) for d in sorted(model.decls(), key=lambda d: str(d))}
        rows.append({
            "query": name,
            "method": method,
            "disabledLinks": disabled,
            "enabledQueryResult": "UNSAT",
            "disabledQueryFaultResult": "SAT",
            "disabledQueryAdmitsFault": True,
            "polarity": "negated obligation becomes satisfiable when the named link is disabled",
            "counterexample": witness,
        })
    return rows


def observation_sensitivity_faults(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Mutate parsed observations separately from emitted-C semantic mutants."""
    cases = [
        (0, "arguments", 5, "!initialize"),
        (1, "arguments", 3, "3"),
        (2, "arguments", 2, "2"),
        (3, "arguments", 1, "&collection"),
        (4, "arguments", 2, "next"),
        (5, "arguments", 6, "actor->key"),
        (0, "statusInput", None, "select_ok"),
        (1, "statusInput", None, "open_error"),
        (4, "statusInput", None, "open_error"),
        (0, "scalarBindings", "4", "(_ bv8 32)"),
        (1, "scalarBindings", "3", "(_ bv3 32)"),
        (4, "scalarBindings", "3", "(_ bv1 32)"),
        (5, "scalarBindings", "2", "(_ bv1 32)"),
        (2, "pointerResult", None, "record_pointer_1"),
        (5, "ordinal", None, 4),
        (0, "pathCondition", None, "false"),
    ]
    rows = []
    for index, field, argument, replacement in cases:
        changed = json.loads(json.dumps(observations))
        if field == "arguments":
            changed[index][field][argument] = replacement
        elif field == "scalarBindings":
            changed[index][field][argument] = replacement
        else:
            changed[index][field] = replacement
        try:
            validate_observations(changed, "observation-fault", observations)
        except CompositionFailure as error:
            rows.append({"name": f"observation {index} {field} fault", "result": "REJECTED",
                         "mechanism": "parsed-observation sensitivity", "reason": str(error)})
        else:
            raise CompositionFailure(f"parsed observation fault was accepted: {index} {field}")
    return rows


def validate_observations(observations: list[dict[str, Any]], run_id: str,
                          reparsed: list[dict[str, Any]] | None = None) -> None:
    require(isinstance(observations, list) and len(observations) == len(EXPECTED_OBSERVATIONS),
            "parsed helper call observation count changed")
    for i, (row, expected) in enumerate(zip(observations, EXPECTED_OBSERVATIONS)):
        if reparsed is not None:
            require(i < len(reparsed) and row == reparsed[i],
                    f"parsed helper observation {i} differs from the independently reparsed emitted C")
        function, args, status, pointer = expected
        require(row.get("ordinal") == i and row.get("function") == function and
                row.get("arguments") == args and row.get("statusInput") == status and
                row.get("pointerResult") == pointer,
                f"parsed helper observation {i} changed or is detached from the generated call")
        require(isinstance(row.get("pathCondition"), str) and row["pathCondition"],
                f"parsed helper observation {i} has no path condition")


def validate_artifact_bytes(caller: dict[str, Any], expected_artifact_directory: pathlib.Path
                            ) -> tuple[dict[str, pathlib.Path], dict[str, pathlib.Path]]:
    artifacts = {name: pathlib.Path(path).resolve() for name, path in caller["artifactPaths"].items()}
    includes = {name: pathlib.Path(path).resolve() for name, path in caller["includePaths"].items()}
    require(set(artifacts) == {"collection-store.c", "collection-store.h", "collection-store.wire.h",
        "collection-store.schema.json", "collection-store.interface.json", "collection-store.manifest.json"},
        "caller artifact path inventory changed")
    require("collection-store.c" in includes and "bend_collection_runtime.h" in includes and "solana_min.h" in includes,
            "caller include closure is incomplete")
    expected_artifact_directory = expected_artifact_directory.resolve()
    require(all(path.parent == expected_artifact_directory for path in artifacts.values()),
            "generated caller artifacts do not come from this run's fresh emission directory")
    expected_generated_includes = {name: artifacts[name] for name in
        ("collection-store.c", "collection-store.h", "collection-store.wire.h")}
    for name, path in expected_generated_includes.items():
        require(includes.get(name) == path, f"caller include path is not the fresh generated artifact: {name}")
    for name in ("bend_collection_runtime.h", "solana_min.h"):
        require(includes.get(name) == (ROOT / "runtime" / name).resolve(),
                f"caller runtime include is not the hash-bound project file: {name}")
    before = caller.get("inputs", {}).get("before", {})
    for name, path in includes.items():
        require(path.is_file() and before.get(name) == sha_file(path), f"caller include bytes drifted: {name}")
    artifact_key = {
        "collection-store.c": "adapterPath", "collection-store.h": "headerPath",
        "collection-store.wire.h": "wirePath", "collection-store.schema.json": "schemaPath",
        "collection-store.interface.json": "interfacePath", "collection-store.manifest.json": "manifestPath",
    }
    for name, path in artifacts.items():
        require(path.is_file() and before.get("artifact:" + artifact_key[name]) == sha_file(path),
                f"caller generated artifact bytes drifted: {name}")
    return artifacts, includes


def actual_c_mutations(source: str, schema: dict[str, Any], interface: dict[str, Any]) -> list[dict[str, Any]]:
    replacements = [
        ("open wrong Account object", "bend_collection_open(&accounts[2],program", "bend_collection_open(&accounts[1],program", "grammar"),
        ("open wrong output object", "initialize,&collection)", "initialize,&selected)", "grammar"),
        ("open wrong stride scalar", "collection_header,4,initialize", "collection_header,8,initialize", "grammar"),
        ("select wrong collection object", "bend_collection_select(&collection,", "bend_collection_select(&accounts[2],", "grammar"),
        ("select wrong maximum", "selection.as.c1.f0.as.c0.f1,2,&selected", "selection.as.c1.f0.as.c0.f1,3,&selected", "grammar"),
        ("record wrong collection object", "bend_collection_record(&collection,&selected,0)", "bend_collection_record(&accounts[2],&selected,0)", "grammar"),
        ("record wrong window object", "bend_collection_record(&collection,&selected,1)", "bend_collection_record(&collection,&collection,1)", "grammar"),
        ("plan swapped written and next", "bend_collection_plan(&collection,&selected,written,next)", "bend_collection_plan(&collection,&selected,next,written)", "grammar"),
        ("commit wrong collection object", "bend_collection_commit(&collection,", "bend_collection_commit(&accounts[2],", "grammar"),
        ("commit wrong window object", "bend_collection_commit(&collection,&selected,", "bend_collection_commit(&collection,&collection,", "grammar"),
        ("commit wrong record scratch argument", "next,encoded_records,collection_header", "next,encoded_state,collection_header", "grammar"),
        ("commit wrong state key", "encoded_records,collection_header,state->key)", "encoded_records,collection_header,actor->key)", "grammar"),
        ("open error check returns success", "if(error)return error;", "if(error)return 0;", "semantic"),
        ("select refusal check returns success", "&selected))return 23;", "&selected))return 0;", "semantic"),
        ("record zero guard admits inactive slot", "selected.loaded>0&&", "selected.loaded>=0&&", "semantic"),
        ("plan refusal check returns success", "bend_collection_plan(&collection,&selected,written,next))return 9;", "bend_collection_plan(&collection,&selected,written,next))return 0;", "semantic"),
        ("missing active record encoding", "if(written>0&&!bend_U32_encode(encoded_records+0,4,&(*after).as.c0.f1.as.c0.f1.as.c0.f0))return 9;", "", "semantic"),
        ("state writes reordered", "__builtin_memcpy(state->data,state_header,20);\n  __builtin_memcpy(state->data+20,encoded_state,5);", "__builtin_memcpy(state->data+20,encoded_state,5);\n  __builtin_memcpy(state->data,state_header,20);", "semantic"),
        ("commit call moved before plan", "if(!bend_collection_plan(&collection,&selected,written,next))return 9;\n  u8 encoded_state[5],encoded_records[8];\n  if(!bend_State_encode(encoded_state,5,&result.as.c0.f0))return 9;\n  if(written>0&&!bend_U32_encode(encoded_records+0,4,&(*after).as.c0.f1.as.c0.f1.as.c0.f0))return 9;\n  if(written>1&&!bend_U32_encode(encoded_records+4,4,&(*after).as.c0.f1.as.c0.f1.as.c0.f1))return 9;\n  (void)count;\n  bend_collection_commit(&collection,&selected,written,next,encoded_records,collection_header,state->key);", "u8 encoded_state[5],encoded_records[8];\n  if(!bend_State_encode(encoded_state,5,&result.as.c0.f0))return 9;\n  if(written>0&&!bend_U32_encode(encoded_records+0,4,&(*after).as.c0.f1.as.c0.f1.as.c0.f0))return 9;\n  if(written>1&&!bend_U32_encode(encoded_records+4,4,&(*after).as.c0.f1.as.c0.f1.as.c0.f1))return 9;\n  (void)count;\n  bend_collection_commit(&collection,&selected,written,next,encoded_records,collection_header,state->key);\n  if(!bend_collection_plan(&collection,&selected,written,next))return 9;", "semantic"),
    ]
    results = []
    for name, old, new, kind in replacements:
        require(source.count(old) == 1, f"emitted-C mutation anchor changed: {name}")
        changed = source.replace(old, new, 1)
        try:
            model = api.assert_schema(schema, interface)
            model["_interface"] = interface
            check_declarations(api, changed, interface)
            body = api.function_body(changed, "bend_collection_run", set())
            check_run_arguments(api, body, model)
            changed_paths = Paths(api, model)
            changed_paths.prove(body)
            validate_observations(changed_paths.observations, "emitted-C mutation")
        except api.Grammar as error:
            require(kind == "grammar", f"{name}: unexpected grammar rejection: {error}")
            results.append({"name": name, "kind": kind, "reason": str(error)})
        except Exception as error:
            from collection_caller_paths import PathFailure
            if isinstance(error, PathFailure):
                require(kind == "semantic", f"{name}: unexpected semantic rejection")
                results.append({"name": name, "kind": kind, "claim": error.label, "counterexample": error.model})
            elif isinstance(error, CompositionFailure):
                require(kind in ("grammar", "semantic"), f"{name}: unexpected parsed-call rejection: {error}")
                results.append({"name": name, "kind": kind, "reason": str(error)})
            else:
                raise
        else:
            raise CompositionFailure(f"actual emitted-C mutation was accepted: {name}")
    return results


def open_mode_facts(paths: Paths, initialize: int) -> list[z3.BoolRef]:
    i = paths.input
    facts = [
        i("mode", 8) == _b64(0 if initialize else 1),
        i("initialize") == _b64(1 if initialize else 0),
        i("account_count", 64) == _b64(3),
        i("owner_equal", 1) == _b64(1), i("executable", 32) == _b64(0),
        i("writable", 32) == _b64(1), i("state_size", 64) == _b64(25),
        i("collection_owner_equal", 1) == _b64(1),
        i("collection_executable", 1) == _b64(0),
        i("collection_writable", 1) == _b64(1),
        i("collection_signer", 1) == _b64(1 if initialize else 0),
        i("collection_size", 64) == _b64(64),
        i("collection_allocation_zero", 1) == _b64(1 if initialize else 0),
        i("collection_header_matches", 1) == _b64(1 if not initialize else 0),
        i("collection_state_key_matches", 1) == _b64(1 if not initialize else 0),
        i("collection_stored_length") == _b64(2),
        i("open_error", 64) == _b64(0),
        i("state_decode_initial", 1) == _b64(1), i("state_decode_stored", 1) == _b64(1),
        i("instruction_decode", 1) == _b64(1), i("clock_error", 64) == _b64(0),
        i("selection_tag") == _b64(1), i("range_tag") == _b64(0),
        i("selector_start") == _b64(0), i("selection_count") == _b64(2),
        i("select_ok", 1) == _b64(1),
        i("record_decode_0", 1) == _b64(1), i("record_decode_1", 1) == _b64(1),
        i("result_tag") == _b64(0), i("window_tag") == _b64(0),
        i("vector_tag") == _b64(0), i("pair_tag") == _b64(0),
        i("after_start") == _b64(0), i("written") == _b64(2), i("next") == _b64(2),
        i("plan_ok", 1) == _b64(1), i("state_encode", 1) == _b64(1),
        i("record_encode_0", 1) == _b64(1), i("record_encode_1", 1) == _b64(1),
    ]
    for n, byte in enumerate(paths.m["_interface"]["header"]):
        facts.append(i(f"data_{n}", 8) == _b64(byte if not initialize else 0))
    for n in range(20, 25):
        facts.append(i(f"data_{n}", 8) == _b64(0))
    for name in ("load_0", "load_1", "load_2"):
        facts.append(i(name, 1) == _b64(1))
    for slot in range(3):
        for earlier in range(slot):
            facts.append(i(f"alias_{slot}_{earlier}", 1) == _b64(0))
    return facts


def reachability_witnesses(paths: Paths) -> dict[str, Any]:
    i = paths.input
    fields = {name: i(name, bits) for name, bits in {
        "mode": 8, "initialize": 32, "open_error": 64, "collection_size": 64,
        "selector_start": 32, "selection_count": 32, "loaded": 32,
        "written": 32, "next": 32, "plan_ok": 1,
    }.items()}
    modes = []
    for mode in (0, 1):
        facts = open_mode_facts(paths, mode == 0)
        modes.append(sat_witness(f"successful complete caller path in {'initialization' if mode == 0 else 'stored'} mode",
            z3.And(paths.events["return_data"], paths.events["commit"]), fields, [*paths.constraints, *facts]))
    def override_facts(facts, assignments):
        # Replace assignments, rather than conjoining contradictory fixtures.
        # Match actual free-symbol names, never substrings of printed terms.
        from z3.z3util import get_vars
        facts = [fact for fact in facts if not
                 ({str(v) for v in get_vars(fact)} & set(assignments))]
        widths = {"collection_size": 64, "open_error": 64}
        bool_inputs = {"collection_owner_equal", "collection_executable",
            "collection_writable", "collection_signer", "collection_allocation_zero",
            "collection_header_matches", "collection_state_key_matches", "select_ok",
            "plan_ok", "state_encode", "record_decode_0", "record_encode_0"}
        facts.extend(i(name, 1 if name in bool_inputs else widths.get(name, 32)) == _b64(value)
                     for name, value in assignments.items())
        return facts

    loaded = []
    for count in range(3):
        facts = override_facts(open_mode_facts(paths, False),
            {"collection_stored_length": count, "loaded": count})
        loaded.append(sat_witness(f"loaded count {count} is reachable from successful select",
            z3.And(paths.events["select_window"], i("select_ok", 1) == _b64(1)), fields,
            [*paths.constraints, *facts]))
    written = []
    for count, start in ((0, 2), (1, 1), (2, 0)):
        facts = override_facts(open_mode_facts(paths, False),
            {"selector_start": start, "after_start": start,
             "selection_count": count, "written": count, "next": 2})
        written.append(sat_witness(f"written count {count} is reachable from successful plan",
            z3.And(paths.events["plan"], i("plan_ok", 1) == _b64(1)), fields,
            [*paths.constraints, *facts]))
    refusals = []
    cases = [
        ("open owner refusal returns 3", True, 3, {"collection_owner_equal": 0, "open_error": 3}),
        ("open executable refusal returns 3", True, 3, {"collection_owner_equal": 1, "collection_executable": 1, "open_error": 3}),
        ("open writable refusal returns 5", True, 5, {"collection_owner_equal": 1, "collection_writable": 0, "open_error": 5}),
        ("open minimum-size refusal returns 4", True, 4, {"collection_owner_equal": 1, "collection_writable": 1, "collection_size": 55, "open_error": 4}),
        ("open payload-divisibility refusal returns 4", True, 4, {"collection_owner_equal": 1, "collection_writable": 1, "collection_size": 63, "open_error": 4}),
        ("open initialization signer refusal returns 7", True, 7, {"collection_owner_equal": 1, "collection_writable": 1, "collection_size": 64, "collection_signer": 0, "open_error": 7}),
        ("open initialization allocation refusal returns 4", True, 4, {"collection_owner_equal": 1, "collection_writable": 1, "collection_size": 64, "collection_signer": 1, "collection_allocation_zero": 0, "open_error": 4}),
        ("open stored header refusal returns 4", False, 4, {"collection_owner_equal": 1, "collection_writable": 1, "collection_size": 64, "collection_header_matches": 0, "open_error": 4}),
        ("open stored key refusal returns 4", False, 4, {"collection_owner_equal": 1, "collection_writable": 1, "collection_size": 64, "collection_state_key_matches": 0, "open_error": 4}),
        ("open stored length refusal returns 4", False, 4, {"collection_owner_equal": 1, "collection_writable": 1, "collection_size": 64, "collection_stored_length": 3, "open_error": 4}),
    ]
    widths = {"collection_size": 64, "open_error": 64, "collection_stored_length": 32}
    for label, initialize, code, assignments in cases:
        facts = override_facts(open_mode_facts(paths, initialize), assignments)
        refusals.append(sat_witness(label, z3.And(paths.events["open"], i("open_error",64) == _b64(code),
                                    z3.Not(paths.events.get("instruction_decode", z3.BoolVal(False)))),
                                    fields, [*paths.constraints, *facts]))
    refusal_exits = []
    def replace_facts(facts, keys, assignments):
        return override_facts(facts, assignments)
    select_refusal = replace_facts(open_mode_facts(paths, False),
        ["selector_start", "selection_count", "select_ok"],
        {"selector_start": 3, "selection_count": 0, "select_ok": 0})
    refusal_exits.append(sat_witness("select refusal exits before record decode",
        z3.And(paths.events["select_window"], z3.Not(paths.events.get("record_decode_0", z3.BoolVal(False)))),
        fields, [*paths.constraints, *select_refusal]))
    record_refusal = replace_facts(open_mode_facts(paths, False), ["record_decode_0"],
        {"record_decode_0": 0})
    refusal_exits.append(sat_witness("loaded record decoder refusal exits before root",
        z3.And(paths.events["record_decode_0"], z3.Not(paths.events.get("root", z3.BoolVal(False)))),
        fields, [*paths.constraints, *record_refusal]))
    plan_refusal = replace_facts(open_mode_facts(paths, False), ["written", "plan_ok"],
        {"written": 0, "plan_ok": 0})
    refusal_exits.append(sat_witness("plan refusal exits before commit",
        z3.And(paths.events["plan"], z3.Not(paths.events.get("commit", z3.BoolVal(False)))),
        fields, [*paths.constraints, *plan_refusal]))
    state_encode_refusal = replace_facts(open_mode_facts(paths, False), ["state_encode"],
        {"state_encode": 0})
    refusal_exits.append(sat_witness("state encoder refusal exits before commit",
        z3.And(paths.events["state_encode"], z3.Not(paths.events.get("commit", z3.BoolVal(False)))),
        fields, [*paths.constraints, *state_encode_refusal]))
    record_encode_refusal = replace_facts(open_mode_facts(paths, False), ["record_encode_0"],
        {"record_encode_0": 0})
    refusal_exits.append(sat_witness("active record encoder refusal exits before commit",
        z3.And(paths.events["record_encode_0"], z3.Not(paths.events.get("commit", z3.BoolVal(False)))),
        fields, [*paths.constraints, *record_encode_refusal]))
    return {"initializationAndStoredSuccess": modes, "loadedCounts": loaded,
            "writtenCounts": written, "openRefusals": refusals,
            "callerRefusalExits": refusal_exits}


def main() -> int:
    require(len(sys.argv) == 3, "usage: collection_composition.py PAYLOAD OUTPUT")
    payload_path, output = map(pathlib.Path, sys.argv[1:])
    require(not output.exists(), "fresh composition output path required")
    payload = json.loads(payload_path.read_text())
    expected_payload_keys = {
        "version", "runId", "runtimeReceiptPath", "lifecycleReceiptPath", "callerReceiptPath",
        "callerArtifactDirectory", "sourceSnapshotBefore", "sourceSnapshotAfter",
        "runtimeReceiptSha256", "lifecycleReceiptSha256", "callerReceiptSha256",
    }
    require(isinstance(payload, dict) and set(payload) == expected_payload_keys and payload.get("version") == 1,
            "composition payload schema is missing, extra or unsupported")
    run_id = payload.get("runId")
    require(isinstance(run_id, str) and len(run_id) >= 16, "composition run id missing")
    require(os.environ.get("COLLECTION_COMPOSITION_RUN_ID") == run_id,
            "composition process has a mixed run id")
    snapshot_before = payload.get("sourceSnapshotBefore")
    snapshot_after = payload.get("sourceSnapshotAfter")
    require(isinstance(snapshot_before, dict) and snapshot_before == snapshot_after and snapshot_before,
            "composition source snapshots are missing or mixed")
    require(all(pathlib.Path(name).is_file() and sha_file(pathlib.Path(name)) == digest
                for name, digest in snapshot_before.items()),
            "composition source snapshot does not match live source bytes")
    runtime_path = pathlib.Path(payload["runtimeReceiptPath"])
    lifecycle_path = pathlib.Path(payload["lifecycleReceiptPath"])
    caller_path = pathlib.Path(payload["callerReceiptPath"])
    run_directory = runtime_path.parent.resolve()
    require(run_directory.name == run_id and lifecycle_path.parent.resolve() == run_directory and
            caller_path.parent.resolve() == run_directory and payload_path.resolve().parent == run_directory and
            pathlib.Path(sys.argv[2]).resolve().parent == run_directory,
            "receipt or payload path is outside this single fresh run directory")
    runtime_bytes, lifecycle_bytes, caller_bytes = runtime_path.read_bytes(), lifecycle_path.read_bytes(), caller_path.read_bytes()
    expected_receipt_hashes = {
        "runtime": payload.get("runtimeReceiptSha256"),
        "lifecycle": payload.get("lifecycleReceiptSha256"),
        "caller": payload.get("callerReceiptSha256"),
    }
    actual_receipt_hashes = {"runtime": sha_bytes(runtime_bytes), "lifecycle": sha_bytes(lifecycle_bytes),
                             "caller": sha_bytes(caller_bytes)}
    require(expected_receipt_hashes == actual_receipt_hashes,
            "consumed child receipt bytes differ from parent-captured hashes")
    runtime, lifecycle, caller = (json.loads(b) for b in (runtime_bytes, lifecycle_bytes, caller_bytes))
    child_claims = validate_helper_reports(runtime, lifecycle, run_id)
    require(caller.get("compositionRunId") == run_id, "caller receipt has a stale or mixed run id")
    require(caller.get("passed") is True and caller.get("format") == "bend.collection-caller-paths/v3",
            "caller receipt is not a fresh accepted report")
    require(caller.get("contractInterface") == collection_contracts.CONTRACT_DOCUMENT and
            caller.get("contractInterfaceHash") == collection_contracts.CONTRACT_INTERFACE_HASH,
            "caller contract AST changed or differs from helper contracts")
    require(caller.get("assumptions") == CALLER_ASSUMPTIONS, "caller assumptions were narrowed or changed")
    validate_observations(caller.get("callObservations"), run_id)
    artifacts, includes = validate_artifact_bytes(caller, pathlib.Path(payload["callerArtifactDirectory"]))
    source = artifacts["collection-store.c"].read_text()
    schema = json.loads(artifacts["collection-store.schema.json"].read_text())
    interface = json.loads(artifacts["collection-store.interface.json"].read_text())
    model = api.assert_schema(schema, interface)
    model["_interface"] = interface
    check_declarations(api, source, interface)
    body = api.function_body(source, "bend_collection_run", set())
    check_run_arguments(api, body, model)
    paths = Paths(api, model)
    caller_proofs = paths.prove(body)
    caller_preconditions = checked_caller_preconditions(paths, caller_proofs)
    require(paths.observations == caller["callObservations"],
            "fresh parsed observations differ from the caller child result")

    solver_queries, contracts = compose_queries(paths, caller_preconditions)
    query_names = [item["name"] for item in solver_queries]
    require(len(query_names) == len(set(query_names)), "composition query inventory has duplicate labels")
    require(all(item["source"] != "composition" or set(item["sourceClaims"]) <= set(query_names)
                for item in lifecycle["commit"]["contractPreconditionImports"]),
            "caller precondition import is absent from this fresh composition query inventory")
    sensitivities = bridge_sensitivity(paths, solver_queries)
    observation_faults = observation_sensitivity_faults(paths.observations)
    grammar = [
        "open object identity is the parsed &accounts[2] input and &collection output aggregate",
        "select, record, plan and commit use the same parsed &collection and &selected objects",
        "open stride is the parsed literal 4; select maximum is the parsed literal 2",
        "record call sites are nested in the four-byte U32 decoders and use local literals 0 and 1",
        "commit uses the parsed eight-byte encoded_records scratch object, collection_header and state->key",
        "parsed helper call order is open, select, record(0), record(1), plan, commit; ordinals come from the reparsed emitted C",
        "commit, state-header write, state-payload write and return-data syscall order is checked by the caller's path-sensitive source interpreter",
        "object identity and exact C argument spellings are grammar/source facts, not SMT theorem counts",
    ]
    mutations = actual_c_mutations(source, schema, interface)
    reachability = reachability_witnesses(paths)
    require(caller["proofs"]["run"] == caller_proofs,
            "fresh caller run obligations differ from the child receipt")
    caller_claims = []
    for section, claims in caller["proofs"].items():
        occurrences = Counter()
        for claim in claims:
            name = claim["name"]
            occurrences[name] += 1
            caller_claims.append(f"caller:{section}:{name}#{occurrences[name]}")
    require(len(caller_claims) == len(set(caller_claims)), "caller occurrence inventory contains duplicates")
    unique_claims = sorted(set(child_claims) | set(LIFECYCLE_CLAIMS) | set(caller_claims) | set(query_names))
    interface_bytes = json.dumps(collection_contracts.CONTRACT_DOCUMENT, sort_keys=True,
                                  separators=(",", ":")).encode()
    require(sha_bytes(interface_bytes) == collection_contracts.CONTRACT_INTERFACE_HASH,
            "shared contract interface hash is not reproducible")
    report = {
        "format": "bend.collection-helper-caller-composition/v1",
        "passed": True,
        "compositionRunId": run_id,
        "contractInterfaceHash": collection_contracts.CONTRACT_INTERFACE_HASH,
        "contractInterface": collection_contracts.CONTRACT_DOCUMENT,
        "commitPreconditionImports": lifecycle["commit"]["contractPreconditionImports"],
        "callerCompositionPreconditions": caller_preconditions,
        "helperReceiptByteHashes": {
            "runtime": sha_bytes(runtime_bytes), "lifecycle": sha_bytes(lifecycle_bytes),
            "caller": sha_bytes(caller_bytes),
        },
        "artifactHashes": {name: sha_file(path) for name, path in sorted(artifacts.items())},
        "includeHashes": {name: sha_file(path) for name, path in sorted(includes.items())},
        "callerSolverObligationCount": len(caller_proofs),
        "solverObligationCount": len(solver_queries),
        "solverObligations": [{"name": item["name"], "result": item["result"]} for item in solver_queries],
        "grammarRestrictionCount": len(grammar),
        "grammarRestrictions": grammar,
        "emittedCMutationCount": len(mutations),
        "emittedCMutations": mutations,
        "bridgeQuerySensitivityCount": len(sensitivities),
        "bridgeQuerySensitivity": sensitivities,
        "bridgeQuerySensitivityMethodCounts": {
            "sharedContractLinks": sum(x["method"] == "disabled shared-contract link" for x in sensitivities),
            "parsedControlFlowEvents": sum(x["method"] == "disabled parsed-control-flow event" for x in sensitivities),
        },
        "parsedObservationSensitivityCount": len(observation_faults),
        "parsedObservationSensitivity": observation_faults,
        "callerPathObligations": caller_proofs,
        "reachability": reachability,
        "importedHelperClaims": {
            "runtime": sorted({item["label"] for kind in ("select", "plan")
                for field in ("obligations", "range_and_append_obligations")
                for item in runtime["proofs"][kind][field]}),
            "lifecycle": LIFECYCLE_CLAIMS,
            "caller": sorted({x["name"] for section in caller["proofs"].values() for x in section}),
            "compositionPremises": [contracts["importedOpenExtentClaim"]],
        },
        "claimInventory": {"count": len(unique_claims), "unique": unique_claims},
        "assumptions": {
            "runtime": RUNTIME_ASSUMPTIONS,
            "lifecycle": collection_lifecycle.EXPECTED_ASSUMPTIONS,
            "caller": CALLER_ASSUMPTIONS,
            "compositionWorld": [
                "The generated loader provides valid, aligned and truthful account objects and collection data extent; account allocations, data, keys, headers, stack scratch and local buffers are disjoint and stable for this invocation.",
                "The restricted codec and root contracts, context construction and byte-read semantics are pure before commit and obey their specified schema and ABI behavior; their implementation bodies are trusted by assumption.",
                "The supported C pointer/object representation, target integer ABI, syscall behavior, parser, proof drivers, Python and Z3 are trusted. Runtime abort/rollback and C-to-LLVM/SBF preservation are outside the theorem.",
                "The lifecycle span/bitvector cross-domain conclusion remains the accepted prose-level source-width argument, not one combined SMT pointer-range theorem.",
            ],
        },
        "scope": "The exact freshly emitted pure ABI-3 capacity-two U32 caller, composed with the shared open/select/record/plan/commit helper contracts; no C-to-SBF or end-to-end theorem.",
        "notClaimed": ["No general C memory-safety theorem.", "No LLVM/SBF preservation, deployment, runtime abort, or Solana rollback theorem."],
    }
    if os.environ.get("COLLECTION_COMPOSITION_TEST_UNKNOWN") == "1":
        prove("injected composition UNKNOWN probe", z3.BoolVal(False), [z3.BoolVal(True)])
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"passed": True, "solverObligations": len(solver_queries),
        "grammarRestrictions": len(grammar), "emittedCMutations": len(mutations),
        "receiptHashes": report["helperReceiptByteHashes"], "contractInterfaceHash": report["contractInterfaceHash"]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CompositionFailure, api.Fatal, api.Grammar, z3.Z3Exception, OSError, ValueError, KeyError) as error:
        print(f"collection composition rejected: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
