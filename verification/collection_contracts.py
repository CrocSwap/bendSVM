"""Versioned, shared ABI-3 collection helper contracts.

The JSON AST below is the contract interface.  Helper body checkers and the
generated-caller composition instantiate these exact expressions through
``term``; claim names and hashes alone are never treated as proof results.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

import z3


def v(name: str) -> dict[str, Any]:
    return {"var": name}


def c(value: int, width: int) -> dict[str, Any]:
    return {"bv": value, "width": width}


def op(name: str, *args: Any, **extra: Any) -> dict[str, Any]:
    return {"op": name, "args": list(args), **extra}


def _select_contract() -> dict[str, Any]:
    guards = [
        {"name": "length_exceeds_capacity", "formula": op("ule", v("length"), v("capacity"))},
        {"name": "start_exceeds_length", "formula": op("ule", v("start"), v("length"))},
        {"name": "count_exceeds_maximum", "formula": op("ule", v("count"), v("maximum"))},
        {"name": "start_exceeds_capacity", "formula": op("ule", v("start"), v("capacity"))},
        {"name": "count_exceeds_remaining_capacity", "formula": op("ule",
            op("bvadd", op("zext", v("start"), width=33), op("zext", v("count"), width=33)),
            op("zext", v("capacity"), width=33))},
    ]
    success = op("and", *(item["formula"] for item in guards))
    loaded = op("ite", op("ult", op("bvsub", v("length"), v("start")), v("count")),
        op("bvsub", v("length"), v("start")), v("count"))
    return {
        "arguments": ["collection:BendCollection*", "start:u32", "count:u32", "maximum:u32", "out:BendCollectionWindow*"],
        "worldPreconditions": ["valid nonnull objects", "collection and output are disjoint", "output writable"],
        "orderedGuards": guards,
        "success": success,
        "status": op("ite", success, c(1, 32), c(0, 32)),
        "outputs": {
            "start": op("ite", success, v("start"), v("old_start")),
            "reserved": op("ite", success, v("count"), v("old_reserved")),
            "loaded": op("ite", success, loaded, v("old_loaded")),
        },
        "frame": ["collection fields unchanged", "window unchanged on refusal"],
    }


def _plan_contract() -> dict[str, Any]:
    selected = op("and",
        op("ule", v("length"), v("capacity")),
        op("ule", v("start"), v("length")),
        op("ule", v("start"), v("capacity")),
        op("ule", op("bvadd", op("zext", v("start"), width=33),
                      op("zext", v("reserved"), width=33)),
            op("zext", v("capacity"), width=33)))
    selected_loaded = op("ite", op("ule", op("bvsub", v("length"), v("start")), v("reserved")),
                         op("bvsub", v("length"), v("start")), v("reserved"))
    added = op("bvsub", v("written"), v("loaded"))
    guards = [
        {"name": "nested_select_refuses", "formula": selected},
        {"name": "selected_loaded_mismatch", "formula": op("eq", selected_loaded, v("loaded"))},
        {"name": "written_below_loaded", "formula": op("ule", v("loaded"), v("written"))},
        {"name": "written_above_reserved", "formula": op("ule", v("written"), v("reserved"))},
        {"name": "next_length_below_old", "formula": op("ule", v("length"), v("next_length"))},
        {"name": "next_length_above_capacity", "formula": op("ule", v("next_length"), v("capacity"))},
        {"name": "append_window_not_at_tail", "formula": op("or", op("eq", added, c(0, 32)),
            op("eq", op("bvsub", v("length"), v("start")), v("loaded")))},
        {"name": "append_count_differs_from_length_delta", "formula": op("eq", added, op("bvsub", v("next_length"), v("length")))},
    ]
    success = op("and", *(item["formula"] for item in guards))
    return {
        "arguments": ["collection:const BendCollection*", "window:const BendCollectionWindow*", "written:u32", "next_length:u32"],
        "worldPreconditions": ["valid nonnull objects", "collection and window are disjoint and stable"],
        "orderedGuards": guards,
        "success": success,
        "status": op("ite", success, c(1, 32), c(0, 32)),
        "outputs": {},
        "postconditions": [
            "loaded<=written<=reserved", "old length<=next length<=capacity",
            "written-loaded=next length-old length",
            "append begins at old tail when written>loaded",
        ],
        "frame": ["collection and window unchanged"],
    }


def _open_contract() -> dict[str, Any]:
    malformed = op("or", op("not", v("positive_stride")), op("not", v("minimum_header_size")),
        op("and", v("positive_stride"), v("minimum_header_size"),
            op("or", op("not", v("divisible_payload")), op("not", v("capacity_fits_u32")))))
    stored_valid = op("and", v("stored_header_matches"), v("stored_key_matches"), v("stored_length_valid"))
    init_error = op("ite", op("not", v("signer")), c(7, 64),
                    op("ite", v("allocation_zero"), c(0, 64), c(4, 64)))
    stored_error = op("ite", stored_valid, c(0, 64), c(4, 64))
    status = op("ite", op("not", v("base_valid")), c(3, 64),
        op("ite", op("not", v("writable")), c(5, 64),
            op("ite", malformed, c(4, 64),
                op("ite", v("initialize"), init_error, stored_error))))
    return {
        "arguments": ["account:Account*", "program:const u8*", "state_key:const u8*", "header:const u8[20]", "stride:u32", "initialize:unsigned", "out:BendCollection*"],
        "worldPreconditions": ["valid aligned objects and readable spans", "input spans and output are disjoint", "account data extent covers reported size"],
        "status": status,
        "outputs": {
            "account_identity": "grammar: output aggregate stores the exact account argument",
            "length": op("ite", v("initialize"), c(0, 32), v("stored_length")),
            "capacity": v("capacity_from_size_and_stride"),
            "stride": v("stride"),
        },
        "successFacts": [
            "positive stride", "size>=56", "(size-56)%stride==0", "capacity quotient fits u32",
            "initialization requires signer and zero allocation",
            "stored mode requires matching 20-byte header and 32-byte state key and length<=capacity",
        ],
        "frame": ["all four output fields unchanged on refusal", "Account structure unchanged"],
    }


def _record_contract() -> dict[str, Any]:
    active = op("ult", v("local"), v("loaded"))
    logical = op("bvadd", v("start"), v("local"))
    offset = op("bvadd", c(56, 64), op("bvmul", op("zext", logical, width=64), op("zext", v("stride"), width=64)))
    return {
        "arguments": ["collection:const BendCollection*", "window:const BendCollectionWindow*", "local:u32"],
        "worldPreconditions": ["valid stable objects", "successful open", "successful select on the same objects", "allocation and account data are valid"],
        "active": active,
        "result_nonnull": active,
        "result_offset": offset,
        "activeSpan": op("and", op("uge", offset, c(56, 64)),
                          op("ule", op("bvadd", offset, op("zext", v("stride"), width=64)), v("data_size"))),
        "frame": ["collection data and metadata unchanged"],
    }


def _commit_contract() -> dict[str, Any]:
    # This typed byte relation is checked against the parsed helper memory
    # model, then instantiated at the caller's exact commit call.
    j = v("byte_index")
    record_start = op("bvadd", c(56, 64), op("bvmul", op("zext", v("start"), width=64), op("zext", v("stride"), width=64)))
    record_count = op("bvmul", op("zext", v("written"), width=64), op("zext", v("stride"), width=64))
    end = op("bvadd", record_start, record_count)
    header_region = op("ult", j, c(20, 64))
    length_region = op("and", op("uge", j, c(20, 64)), op("ult", j, c(24, 64)))
    key_region = op("and", op("uge", j, c(24, 64)), op("ult", j, c(56, 64)))
    record_region = op("and", op("uge", j, record_start), op("ult", j, end))
    next_len = v("next_length")
    len_byte = op("ite", op("eq", j, c(20, 64)), op("extract", next_len, high=7, low=0),
        op("ite", op("eq", j, c(21, 64)), op("extract", next_len, high=15, low=8),
            op("ite", op("eq", j, c(22, 64)), op("extract", next_len, high=23, low=16),
                op("extract", next_len, high=31, low=24))))
    expected = op("ite", header_region, op("select", v("header"), j),
        op("ite", length_region, len_byte,
            op("ite", key_region, op("select", v("state_key"), op("bvsub", j, c(24, 64))),
                op("ite", record_region, op("select", v("encoded"), op("bvsub", j, record_start)),
                    op("select", v("old_data"), j)))))
    selected_loaded = op("ite", op("ule", op("bvsub", v("length"), v("start")), v("reserved")),
                         op("bvsub", v("length"), v("start")), v("reserved"))
    added = op("bvsub", v("written"), v("loaded"))
    precondition = op("and",
        op("ugt", v("stride"), c(0, 32)),
        op("eq", v("data_size"), op("bvadd", c(56, 64),
            op("bvmul", op("zext", v("capacity"), width=64), op("zext", v("stride"), width=64)))),
        op("ule", v("length"), v("capacity")),
        op("ule", v("start"), v("length")),
        op("ule", op("bvadd", op("zext", v("start"), width=33), op("zext", v("reserved"), width=33)),
            op("zext", v("capacity"), width=33)),
        op("eq", selected_loaded, v("loaded")),
        op("ule", v("loaded"), v("written")), op("ule", v("written"), v("reserved")),
        op("ule", v("length"), v("next_length")), op("ule", v("next_length"), v("capacity")),
        op("or", op("eq", added, c(0, 32)), op("eq", op("bvsub", v("length"), v("start")), v("loaded"))),
        op("eq", added, op("bvsub", v("next_length"), v("length"))),
        op("ule", record_count, v("scratch_extent")))
    return {
        "arguments": ["collection:BendCollection*", "window:const BendCollectionWindow*", "written:u32", "next_length:u32", "encoded:const u8*", "header:const u8[20]", "state_key:const u8[32]"],
        "worldPreconditions": ["valid stable objects", "successful open, select and plan on the same objects", "all source and destination spans readable/writable and disjoint", "encoded extent>=written*stride", "header and state key do not alias destinations"],
        "precondition": precondition,
        # Each clause is discharged at the composition boundary from the
        # corresponding live helper-body claim, except the fixed caller
        # scratch extent which is proved by the generated-caller query.  Keep
        # this table beside the formula AST so an importer cannot silently
        # drift to a hand-copied precondition.
        "preconditionImports": [
            {"source": "open", "claims": ["open exact ordered error/success contract"]},
            {"source": "open", "claims": ["open unsigned division/remainder yields exact capacity payload relation"]},
            {"source": "open", "claims": ["open exact ordered error/success contract", "success writes exact collection fields"]},
            {"source": "select", "claims": ["select: exact return and output contract", "select: start is within old logical length"]},
            {"source": "select", "claims": ["select: reserved end is within capacity"]},
            {"source": "select", "claims": ["select: exact start/reserved/loaded outputs on success"]},
            {"source": "plan", "claims": ["plan: loaded prefix is retained by count"]},
            {"source": "plan", "claims": ["plan: written record count fits selected reservation"]},
            {"source": "plan", "claims": ["plan: exact return and output contract"]},
            {"source": "plan", "claims": ["plan: next logical length is bounded"]},
            {"source": "plan", "claims": ["plan: appends extend exactly from old tail"]},
            {"source": "plan", "claims": ["plan: additions equal logical length growth"]},
            {"source": "composition", "claims": ["eight-byte record scratch covers written times four-byte stride"]},
        ],
        "recordStart": record_start,
        "recordCount": record_count,
        "byteFrame": {"index": j, "extent": v("data_size"), "actual": v("post_data_byte"), "expected": expected},
        "lengthPost": op("eq", v("new_length"), v("next_length")),
        "frame": ["header bytes [0,20) copied", "length bytes [20,24) encode next_length little-endian", "state key bytes [24,56) copied", "record bytes copied at recordStart for recordCount", "all other data bytes unchanged", "collection length becomes next_length", "capacity, stride, account and window unchanged"],
    }


CONTRACT_DOCUMENT: dict[str, Any] = {
    "format": "bend.collection-helper-contracts/v1",
    "integerModel": {"u32": "bitvector32", "u64": "bitvector64", "comparison": "unsigned", "memory": "byte-array-indexed-by-u64"},
    "contracts": {
        "open": _open_contract(),
        "select": _select_contract(),
        "plan": _plan_contract(),
        "record": _record_contract(),
        "commit": _commit_contract(),
    },
}
CONTRACT_INTERFACE_HASH = hashlib.sha256(
    json.dumps(CONTRACT_DOCUMENT, sort_keys=True, separators=(",", ":")).encode()
).hexdigest()


def term(ast: Any, env: dict[str, Any]) -> Any:
    """Interpret one typed contract AST node in Z3 terms."""
    if not isinstance(ast, dict):
        raise ValueError("contract AST node must be an object")
    if "var" in ast:
        return env[ast["var"]]
    if "bv" in ast:
        return z3.BitVecVal(ast["bv"], ast["width"])
    name = ast.get("op")
    args = [term(item, env) for item in ast.get("args", [])]
    if name == "and": return z3.And(*args)
    if name == "or": return z3.Or(*args)
    if name == "not": return z3.Not(args[0])
    if name == "eq": return args[0] == args[1]
    if name == "ult": return z3.ULT(args[0], args[1])
    if name == "ule": return z3.ULE(args[0], args[1])
    if name == "ugt": return z3.UGT(args[0], args[1])
    if name == "uge": return z3.UGE(args[0], args[1])
    if name == "bvadd": return args[0] + args[1]
    if name == "bvsub": return args[0] - args[1]
    if name == "bvmul": return args[0] * args[1]
    if name == "ite": return z3.If(args[0], args[1], args[2])
    if name == "zext": return z3.ZeroExt(ast["width"] - args[0].size(), args[0])
    if name == "extract": return z3.Extract(ast["high"], ast["low"], args[0])
    if name == "select": return z3.Select(args[0], args[1])
    raise ValueError(f"unsupported contract AST operation {name!r}")


def instantiate(name: str, env: dict[str, Any]) -> dict[str, Any]:
    """Instantiate the checked-in AST without maintaining a second formula."""
    contract = CONTRACT_DOCUMENT["contracts"][name]
    result: dict[str, Any] = {}
    for field in ("success", "status", "active", "result_nonnull", "result_offset",
                  "activeSpan", "precondition", "lengthPost", "recordStart", "recordCount"):
        if field in contract and (field != "lengthPost" or "new_length" in env):
            result[field] = term(contract[field], env)
    if "outputs" in contract:
        result["outputs"] = {key: term(value, env) for key, value in contract["outputs"].items()
                             if isinstance(value, dict)}
    if "orderedGuards" in contract:
        result["orderedGuards"] = [term(item["formula"], env) for item in contract["orderedGuards"]]
    if "byteFrame" in contract:
        frame = contract["byteFrame"]
        result["byteFrame"] = {
            "index": term(frame["index"], env),
            "extent": term(frame["extent"], env),
            "actual": term(frame["actual"], env),
            "expected": term(frame["expected"], env),
        }
    return result
