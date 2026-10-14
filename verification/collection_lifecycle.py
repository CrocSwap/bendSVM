"""Fail-closed symbolic assurance for the ABI-3 collection lifecycle slice.

The checker parses the live collection header with a deliberately small C
grammar, interprets the actual open/record/commit bodies, and rejects every
statement or expression outside that grammar.  The three byte helpers in
solana_min.h are accepted only in their reviewed straight-line/counting-loop
forms; their byte semantics are stated in the report as helper lemmas, not as
claims about Clang, SBF, or Solana.

The theorem boundary is intentionally compositional: open is checked here;
record and commit are checked under explicit successful-select and
successful-plan facts.  The generated caller, select/plan proof, codecs,
effects, abort behavior and transaction rollback are not composed here.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import z3
import collection_runtime as c_runtime
import collection_contracts as collection_contracts


ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNTIME = ROOT / "runtime/bend_collection_runtime.h"
MIN_RUNTIME = ROOT / "runtime/solana_min.h"
CHECKER = pathlib.Path(__file__).resolve()
PARENT_CHECKER = ROOT / "verification/check-collection-lifecycle.ts"
CTYPE_HELPER = ROOT / "verification/collection_runtime.py"
CTYPE_HELPER_DEP = ROOT / "verification/adapter_contract_c.py"
RECEIPT = (pathlib.Path(os.environ["COLLECTION_LIFECYCLE_RECEIPT_PATH"]).resolve().with_suffix(".json.pending")
           if os.environ.get("COLLECTION_LIFECYCLE_RECEIPT_PATH")
           else ROOT / "build/collection-lifecycle-refinement.json.pending")

EXPECTED_GRAMMAR_RESTRICTIONS = {
    "open": [
        "only the BendCollection output receives a whole-structure store; Account member stores reject",
        "indexed stores, including account-data and const-derived stores, reject",
        "loop summaries quantify the full sequential index range only for zero-based unsigned unit increments with induction < an invariant bound, no induction or other state writes, and one constant early-return value",
        "scalar const writes reject and const-derived pointer stores reject",
        "output account-pointer identity follows the admitted aggregate assignment shape rather than a solver claim",
    ],
    "record": [
        "record reads are limited to modeled scalar and byte-array expressions",
        "the returned pointer uses one scalar-combined or two sequential pointer formations from account data; with two, the first formation is directly checked in C bitvectors, while the final address is tied to the exact-address, C-width no-wrap, input-correspondence and active-record span claims",
        "loop summaries require zero-based unsigned unit increments guarded by induction < invariant-bound; the exact monotonic guard enumerates the visited range",
    ],
    "commit": [
        "copy loops require zero-based unit-increment induction < invariant-bound guards",
        "indexed writes target only collection data; source and destination indices are base + induction",
        "write_le accepts only the reviewed collection-data destination and four-byte use",
        "commit pointer, count, induction and byte memory semantics use C bitvectors; external integer input labels are separately proved equal to the corresponding unsigned bitvector inputs",
        "pointer variables are direct aliases or use one constant in-object base offset proved against the actual bitvector extent; variable-index addresses map pointwise to their parsed C subscript and exact loop span, and write_le maps to its fixed four-byte target span",
        "each admitted counted copy proves that its parsed C subscript equals the widened base-plus-induction address on every executed iteration",
        "each admitted counted copy is bounded and nonwrapping at both objects using the actual u64 pointer, count and extent values",
        "non-summary scalar/helper byte reads are separately SMT-checked; counted-copy and fixed-write accesses use their summarized span theorems",
        "const scalar and const-derived pointer writes reject before symbolic analysis",
        "local declarations and assignments use parsed declared C types and conversions",
    ],
}

EXPECTED_ASSUMPTIONS = {
    "C semantics": "Every evaluated scalar, promotion, conversion, division, remainder, shift and pointer offset uses fixed-width C bitvectors and the hash-bound conversion rules; signed division and remainder use C truncation toward zero, and unsigned unary negation wraps at its promoted width. Record/commit integer input correspondence is instantiated from one cached UNSAT Int2BV inverse query per supported width (32 and 64), with 18 applications of those two results; these are not 18 independent solver queries. In admitted code, the u32-by-u32 offset/count products are widened to u64 and fit because (2^32-1)^2 < 2^64; the active record u32 start+local sum has its own UNSAT no-wrap claim. Commit proves the parsed C subscript equals the widened base-plus-induction address for every guarded iteration. Mathematical span/no-wrap and exact bitvector address results are separate obligations; their composition to conclude the actual source pointer is in range relies on the stated source-width/range reasoning, not one combined Z3 query. Signed overflow, invalid division and invalid shifts fail path-sensitive obligations. Signed right shift and pointer/object representation remain pinned-target assumptions.",
    "commit caller facts": "Each commit input label for account, collection, window, written, next length and scratch extent has its own proved C-bitvector correspondence claim. Successful plan establishes loaded<=written<=reserved, oldLength<=nextLength<=capacity, written-loaded=nextLength-oldLength, and, when appending, oldLength-start=loaded; encoded extent>=written*stride. Parsed C copy addresses/counts are checked as bitvectors, including the actual per-iteration base+induction subscript. Integer span obligations use the individually mapped inputs and source-typed u32-by-u32 products widened to u64; the explicit operand-width bound makes those products exact, and the caller ranges establish object bounds/no-wrap. Source spans are disjoint from collection data and each other, and pointers/metadata stay stable.",
    "grammar restrictions": "Each section reports source-shape restrictions separately from solver claims. Integer literals admit zero, non-leading-zero decimal, and hexadecimal forms with only the modeled suffixes; nonzero leading-zero nonhex forms reject instead of being interpreted as decimal. Loop summaries require zero initialization, unsigned unit increments, an invariant bound with the exact induction < bound guard, and no writes to induction or other state. The exact monotonic guard enumerates every visited index; open early-return summaries permit only one constant return value so existential loop coverage preserves sequential first-match behavior. Nested loops, input/account-data indexed stores, const writes and const-derived destinations reject. Aggregate identity is a source-shape fact, not a Python-boolean theorem claim.",
    "helper lemmas": "equal_key compares all 32 bytes, read_le decodes the four caller-selected bytes little-endian, and write_le writes four low bytes little-endian; their live solana_min.h bodies must match the audited restricted token forms and are hash-bound in this receipt. C type conversion, usual arithmetic conversion, integer promotions and signed add/sub safety import only the named rules from the hash-bound collection_runtime helper and its adapter parser dependency.",
    "mutant evidence": "Each semantic/undefined-behavior mutant records its rejecting claim and the Z3 SAT model assignments; unsupported Account/data/loop-control writes record grammar rejection and are not reported as semantic counterexamples. UNKNOWN, timeout, spawn and parser failures cannot satisfy expected mutant outcomes.",
    "not established": "select/plan implementations, generated caller, canonical element codecs, effect validation/execution, account-loader truthfulness, LLVM/Clang/SBF preservation, runtime abort behavior, Solana transaction rollback, and other-account rollback.",
    "open input nonmutation": "Account member and indexed memory stores are excluded by grammar. The account-structure field frame claims cover only modeled structure fields. No theorem claims that account-data bytes remain unchanged; byte-store exclusion is reported as grammar.",
    "open objects": "a, out and all input spans are valid; account data backing extent is at least a->size; owner/program/state-key spans are 32 bytes; header is 20 bytes; out is a complete aligned BendCollection object and is disjoint from input/account data.",
    "record caller facts": "Each record input label has its own proved C-bitvector correspondence claim. Successful open gives size=56+capacity*stride with positive stride and length<=capacity. Successful select establishes start<=length, start<=capacity, reserved<=capacity-start and loaded=min(length-start,reserved); record sees the same collection/window, no mutation, and local<loaded. The active C u32 index addition is checked for wrap in bitvector form; the parsed return pointer is compared against its exact C-width address formula, whose mapped u32 factors are widened to u64 before multiplication.",
    "span/BV composition": "Mathematical span/no-wrap queries and bitvector address-exactness queries are checked separately. Their composition to conclude that the parsed source pointer is in range uses the documented source-typed width and caller-range reasoning; that cross-domain composition is a prose-level argument, not a single Z3 query.",
}


class Grammar(Exception):
    """Unsupported C syntax or source shape; never interpreted as a proof."""


def need(ok: bool, message: str) -> None:
    if not ok:
        raise Grammar(message)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def source_hashes() -> dict[str, str]:
    paths = (RUNTIME, MIN_RUNTIME, CHECKER, PARENT_CHECKER, CTYPE_HELPER, CTYPE_HELPER_DEP,
             ROOT / "verification/collection_contracts.py")
    return {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in paths}


def bv(value: int, width: int) -> z3.BitVecRef:
    return z3.BitVecVal(value, width)


def bool_of(value: "CValue") -> z3.BoolRef:
    need(isinstance(value, CInt), "condition: expected an integer scalar")
    return value.term != bv(0, value.width)


@dataclass(frozen=True)
class CInt:
    term: z3.BitVecRef
    width: int
    signed: bool = False
    ctype: str | None = None

    @property
    def c_type(self) -> str:
        if self.ctype is not None:
            return self.ctype
        if self.width == 8:
            return "u8"
        if self.width == 32:
            return "int" if self.signed else "u32"
        if self.width == 64:
            return "u64"
        raise Grammar(f"C integer: unsupported modeled width {self.width}")


@dataclass(frozen=True)
class BytePtr:
    obj: str
    offset: z3.BitVecRef
    null: bool = False


@dataclass
class StructPtr:
    name: str
    fields: dict[str, Any]
    identity: str


@dataclass
class StructValue:
    name: str
    fields: dict[str, Any]


CValue = CInt | BytePtr | StructPtr | StructValue


LEX = re.compile(
    r"[ \t\n]+|/\*[\s\S]*?\*/|//[^\n]*|\"[^\"\n]*\"|"
    r"0[xX][0-9a-fA-F]+[uUlL]*(?![\w.])|[0-9]+[uUlL]*(?![\w.])|"
    r"[A-Za-z_]\w*|->|\+\+|--|\+=|-=|\|=|&&|\|\||<<|>>|<=|>=|==|!=|"
    r"[{}()\[\];:,.&*+|=<>!?#/%^~\-]"
)
IDENT = re.compile(r"[A-Za-z_]\w*\Z")
NUMBER = re.compile(r"(?:0[xX][0-9a-fA-F]+|[0-9]+)[uUlL]*\Z")


def lex(text: str) -> list[str]:
    need(text.isascii() and "\\" not in text and "??" not in text and "\r" not in text,
         "preprocessing: unsupported character, splice or trigraph")
    out, at = [], 0
    while at < len(text):
        match = LEX.match(text, at)
        need(match is not None, f"lexer: unsupported token near {text[at:at + 32]!r}")
        token = match.group()
        at = match.end()
        if token[0] in " \t\n" or token.startswith(("/*", "//")):
            continue
        need(token != "#", "preprocessing: unexpected directive token")
        out.append(token)
    return out


def code_tokens(text: str) -> list[str]:
    """Tokenize C after accepting only the three reviewed directives."""
    code = []
    for line in text.splitlines():
        if line.lstrip().startswith("#"):
            continue
        code.append(line)
    return lex("\n".join(code))


def literal(token: str) -> CInt:
    body = token.rstrip("uUlL")
    original_suffix = token[len(body):]
    need("lL" not in original_suffix and "Ll" not in original_suffix,
         f"literal: invalid integer suffix {token}")
    suffix = original_suffix.lower()
    need(suffix in ("", "u", "ull"), f"literal: unsupported suffix {token}")
    hexadecimal = body.lower().startswith("0x")
    if hexadecimal:
        value = int(body, 16)
    else:
        # C17 interprets a nonzero leading-zero integer constant as octal.
        # This checker intentionally admits only decimal spelling without a
        # leading zero, plus the single zero spelling. Reject octal rather than
        # silently assigning it the decimal value used by Python's int().
        need(body == "0" or body[0] != "0",
             f"literal: unsupported leading-zero nonhex integer literal {token}")
        value = int(body, 10)
    if suffix == "ull":
        need(value < 1 << 64, "literal: exceeds u64")
        return CInt(bv(value, 64), 64, False, "u64")
    if suffix == "u":
        need(value < 1 << 32, "literal: exceeds u32")
        return CInt(bv(value, 32), 32, False, "u32")
    if value >= 1 << 31:
        need(body.lower().startswith("0x") and value < 1 << 32,
             "literal: unsuffixed decimal long literals are outside the pinned C subset")
        return CInt(bv(value, 32), 32, False, "u32")
    return CInt(bv(value, 32), 32, True, "int")


class CParser:
    """Parser for the source forms needed by open, record and commit."""
    TYPES = {"int", "u8", "u32", "u64", "unsigned", "Account", "BendCollection",
             "BendCollectionWindow"}
    PRECEDENCE = [
        ("||",), ("&&",), ("|",), ("^",), ("&",),
        ("==", "!="), ("<", ">", "<=", ">="), ("<<", ">>"),
        ("+", "-"), ("*", "/", "%"),
    ]

    def __init__(self, tokens: list[str]):
        self.t, self.at = tokens, 0

    def peek(self, n: int = 0) -> str:
        return self.t[self.at + n] if self.at + n < len(self.t) else ""

    def take(self, *values: str) -> str:
        got = ""
        for value in values:
            got = self.peek()
            need(got == value, f"syntax: expected {value!r}, found {got!r} at token {self.at}")
            self.at += 1
        return got

    def one_of(self, *values: str) -> str:
        got = self.peek()
        need(got in values, f"syntax: expected one of {values}, found {got!r} at token {self.at}")
        self.at += 1
        return got

    def ident(self) -> str:
        token = self.peek()
        need(IDENT.fullmatch(token) is not None, f"syntax: expected identifier, found {token!r}")
        self.at += 1
        return token

    def expr(self, level: int = 0) -> Any:
        if level == len(self.PRECEDENCE):
            return self.unary()
        left = self.expr(level + 1)
        while self.peek() in self.PRECEDENCE[level]:
            op = self.peek()
            self.at += 1
            right = self.expr(level + 1)
            left = ("bin", op, left, right)
        if level == 0 and self.peek() == "?":
            self.take("?")
            yes = self.expr()
            self.take(":")
            left = ("cond", left, yes, self.expr())
        return left

    def unary(self) -> Any:
        if self.peek() in ("!", "~", "*", "&", "-", "+"):
            op = self.peek()
            self.at += 1
            return ("un", op, self.unary())
        # Scalar and pointer casts; BendCollection compound literal.
        if self.peek() == "(" and (self.peek(1) == "const" or self.peek(1) in self.TYPES):
            saved = self.at
            self.take("(")
            const = self.peek() == "const"
            if const:
                self.take("const")
            typ = self.ident()
            ptr = self.peek() == "*"
            if ptr:
                self.take("*")
            self.take(")")
            if typ == "BendCollection" and not ptr and self.peek() == "{":
                self.take("{")
                values = [self.expr()]
                while self.peek() == ",":
                    self.take(",")
                    values.append(self.expr())
                self.take("}")
                return ("compound", typ, values)
            return ("cast", typ, ptr, self.unary())
        return self.postfix()

    def postfix(self) -> Any:
        if self.peek() == "(":
            self.take("(")
            node = self.expr()
            self.take(")")
        elif NUMBER.fullmatch(self.peek()):
            node = ("literal", literal(self.peek()))
            self.at += 1
        else:
            node = ("id", self.ident())
        while True:
            if self.peek() == "[":
                self.take("[")
                index = self.expr()
                self.take("]")
                node = ("index", node, index)
            elif self.peek() in (".", "->"):
                op = self.peek()
                self.at += 1
                node = ("member", op, node, self.ident())
            elif self.peek() == "(":
                need(node[0] == "id", "syntax: indirect call")
                self.take("(")
                args = []
                if self.peek() != ")":
                    args.append(self.expr())
                    while self.peek() == ",":
                        self.take(",")
                        args.append(self.expr())
                self.take(")")
                node = ("call", node[1], args)
            else:
                return node

    def statement(self) -> Any:
        token = self.peek()
        if token == "{":
            self.take("{")
            items = []
            while self.peek() != "}":
                need(self.peek() != "", "syntax: unterminated block")
                items.append(self.statement())
            self.take("}")
            return ("block", items)
        if token == "if":
            self.take("if", "(")
            cond = self.expr()
            self.take(")")
            yes = self.statement()
            no = None
            if self.peek() == "else":
                self.take("else")
                no = self.statement()
            return ("if", cond, yes, no)
        if token == "for":
            self.take("for", "(")
            const = self.peek() == "const"
            if const:
                self.take("const")
            typ = self.peek()
            need(typ in ("unsigned", "u32", "u64"), "for: unsupported induction type")
            self.at += 1
            var = self.ident()
            self.take("=")
            init = self.expr()
            self.take(";")
            cond = self.expr()
            self.take(";")
            if self.peek() in ("++", "--"):
                op = self.peek()
                self.at += 1
                step = (op, self.ident())
            else:
                step_var = self.ident()
                op = self.one_of("+=", "-=")
                amount = self.expr()
                step = (op, step_var, amount)
            self.take(")")
            body = self.statement()
            return ("for", typ, var, init, cond, step, body)
        if token == "return":
            self.take("return")
            value = self.expr()
            self.take(";")
            return ("return", value)
        if token == "const" or token in self.TYPES:
            const = self.peek() == "const"
            if const:
                self.take("const")
            typ = self.peek()
            need(typ in self.TYPES, f"declaration: unsupported type {typ!r}")
            self.at += 1
            pointer = self.peek() == "*"
            if pointer:
                self.take("*")
            items = []
            while True:
                item_pointer = pointer
                if items and self.peek() == "*":
                    self.take("*")
                    item_pointer = True
                name = self.ident()
                init = None
                if self.peek() == "=":
                    self.take("=")
                    init = self.expr()
                items.append(("decl", typ, const, item_pointer, name, init))
                if self.peek() != ",":
                    break
                self.take(",")
            self.take(";")
            return items[0] if len(items) == 1 else ("decls", items)
        lhs = self.expr()
        if self.peek() in ("=", "|=", "+=", "-="):
            op = self.peek()
            self.at += 1
            rhs = self.expr()
            self.take(";")
            return ("assign", lhs, op, rhs)
        self.take(";")
        return ("expr", lhs)


def signature_tokens(signature: str) -> list[str]:
    return lex(signature)


def function_ast(source: str, signature: str) -> Any:
    tokens = code_tokens(source)
    sig = signature_tokens(signature)
    starts = [i for i in range(len(tokens) - len(sig) + 1) if tokens[i:i + len(sig)] == sig]
    need(len(starts) == 1, f"binding: expected one live definition for {signature.split('(')[0]}")
    at = starts[0] + len(sig)
    need(tokens[at] == "{", "binding: function signature not followed by body")
    depth, end = 0, None
    for i in range(at, len(tokens)):
        depth += tokens[i] == "{"
        depth -= tokens[i] == "}"
        if depth == 0:
            end = i
            break
    need(end is not None, "binding: unterminated function")
    parser = CParser(tokens[at:end + 1])
    body = parser.statement()
    need(parser.at == len(parser.t), "parser: unconsumed function-body token")
    return body


def definition_tokens(source: str, signature: str) -> list[str]:
    tokens = code_tokens(source)
    sig = signature_tokens(signature)
    starts = [i for i in range(len(tokens) - len(sig) + 1) if tokens[i:i + len(sig)] == sig]
    need(len(starts) == 1, f"binding: expected unique helper {signature.split('(')[0]}")
    at = starts[0] + len(sig)
    need(tokens[at] == "{", "binding: helper has no body")
    depth = 0
    for end in range(at, len(tokens)):
        depth += tokens[end] == "{"
        depth -= tokens[end] == "}"
        if depth == 0:
            return tokens[starts[0]:end + 1]
    raise Grammar("binding: unterminated helper definition")


def require_fragment(source: str, fragment: str, label: str) -> None:
    tokens, expected = code_tokens(source), lex(fragment)
    matches = sum(tokens[i:i + len(expected)] == expected for i in range(len(tokens) - len(expected) + 1))
    need(matches == 1, f"dependencies: expected one exact live {label} declaration")


def check_source_headers(runtime: str, min_runtime: str) -> None:
    directives = [line.strip() for line in runtime.splitlines() if line.lstrip().startswith("#")]
    need(directives == ["#pragma once", '#include "solana_min.h"', "#define BEND_COLLECTION_HEADER 56u"],
         "preprocessing: unexpected collection header directives")
    need(not any(line.lstrip().startswith("#") for line in min_runtime.splitlines()
                 if line.strip() not in ("#pragma once",)),
         "preprocessing: unsupported solana_min.h directive")
    require_fragment(min_runtime, "typedef unsigned char u8;", "u8 typedef")
    require_fragment(min_runtime, "typedef unsigned int u32;", "u32 typedef")
    require_fragment(min_runtime, "typedef unsigned long long u64;", "u64 typedef")
    require_fragment(min_runtime,
        '_Static_assert(sizeof(u8) == 1 && sizeof(u32) == 4 && sizeof(u64) == 8, "ABI widths");',
        "scalar width assertion")
    require_fragment(min_runtime, """typedef struct {
      const u8 *key;
      const u8 *owner;
      u8 *data;
      u64 size;
      u64 *lamports;
      u64 rent_epoch;
      unsigned signer, writable, executable;
    } Account;""", "Account layout")
    require_fragment(runtime, """typedef struct {
      Account *account;
      u32 length, capacity, stride;
    } BendCollection;""", "BendCollection layout")
    require_fragment(runtime, """typedef struct {
      u32 start, reserved, loaded;
    } BendCollectionWindow;""", "BendCollectionWindow layout")
    # Narrow, token-for-token helper bindings. The loops have constant use-site
    # counts (read_le/write_le n=4; equal_key processes four 8-byte chunks).
    expected = {
        "read_le": """static inline u64 read_le(const u8 *p, unsigned n) {
          u64 v = 0;
          for (unsigned i = 0; i < n; ++i) v |= (u64)p[i] << (8 * i);
          return v;
        }""",
        "write_le": """static inline void write_le(u8 *p, u64 v, unsigned n) {
          for (unsigned i = 0; i < n; ++i) p[i] = (u8)(v >> (8 * i));
        }""",
        "equal_key": """static inline unsigned equal_key(const u8 *a, const u8 *b) {
          for (unsigned i = 0; i < 32; i += 8) {
            u64 left, right;
            __builtin_memcpy(&left, a + i, 8);
            __builtin_memcpy(&right, b + i, 8);
            if (left != right) return 0;
          }
          return 1;
        }""",
    }
    for name, text in expected.items():
        sig = text[:text.index("{")].strip()
        actual = definition_tokens(min_runtime, sig)
        need(actual == lex(text), f"dependencies: unsupported {name} helper body")


def sign_extend_or_zero(value: CInt, width: int, signed: bool = False) -> CInt:
    if value.width == width:
        target = {8: "u8", 32: "int" if signed else "u32", 64: "u64"}[width]
        return convert_integer(value, target)
    if value.width < width:
        term = z3.SignExt(width - value.width, value.term) if value.signed else z3.ZeroExt(width - value.width, value.term)
    else:
        term = z3.Extract(width - 1, 0, value.term)
    target = {8: "u8", 32: "int" if signed else "u32", 64: "u64"}[width]
    return convert_integer(CInt(term, width, signed), target)


def usual(left: CInt, right: CInt) -> tuple[CInt, CInt, int]:
    common = c_runtime.usual_type(left.c_type, right.c_type)
    a, b = convert_integer(left, common), convert_integer(right, common)
    return a, b, a.width


def type_shape(ctype: str) -> tuple[int, bool, str]:
    canonical = c_runtime.canonical_type(ctype)
    width = c_runtime.WIDTH[canonical]
    return width, canonical == "int", canonical


def convert_integer(value: CInt, target: str) -> CInt:
    """Use the independently reviewed C conversion for a declared destination."""
    source = c_runtime.cval(value.c_type, value.term)
    converted = c_runtime.convert(source, target)
    width, signed, canonical = type_shape(target)
    return CInt(z3.simplify(converted.bits), width, signed, canonical)


def integer_promotion(value: CInt) -> CInt:
    return convert_integer(value, c_runtime.integer_promotion(value.c_type))


def signed_multiply_safe(left: z3.BitVecRef, right: z3.BitVecRef) -> z3.BoolRef:
    width = left.size()
    need(width == right.size(), "signed multiplication: operand width mismatch")
    product = z3.SignExt(width, left) * z3.SignExt(width, right)
    return z3.And(product >= bv(-(1 << (width - 1)), width * 2),
                  product <= bv((1 << (width - 1)) - 1, width * 2))


def has_assignment_to(node: Any, name: str) -> bool:
    if isinstance(node, list):
        return any(has_assignment_to(child, name) for child in node)
    if not isinstance(node, tuple):
        return False
    if node[0] == "assign" and node[1] == ("id", name):
        return True
    return any(has_assignment_to(child, name) for child in node[1:]
               if isinstance(child, (tuple, list)))


def invariant_loop_bound(node: Any) -> bool:
    if isinstance(node, list):
        return all(invariant_loop_bound(child) for child in node)
    if not isinstance(node, tuple):
        return True
    if node[0] in ("index", "call", "compound", "assign", "for"):
        return False
    return all(invariant_loop_bound(child) for child in node[1:]
               if isinstance(child, (tuple, list)))


def loop_return_literals(node: Any) -> list[CInt]:
    if isinstance(node, list):
        return [result for child in node for result in loop_return_literals(child)]
    if not isinstance(node, tuple):
        return []
    if node[0] == "for":
        raise Grammar("loop: nested loop summaries are unsupported")
    if node[0] == "return":
        expression = node[1]
        need(expression[0] == "literal" and isinstance(expression[1], CInt),
             "loop: only a constant early return is supported by quantified coverage")
        return [expression[1]]
    return [result for child in node[1:] if isinstance(child, (tuple, list))
            for result in loop_return_literals(child)]


@dataclass
class Semantics:
    arrays: dict[str, z3.ArrayRef]
    extents: dict[str, z3.BitVecRef]
    read_obligations: list[tuple[z3.BoolRef, z3.BoolRef, str]] = field(default_factory=list)
    ub_obligations: list[tuple[z3.BoolRef, z3.BoolRef, str]] = field(default_factory=list)
    helper_calls: dict[str, int] = field(default_factory=dict)
    pointer_context: str | None = None

    def span(self, pointer: BytePtr, width: int, path: z3.BoolRef, label: str) -> None:
        need(not pointer.null, f"memory: null pointer in {label}")
        width_bv = bv(width, 64)
        end = pointer.offset + width_bv
        no_wrap = z3.UGE(end, pointer.offset)
        within = z3.ULE(end, self.extents[pointer.obj])
        self.read_obligations.append((path, z3.And(no_wrap, within), label))

    def pointer_add(self, ptr: BytePtr, amount: CInt, path: z3.BoolRef, label: str) -> BytePtr:
        need(amount.width <= 64, "pointer: index wider than u64")
        index = (z3.SignExt(64 - amount.width, amount.term) if amount.signed and amount.width < 64
                 else amount.term if amount.signed else z3.ZeroExt(64 - amount.width, amount.term))
        new = z3.simplify(ptr.offset + index)
        if amount.signed:
            negative = z3.Extract(63, 63, index) == bv(1, 1)
            magnitude = -index
            no_wrap = z3.If(negative, z3.UGE(ptr.offset, magnitude), z3.UGE(new, ptr.offset))
        else:
            no_wrap = z3.UGE(new, ptr.offset)
        within = z3.ULE(new, self.extents[ptr.obj])
        formation_label = (self.pointer_context + " pointer formation"
                           if self.pointer_context is not None else label + " pointer formation")
        self.read_obligations.append((path, z3.And(no_wrap, within), formation_label))
        return BytePtr(ptr.obj, new)

    def read_byte(self, pointer: BytePtr, index: CInt, path: z3.BoolRef, label: str) -> CInt:
        ptr = self.pointer_add(pointer, index, path, label)
        self.span(ptr, 1, path, label + " byte read")
        value = z3.Select(self.arrays[pointer.obj], ptr.offset)
        return CInt(value, 8, False, "u8")

    def read_le(self, pointer: BytePtr, count: CInt, path: z3.BoolRef) -> CInt:
        need(z3.is_bv_value(count.term) and count.term.as_long() == 4,
             "helper: read_le call length must be the reviewed constant four")
        self.helper_calls["read_le"] = self.helper_calls.get("read_le", 0) + 1
        self.span(pointer, 4, path, "read_le")
        octets = [z3.Select(self.arrays[pointer.obj], pointer.offset + bv(i, 64)) for i in range(4)]
        return CInt(z3.Concat(octets[3], octets[2], octets[1], octets[0]), 32, False, "u32")

    def key_value(self, pointer: BytePtr, path: z3.BoolRef) -> z3.BitVecRef:
        self.helper_calls["equal_key"] = self.helper_calls.get("equal_key", 0) + 1
        self.span(pointer, 32, path, "equal_key")
        octets = [z3.Select(self.arrays[pointer.obj], pointer.offset + bv(i, 64)) for i in range(32)]
        return z3.Concat(*octets[::-1])

    def call_equal_key(self, a: BytePtr, b: BytePtr, path: z3.BoolRef) -> CInt:
        left, right = self.key_value(a, path), self.key_value(b, path)
        return CInt(z3.If(left == right, bv(1, 32), bv(0, 32)), 32, False, "u32")


def value_expr(node: Any, env: dict[str, CValue], sem: Semantics,
               path: z3.BoolRef) -> CValue:
    kind = node[0]
    if kind == "literal":
        return node[1]
    if kind == "id":
        if node[1] == "BEND_COLLECTION_HEADER":
            return CInt(bv(56, 32), 32, False, "u32")
        need(node[1] in env, f"expression: unknown or uninitialized identifier {node[1]}")
        return env[node[1]]
    if kind == "un":
        op, value = node[1], value_expr(node[2], env, sem, path)
        if op == "!":
            return CInt(z3.simplify(z3.If(z3.Not(bool_of(value)), bv(1, 32), bv(0, 32))), 32, True, "int")
        if op == "*":
            need(isinstance(value, StructPtr), "dereference: only structure output is supported")
            return StructValue(value.name, dict(value.fields))
        if op in ("+", "-"):
            need(isinstance(value, CInt), "unary arithmetic: expected scalar")
            promoted = integer_promotion(value)
            if op == "+":
                return promoted
            if promoted.signed:
                sem.ub_obligations.append((path,
                    promoted.term != bv(-(1 << (promoted.width - 1)), promoted.width),
                    "unary minus signed minimum"))
            return CInt(z3.simplify(-promoted.term), promoted.width, promoted.signed,
                        promoted.c_type)
        raise Grammar("expression: unsupported unary operator " + op)
    if kind == "cast":
        typ, pointer, inner = node[1], node[2], value_expr(node[3], env, sem, path)
        if pointer:
            need(isinstance(inner, CInt) and z3.is_bv_value(inner.term) and inner.term.as_long() == 0,
                 "cast: only the reviewed null pointer cast is supported")
            return BytePtr("data", bv(0, 64), True)
        need(isinstance(inner, CInt), "cast: scalar cast expected")
        need(typ in ("int", "u8", "u32", "unsigned", "u64"),
             "cast: unsupported scalar target " + typ)
        return convert_integer(inner, typ)
    if kind == "compound":
        need(node[1] == "BendCollection" and len(node[2]) == 4,
             "compound literal: unsupported structure")
        vals = [value_expr(v, env, sem, path) for v in node[2]]
        need(isinstance(vals[0], StructPtr) and vals[0].name == "Account", "compound: account pointer required")
        need(all(isinstance(v, CInt) for v in vals[1:]), "compound: scalar collection fields required")
        return StructValue("BendCollection", {
            "account": vals[0],
            "length": convert_integer(vals[1], "u32"),
            "capacity": convert_integer(vals[2], "u32"),
            "stride": convert_integer(vals[3], "u32"),
        })
    if kind == "member":
        op, base_node, field_name = node[1], node[2], node[3]
        base = value_expr(base_node, env, sem, path)
        need((op == "->" and isinstance(base, StructPtr)) or
             (op == "." and isinstance(base, StructValue)), "member: pointer/member operator mismatch")
        need(field_name in base.fields, f"member: unknown field {base.name}.{field_name}")
        return base.fields[field_name]
    if kind == "index":
        base = value_expr(node[1], env, sem, path)
        index = value_expr(node[2], env, sem, path)
        need(isinstance(base, BytePtr) and isinstance(index, CInt), "index: unsupported indexed object")
        return sem.read_byte(base, index, path, "array subscript")
    if kind == "call":
        name = node[1]
        args = [value_expr(arg, env, sem, path) for arg in node[2]]
        if name == "equal_key":
            need(len(args) == 2 and all(isinstance(a, BytePtr) for a in args), "equal_key: expected two key spans")
            return sem.call_equal_key(args[0], args[1], path)
        if name == "read_le":
            need(len(args) == 2 and isinstance(args[0], BytePtr) and isinstance(args[1], CInt),
                 "read_le: expected pointer and count")
            return sem.read_le(args[0], args[1], path)
        raise Grammar("call: unsupported or effectful helper " + name)
    if kind == "bin":
        op = node[1]
        left = value_expr(node[2], env, sem, path)
        if op == "+" and isinstance(left, BytePtr):
            right = value_expr(node[3], env, sem, path)
            need(isinstance(right, CInt), "pointer addition: scalar index required")
            return sem.pointer_add(left, right, path, "byte pointer")
        if op in ("&&", "||"):
            need(isinstance(left, CInt), "logical expression: scalar operands required")
            left_truth = bool_of(left)
            right_path = z3.And(path, left_truth if op == "&&" else z3.Not(left_truth))
            right = value_expr(node[3], env, sem, right_path)
            need(isinstance(right, CInt), "logical expression: scalar operands required")
            pred = z3.And(left_truth, bool_of(right)) if op == "&&" else z3.Or(left_truth, bool_of(right))
            return CInt(z3.If(pred, bv(1, 32), bv(0, 32)), 32, True, "int")
        right = value_expr(node[3], env, sem, path)
        need(isinstance(left, CInt) and isinstance(right, CInt), "binary expression: scalar operands required")
        if op in ("<<", ">>"):
            a, b = integer_promotion(left), integer_promotion(right)
            nonnegative = z3.Not(z3.Extract(b.width - 1, b.width - 1, b.term) == bv(1, 1)) \
                if b.signed else z3.BoolVal(True)
            valid_count = z3.And(nonnegative, z3.ULT(b.term, bv(a.width, b.width)))
            sem.ub_obligations.append((path, valid_count, f"shift {op} count in range"))
            amount = convert_integer(b, a.c_type)
            if op == "<<":
                result = a.term << amount.term
                if a.signed:
                    maximum = bv((1 << (a.width - 1)) - 1, a.width)
                    representable = z3.And(a.term >= bv(0, a.width),
                        z3.ULE(a.term, z3.LShR(maximum, amount.term)))
                    sem.ub_obligations.append((path, representable,
                        "signed left shift operand nonnegative and result representable"))
            else:
                result = a.term >> amount.term if a.signed else z3.LShR(a.term, amount.term)
            return CInt(z3.simplify(result), a.width, a.signed, a.c_type)
        a, b, width = usual(left, right)
        if op in ("==", "!=", "<", ">", "<=", ">="):
            if op == "==": pred = a.term == b.term
            elif op == "!=": pred = a.term != b.term
            elif op == "<": pred = z3.ULT(a.term, b.term) if not (a.signed and b.signed) else a.term < b.term
            elif op == ">": pred = z3.UGT(a.term, b.term) if not (a.signed and b.signed) else a.term > b.term
            elif op == "<=": pred = z3.ULE(a.term, b.term) if not (a.signed and b.signed) else a.term <= b.term
            else: pred = z3.UGE(a.term, b.term) if not (a.signed and b.signed) else a.term >= b.term
            return CInt(z3.simplify(z3.If(pred, bv(1, 32), bv(0, 32))), 32, True, "int")
        if op == "+": result = a.term + b.term
        elif op == "-": result = a.term - b.term
        elif op == "*": result = a.term * b.term
        elif op == "/":
            sem.ub_obligations.append((path, b.term != bv(0, width), "division divisor nonzero"))
            if a.signed:
                safe = z3.Not(z3.And(a.term == bv(-(1 << (width - 1)), width),
                                     b.term == bv(-1, width)))
                sem.ub_obligations.append((path, safe, "signed division minimum divided by negative one"))
                result = a.term / b.term
            else:
                result = z3.UDiv(a.term, b.term)
        elif op == "%":
            sem.ub_obligations.append((path, b.term != bv(0, width), "remainder divisor nonzero"))
            if a.signed:
                safe = z3.Not(z3.And(a.term == bv(-(1 << (width - 1)), width),
                                     b.term == bv(-1, width)))
                sem.ub_obligations.append((path, safe, "signed remainder minimum divided by negative one"))
                result = z3.SRem(a.term, b.term)
            else:
                result = z3.URem(a.term, b.term)
        elif op == "&": result = a.term & b.term
        elif op == "|": result = a.term | b.term
        elif op == "^": result = a.term ^ b.term
        else: raise Grammar("binary expression: unsupported operator " + op)
        if a.signed and op in ("+", "-", "*"):
            safe = (c_runtime.signed_arithmetic_safe("add" if op == "+" else "sub", a.term, b.term)
                    if op in ("+", "-") else signed_multiply_safe(a.term, b.term))
            sem.ub_obligations.append((path, safe, f"signed int {op} representable"))
        return CInt(z3.simplify(result), width, a.signed, a.c_type)
    if kind == "cond":
        cond = bool_of(value_expr(node[1], env, sem, path))
        yes = value_expr(node[2], env, sem, z3.And(path, cond))
        no = value_expr(node[3], env, sem, z3.And(path, z3.Not(cond)))
        if isinstance(yes, CInt) and isinstance(no, CInt):
            y, n, width = usual(yes, no)
            return CInt(z3.If(cond, y.term, n.term), width, y.signed, y.c_type)
        raise Grammar("conditional expression: unsupported pointer/structure result")
    raise Grammar("expression: unsupported AST node " + kind)


@dataclass
class State:
    path: z3.BoolRef
    env: dict[str, CValue]
    types: dict[str, str] = field(default_factory=dict)
    returned: CValue | None = None
    return_name: str | None = None
    out_fields: dict[str, CValue] = field(default_factory=dict)
    const_scalars: set[str] = field(default_factory=set)
    readonly_pointers: set[str] = field(default_factory=set)


def clone_value(value: CValue, memo: dict[int, CValue] | None = None) -> CValue:
    memo = {} if memo is None else memo
    if isinstance(value, (CInt, BytePtr)):
        return value
    identity = id(value)
    if identity in memo:
        return memo[identity]
    if isinstance(value, StructPtr):
        cloned = StructPtr(value.name, {}, value.identity)
        memo[identity] = cloned
        cloned.fields.update({key: clone_value(item, memo) for key, item in value.fields.items()})
        return cloned
    cloned_value = StructValue(value.name, {})
    memo[identity] = cloned_value
    cloned_value.fields.update({key: clone_value(item, memo) for key, item in value.fields.items()})
    return cloned_value


def clone_env(env: dict[str, CValue]) -> dict[str, CValue]:
    memo: dict[int, CValue] = {}
    return {key: clone_value(value, memo) for key, value in env.items()}


def clone_open_state(st: State, path: z3.BoolRef) -> State:
    return State(path, clone_env(st.env), dict(st.types), st.returned,
                 st.return_name, clone_env(st.out_fields),
                 set(st.const_scalars), set(st.readonly_pointers))


def same_value(left: Any, right: Any) -> bool:
    if left is right:
        return True
    if isinstance(left, CInt) and isinstance(right, CInt):
        return (left.width == right.width and left.c_type == right.c_type
                and z3.eq(left.term, right.term))
    if isinstance(left, BytePtr) and isinstance(right, BytePtr):
        return left.obj == right.obj and left.null == right.null and z3.eq(left.offset, right.offset)
    if isinstance(left, StructPtr) and isinstance(right, StructPtr):
        return (left.identity == right.identity and left.name == right.name
                and left.fields.keys() == right.fields.keys()
                and all(same_value(v, right.fields[k]) for k, v in left.fields.items()))
    if isinstance(left, StructValue) and isinstance(right, StructValue):
        return (left.name == right.name and left.fields.keys() == right.fields.keys()
                and all(same_value(v, right.fields[k]) for k, v in left.fields.items()))
    return False


def value_eq(left: Any, right: Any) -> z3.BoolRef:
    if isinstance(left, CInt) and isinstance(right, CInt):
        if left.width != right.width or left.c_type != right.c_type:
            return z3.BoolVal(False)
        return left.term == right.term
    if isinstance(left, BytePtr) and isinstance(right, BytePtr):
        if left.obj != right.obj or left.null != right.null:
            return z3.BoolVal(False)
        return left.offset == right.offset
    if isinstance(left, StructPtr) and isinstance(right, StructPtr):
        if left.identity != right.identity or left.name != right.name or left.fields.keys() != right.fields.keys():
            return z3.BoolVal(False)
        return z3.And(*[value_eq(left.fields[key], right.fields[key]) for key in left.fields])
    if isinstance(left, StructValue) and isinstance(right, StructValue):
        if left.name != right.name or left.fields.keys() != right.fields.keys():
            return z3.BoolVal(False)
        return z3.And(*[value_eq(left.fields[key], right.fields[key]) for key in left.fields])
    return z3.BoolVal(False)


def assign_lvalue(lhs: Any, rhs: CValue, state: State, sem: Semantics) -> None:
    if lhs[0] == "id":
        name = lhs[1]
        need(name in state.env, "assignment: unsupported new variable")
        need(name not in state.const_scalars,
             f"assignment: write to const scalar {name} is unsupported grammar")
        old = state.env[name]
        if isinstance(old, CInt) and isinstance(rhs, CInt):
            target_type = state.types.get(name)
            need(target_type is not None, f"assignment: missing declared type for {name}")
            state.env[name] = convert_integer(rhs, target_type)
            return
        if isinstance(old, BytePtr) and isinstance(rhs, BytePtr):
            need(state.types.get(name, "").endswith("*"), "assignment: pointer type binding missing")
            state.env[name] = rhs
            return
        raise Grammar("assignment: unsupported scalar/pointer conversion")
    if lhs[0] == "un" and lhs[1] == "*":
        target = value_expr(lhs[2], state.env, sem, state.path)
        need(isinstance(target, StructPtr) and isinstance(rhs, StructValue) and target.name == rhs.name,
             "assignment: unsupported structure destination")
        need(target.identity == "open_output",
             "assignment: writes to input structure objects are unsupported; input-object immutability is a grammar restriction")
        memo: dict[int, CValue] = {}
        state.out_fields = clone_env(rhs.fields)
        target.fields.update({key: clone_value(value, memo) for key, value in rhs.fields.items()})
        return
    if lhs[0] == "member":
        op, base_node, field_name = lhs[1], lhs[2], lhs[3]
        base = value_expr(base_node, state.env, sem, state.path)
        need(op == "->" and isinstance(base, StructPtr) and field_name in base.fields,
             "assignment: unsupported member destination")
        need(base.identity == "open_output" and base.name == "BendCollection",
             "assignment: writes to Account/input fields are unsupported; input-object immutability is a grammar restriction")
        need(op == "=" and isinstance(rhs, CInt), "assignment: unsupported output field conversion")
        old = base.fields[field_name]
        need(isinstance(old, CInt), "assignment: output field is not a scalar")
        state.types[f"out->{field_name}"] = old.c_type
        rhs = convert_integer(rhs, old.c_type)
        base.fields[field_name] = rhs
        return
    if lhs[0] == "index":
        raise Grammar("assignment: indexed writes are unsupported grammar; input and const-derived stores are excluded")
    raise Grammar("assignment: unsupported lvalue")


def exec_open_stmt(node: Any, states: list[State], sem: Semantics) -> list[State]:
    kind = node[0]
    if kind == "block":
        live = states
        for child in node[1]:
            live = exec_open_stmt(child, live, sem)
        return live
    if kind == "if":
        out: list[State] = []
        for st in states:
            if st.returned is not None:
                out.append(st)
                continue
            cond = bool_of(value_expr(node[1], st.env, sem, st.path))
            yes = clone_open_state(st, z3.And(st.path, cond))
            no = clone_open_state(st, z3.And(st.path, z3.Not(cond)))
            out.extend(exec_open_stmt(node[2], [yes], sem))
            if node[3] is not None:
                out.extend(exec_open_stmt(node[3], [no], sem))
            else:
                out.append(no)
        return out
    if kind == "for":
        out: list[State] = []
        typ, var, init_ast, cond_ast, step, body = node[1:]
        width, signed, canonical = type_shape(typ)
        for st in states:
            if st.returned is not None:
                out.append(st)
                continue
            init = value_expr(init_ast, st.env, sem, st.path)
            need(isinstance(init, CInt), "loop: scalar induction initializer required")
            init = convert_integer(init, typ)
            need(isinstance(init, CInt) and z3.is_bv_value(init.term) and init.term.as_long() == 0,
                 "loop: only zero-based counted loops are supported")
            need(step == ("++", var), "loop: only unit increment loops are supported")
            need(not has_assignment_to(body, var),
                 f"loop: assignment to induction variable {var} is unsupported in quantified coverage")
            need(cond_ast[0] == "bin" and cond_ast[1] == "<"
                 and cond_ast[2] == ("id", var)
                 and not contains_name(cond_ast[3], var),
                 "loop: nonmonotonic induction guard is unsupported by quantified coverage")
            need(invariant_loop_bound(cond_ast[3]),
                 "loop: bound reads mutable memory or has side effects; invariant grammar required")
            return_literals = loop_return_literals(body)
            need(all(same_value(return_literals[0], value) for value in return_literals[1:]),
                 "loop: distinct early-return values are unsupported by quantified coverage")
            index = z3.BitVec("open_loop_" + var + "_" + str(len(out)), width)
            iter_env = clone_env(st.env)
            iter_types = dict(st.types)
            iter_env[var] = CInt(index, width, signed, canonical)
            iter_types[var] = typ
            iter_path = z3.BoolVal(True)
            before_reads, before_ubs = len(sem.read_obligations), len(sem.ub_obligations)
            loop_cond = bool_of(value_expr(cond_ast, iter_env, sem, iter_path))
            if width == 32:
                normal = z3.ForAll([index], z3.Implies(loop_cond, z3.ULT(index, bv(0xffffffff, 32))))
            else:
                normal = z3.ForAll([index], z3.Implies(loop_cond, z3.ULT(index, bv(0xffffffffffffffff, 64))))
            iter_state = State(loop_cond, iter_env, iter_types)
            body_states = exec_open_stmt(body, [iter_state], sem)
            returned = [b for b in body_states if b.returned is not None]
            continuing = [b for b in body_states if b.returned is None]
            need(all(not b.out_fields for b in body_states), "loop: output mutation is unsupported")
            need(all(all(same_value(b.env.get(k), v) for k, v in iter_env.items()
                         if k != var) for b in body_states),
                 "loop: mutation outside induction variable is unsupported")
            # Keep the induction variable free in each obligation.  An
            # UNSAT query then establishes the fact for every possible loop
            # index satisfying the actual loop guard, without quantifier
            # instantiation heuristics.
            for j in range(before_reads, len(sem.read_obligations)):
                guard, fact, label = sem.read_obligations[j]
                sem.read_obligations[j] = (z3.And(st.path, guard), fact, label)
            for j in range(before_ubs, len(sem.ub_obligations)):
                guard, fact, label = sem.ub_obligations[j]
                sem.ub_obligations[j] = (z3.And(st.path, guard), fact, label)
            for b in returned:
                iv = b.path
                exists = z3.Exists([index], z3.And(loop_cond, iv))
                ret = State(z3.And(st.path, exists), clone_env(st.env), dict(st.types),
                            b.returned, b.return_name, clone_env(st.out_fields))
                out.append(ret)
            normal_inner = z3.Or(*[b.path for b in continuing]) if continuing else z3.BoolVal(False)
            all_normal = z3.ForAll([index], z3.Implies(loop_cond, normal_inner))
            out.append(clone_open_state(st, z3.And(st.path, normal, all_normal)))
        return out
    if kind in ("decl", "decls"):
        out = []
        declarations = [node] if kind == "decl" else node[1]
        for st in states:
            if st.returned is not None:
                out.append(st)
                continue
            for _, typ, const, pointer, name, init_ast in declarations:
                need(name not in st.env, "declaration: shadowing is unsupported")
                need(init_ast is not None, "declaration: uninitialized local is unsupported in open")
                init = value_expr(init_ast, st.env, sem, st.path)
                if typ in ("int", "u8", "u32", "unsigned", "u64") and isinstance(init, CInt):
                    st.env[name] = convert_integer(init, typ)
                    st.types[name] = typ
                    if const:
                        st.const_scalars.add(name)
                elif pointer and isinstance(init, (BytePtr, StructPtr)):
                    st.env[name] = init
                    st.types[name] = typ + "*"
                    if const:
                        st.readonly_pointers.add(name)
                else:
                    raise Grammar("declaration: unsupported initialized local")
            out.append(st)
        return out
    if kind == "assign":
        out = []
        _, lhs, op, rhs_ast = node
        for st in states:
            if st.returned is not None:
                out.append(st)
                continue
            need(op == "=", "assignment: compound assignment is outside open grammar")
            rhs = value_expr(rhs_ast, st.env, sem, st.path)
            assign_lvalue(lhs, rhs, st, sem)
            out.append(st)
        return out
    if kind == "return":
        out = []
        for st in states:
            if st.returned is not None:
                out.append(st)
                continue
            old_pointer_context = sem.pointer_context
            sem.pointer_context = "record return"
            try:
                st.returned = value_expr(node[1], st.env, sem, st.path)
            finally:
                sem.pointer_context = old_pointer_context
            st.return_name = "open"
            out.append(st)
        return out
    raise Grammar("open: unsupported statement " + kind)


def array(name: str) -> z3.ArrayRef:
    return z3.Array(name, z3.BitVecSort(64), z3.BitVecSort(8))


def int_array(name: str) -> z3.ArrayRef:
    return z3.Array(name, z3.IntSort(), z3.BitVecSort(8))


def input_model() -> tuple[Semantics, dict[str, CValue], dict[str, z3.BitVecRef]]:
    data_size = z3.BitVec("collection_data_size", 64)
    arrays = {name: array("collection_bytes_" + name)
              for name in ("data", "owner", "program", "state_key", "header", "encoded")}
    sem = Semantics(arrays, {
        "data": data_size, "owner": bv(32, 64), "program": bv(32, 64),
        "state_key": bv(32, 64), "header": bv(20, 64), "encoded": data_size,
    })
    size = z3.BitVec("collection_size", 64)
    account = StructPtr("Account", {
        "owner": BytePtr("owner", bv(0, 64)),
        "data": BytePtr("data", bv(0, 64)),
        "size": CInt(size, 64),
        "signer": CInt(z3.BitVec("collection_signer", 32), 32),
        "writable": CInt(z3.BitVec("collection_writable", 32), 32),
        "executable": CInt(z3.BitVec("collection_executable", 32), 32),
    }, "account")
    initial_out = {
        "account": StructPtr("Account", {}, "old_output_account"),
        "length": CInt(z3.BitVec("out_old_length", 32), 32),
        "capacity": CInt(z3.BitVec("out_old_capacity", 32), 32),
        "stride": CInt(z3.BitVec("out_old_stride", 32), 32),
    }
    output = StructPtr("BendCollection", dict(initial_out), "open_output")
    program = BytePtr("program", bv(0, 64))
    state_key = BytePtr("state_key", bv(0, 64))
    header = BytePtr("header", bv(0, 64))
    stride = CInt(z3.BitVec("open_stride", 32), 32)
    initialize = CInt(z3.BitVec("open_initialize", 32), 32)
    env: dict[str, CValue] = {"a": account, "program": program,
        "state_key": state_key, "header": header, "stride": stride,
        "initialize": initialize, "out": output}
    symbols = {"size": size, "stride": stride.term, "initialize": initialize.term,
               "data_size": data_size, "output_length": initial_out["length"].term,
               "output_capacity": initial_out["capacity"].term,
               "output_stride": initial_out["stride"].term}
    return sem, env, symbols


SOLVER_CALLS = 0
UNSIGNED_SHADOW_LEMMAS: dict[int, dict[str, Any]] = {}
UNSIGNED_SHADOW_LEMMA_SOLVER_CALLS: dict[int, int] = {}


def solver_result(assumptions: list[z3.BoolRef], proposition: z3.BoolRef,
                  wanted: str = "unsat", timeout_ms: int = 60_000,
                  tactic: tuple[str, ...] | None = None,
                  context: z3.Context | None = None) -> dict[str, Any]:
    global SOLVER_CALLS
    SOLVER_CALLS += 1
    if os.environ.get("COLLECTION_LIFECYCLE_DEBUG"):
        print("z3 query", SOLVER_CALLS, "assumptions", len(assumptions),
              "formula chars", len(proposition.sexpr()), flush=True)
    if tactic is not None:
        stages = [z3.Tactic(name, ctx=context) if context is not None else z3.Tactic(name)
                  for name in tactic]
        solver = z3.Then(*stages).solver()
    else:
        solver = z3.Solver(ctx=context) if context is not None else z3.Solver()
    solver.set(timeout=timeout_ms)
    solver.add(*assumptions, proposition)
    result = solver.check()
    if result == z3.unknown:
        raise RuntimeError("Z3 unknown: " + solver.reason_unknown())
    if result == z3.unsat and wanted == "unsat":
        return {"result": "unsat", "counterexample": None}
    if result == z3.sat:
        model = solver.model()
        terms: dict[str, z3.ExprRef] = {}
        casts: dict[str, z3.ExprRef] = {}
        for expression in (*assumptions, proposition):
            for term in free_constants(expression):
                terms[str(term.decl().name())] = term
            todo = [expression]
            seen: set[int] = set()
            while todo:
                node = todo.pop()
                if node.get_id() in seen:
                    continue
                seen.add(node.get_id())
                if (z3.is_app(node) and node.decl().kind() == z3.Z3_OP_INT2BV
                        and z3.is_const(node.arg(0))):
                    shadow_name = str(node.arg(0).decl().name())
                    casts[f"{shadow_name.removesuffix('_int')}_c{node.size()}"] = node
                todo.extend(node.children())
        cast_shadow_names = {str(cast.arg(0).decl().name()) for cast in casts.values()}
        values = {
            name: str(model.eval(term, model_completion=True))
            for name, term in sorted(terms.items())
            if name not in cast_shadow_names
        }
        values.update({name: str(model.eval(term, model_completion=True))
                       for name, term in sorted(casts.items())})
        if wanted == "sat":
            return {"result": "sat", "counterexample": values}
        return {"result": "sat", "counterexample": values}
    raise AssertionError(f"expected {wanted}, got {result}")


def unsigned_shadow_correspondence(width: int) -> dict[str, Any]:
    """Prove the unsigned Int2BV inverse once per supported C integer width.

    Every modeled C input is an Int shadow wrapped with Int2BV at its declared
    width. Its caller facts include the matching unsigned range, so this
    generic theorem instantiates to that input without repeating an expensive
    mixed Int/bitvector query for every field.
    """
    need(width in (32, 64), "integer shadow: unsupported C width")
    if width not in UNSIGNED_SHADOW_LEMMAS:
        # A fresh Z3 context keeps this mixed-theory bridge independent of the
        # much larger quantified source model and its accumulated AST cache.
        context = z3.Context()
        shadow = z3.Int(f"unsigned_shadow_inverse_{width}", ctx=context)
        actual = z3.Int2BV(shadow, width)
        # Normalize the Int2BV/BV2Int bridge before SMT search. This proves the
        # same unsigned inverse theorem as the default solver, while avoiding
        # a fragile mixed-theory search path on the baseline gate.
        result = solver_result([0 <= shadow, shadow < 1 << width],
            z3.BV2Int(actual) != shadow,
            tactic=("simplify", "solve-eqs", "smt"), context=context)
        need(result["result"] == "unsat",
             f"integer shadow: unsigned {width}-bit inverse theorem failed")
        UNSIGNED_SHADOW_LEMMAS[width] = result
        UNSIGNED_SHADOW_LEMMA_SOLVER_CALLS[width] = 1
    return UNSIGNED_SHADOW_LEMMAS[width]


def unsigned_input_mapping(term: z3.BitVecRef, shadow: z3.ArithRef,
                           assumptions: list[z3.BoolRef]) -> dict[str, Any]:
    need(z3.is_app_of(term, z3.Z3_OP_INT2BV) and term.arg(0).eq(shadow),
         "integer shadow: C input is not the declared-width conversion of its shadow")
    width = term.size()
    lower, upper = 0 <= shadow, shadow < 1 << width
    need(any(z3.eq(fact, lower) for fact in assumptions)
         and any(z3.eq(fact, upper) for fact in assumptions),
         "integer shadow: caller facts omit the C input's unsigned range")
    return unsigned_shadow_correspondence(width)


def free_constants(expression: z3.ExprRef) -> set[z3.ExprRef]:
    found: set[z3.ExprRef] = set()
    todo = [expression]
    seen: set[int] = set()
    while todo:
        node = todo.pop()
        key = node.get_id()
        if key in seen:
            continue
        seen.add(key)
        if z3.is_const(node) and node.decl().kind() == z3.Z3_OP_UNINTERPRETED:
            found.add(node)
        todo.extend(node.children())
    return found


def free_names(expression: z3.ExprRef) -> set[str]:
    names: set[str] = set()
    todo = [expression]
    seen = set()
    while todo:
        node = todo.pop()
        key = node.get_id()
        if key in seen:
            continue
        seen.add(key)
        if z3.is_const(node) and node.decl().kind() == z3.Z3_OP_UNINTERPRETED:
            names.add(str(node.decl().name()))
        todo.extend(node.children())
    return names


def flatten_and(expression: z3.BoolRef) -> list[z3.BoolRef]:
    if z3.is_and(expression):
        return [part for child in expression.children() for part in flatten_and(child)]
    return [expression]


def expected_open_contract(sem: Semantics, env: dict[str, CValue], syms: dict[str, z3.BitVecRef]) -> tuple[z3.BitVecRef, dict[str, Any], dict[str, z3.BoolRef]]:
    a = env["a"]
    need(isinstance(a, StructPtr), "model: Account pointer")
    size = syms["size"]
    stride = syms["stride"]
    init = syms["initialize"]
    def key_raw(pointer: BytePtr) -> z3.BitVecRef:
        octets = [z3.Select(sem.arrays[pointer.obj], pointer.offset + bv(i, 64)) for i in range(32)]
        return z3.Concat(*octets[::-1])

    owner = key_raw(a.fields["owner"])
    program = key_raw(env["program"])
    owned = owner == program
    not_exec = bool_of(a.fields["executable"])
    writable = bool_of(a.fields["writable"])
    signer = bool_of(a.fields["signer"])
    nonzero_stride = stride != bv(0, 32)
    enough = z3.UGE(size, bv(56, 64))
    payload = size - bv(56, 64)
    stride64 = z3.ZeroExt(32, stride)
    # The open function guards both conditions before evaluating division.
    valid_divisor = nonzero_stride
    divisible = z3.URem(payload, stride64) == bv(0, 64)
    quotient = z3.UDiv(payload, stride64)
    quotient_fits = z3.ULE(quotient, bv(0xffffffff, 64))
    capacity = z3.Extract(31, 0, quotient)
    init_i = z3.BitVec("open_contract_init_i", 64)
    nonzero_data = z3.Exists([init_i], z3.And(z3.ULT(init_i, size),
        z3.Select(sem.arrays["data"], init_i) != bv(0, 8)))
    header_i = z3.BitVec("open_contract_header_i", 64)
    header_bad = z3.Exists([header_i], z3.And(z3.ULT(header_i, bv(20, 64)),
        z3.Select(sem.arrays["data"], header_i) != z3.Select(sem.arrays["header"], header_i)))
    header_matches = z3.Not(header_bad)
    data_key = BytePtr("data", bv(24, 64))
    key_matches = key_raw(data_key) == key_raw(env["state_key"])
    data_length = [z3.Select(sem.arrays["data"], bv(20 + i, 64)) for i in range(4)]
    length = z3.Concat(data_length[3], data_length[2], data_length[1], data_length[0])
    is_init = init != bv(0, 32)
    open_contract = collection_contracts.instantiate("open", {
        "base_valid": z3.And(owned, z3.Not(not_exec)),
        "writable": writable,
        "positive_stride": nonzero_stride,
        "minimum_header_size": enough,
        "divisible_payload": divisible,
        "capacity_fits_u32": quotient_fits,
        "initialize": is_init,
        "signer": signer,
        "allocation_zero": z3.Not(nonzero_data),
        "stored_header_matches": header_matches,
        "stored_key_matches": key_matches,
        "stored_length_valid": z3.ULE(length, capacity),
        "stored_length": length,
        "capacity_from_size_and_stride": capacity,
        "stride": stride,
    })
    expected = open_contract["status"]
    facts = {
        "base_valid": z3.And(owned, z3.Not(not_exec)),
        "writable": writable,
        "positive_stride": nonzero_stride,
        "minimum_header_size": enough,
        "divisible_payload": divisible,
        "capacity_fits_u32": quotient_fits,
        "initialized_allocation_zero": z3.Not(nonzero_data),
        "stored_header_matches": header_matches,
        "stored_key_matches": key_matches,
        "stored_length_within_capacity": z3.ULE(length, capacity),
        "capacity_equals_payload_div_stride": z3.Extract(31, 0, quotient) == capacity,
    }
    outputs = {"account": env["a"],
               **{name: CInt(term, 32, False, "u32")
                  for name, term in open_contract["outputs"].items()}}
    return expected, outputs, facts


def open_analysis(runtime: str, semantic_mutants: bool = True,
                  focused_witness: dict[str, int] | None = None,
                  focused_ub: bool = False,
                  focus_output_field: str | None = None) -> dict[str, Any]:
    signature = ("static inline u64 bend_collection_open(Account *a, const u8 *program, "
                 "const u8 *state_key, const u8 header[20], u32 stride, unsigned initialize, "
                 "BendCollection *out)")
    body = function_ast(runtime, signature)
    sem, env, syms = input_model()
    size = syms["size"]
    # Loader/object preconditions: actual C pointers name live, naturally
    # aligned struct objects; byte spans are readable and pairwise disjoint.
    pre = [z3.ULE(size, syms["data_size"]), z3.ULE(syms["data_size"], bv((1 << 64) - 1, 64)),
           z3.UGE(env["a"].fields["writable"].term, bv(0, 32)),
           z3.UGE(env["a"].fields["signer"].term, bv(0, 32))]
    old_out = clone_env(env["out"].fields)
    argument_types = {
        "a": "Account*", "program": "u8*", "state_key": "u8*",
        "header": "u8*", "stride": "u32", "initialize": "unsigned",
        "out": "BendCollection*",
    }
    states = exec_open_stmt(body, [State(z3.BoolVal(True), clone_env(env), argument_types)], sem)
    need(all(s.returned is not None for s in states), "open: fallthrough or unsupported loop termination")
    returns: list[tuple[z3.BoolRef, CInt]] = []
    for st in states:
        need(isinstance(st.returned, CInt), "open: non-scalar return")
        st.returned = sign_extend_or_zero(st.returned, 64)
        returns.append((st.path, st.returned.term))
    actual = bv(0, 64)
    for path, value in reversed(returns):
        actual = z3.If(path, value, actual)
    expected, outputs, facts = expected_open_contract(sem, env, syms)
    if focused_ub:
        ub_bad = z3.Or(*[z3.And(path, z3.Not(safe))
                         for path, safe, _label in sem.ub_obligations])
        return {"claims": [{
            "name": "open focused evaluated arithmetic avoids C undefined behavior",
            **solver_result(pre, ub_bad)}], "_body": body}
    if focused_witness is not None:
        required = {"expected_code", "size", "data_size", "stride", "initialize",
                    "writable", "signer", "executable", "stored_length"}
        need(set(focused_witness) == required,
             "open focused witness: every relevant C input must have an explicit value")
        witness_facts = [
            size == bv(focused_witness["size"], 64),
            syms["data_size"] == bv(focused_witness["data_size"], 64),
            syms["stride"] == bv(focused_witness["stride"], 32),
            syms["initialize"] == bv(focused_witness["initialize"], 32),
            env["a"].fields["writable"].term == bv(focused_witness["writable"], 32),
            env["a"].fields["signer"].term == bv(focused_witness["signer"], 32),
            env["a"].fields["executable"].term == bv(focused_witness["executable"], 32),
        ]
        stored_length = focused_witness["stored_length"]
        witness_facts.extend(z3.Select(sem.arrays["data"], bv(index, 64)) ==
            bv((stored_length >> (8 * (index - 20))) & 0xff, 8)
            if 20 <= index < 24 else
            z3.Select(sem.arrays["data"], bv(index, 64)) == bv(0, 8)
            for index in range(64))
        witness_facts.extend(z3.Select(sem.arrays["header"], bv(index, 64)) == bv(0, 8)
                             for index in range(20))
        witness_facts.extend(z3.Select(sem.arrays["state_key"], bv(index, 64)) == bv(0, 8)
                             for index in range(32))
        witness_facts.extend([
            z3.Select(sem.arrays["owner"], bv(index, 64)) == bv(0, 8)
            for index in range(32)])
        witness_facts.extend([
            z3.Select(sem.arrays["program"], bv(index, 64)) == bv(0, 8)
            for index in range(32)])
        expected_code = bv(focused_witness["expected_code"], 64)
        expected_fixture = solver_result([*pre, *witness_facts], expected != expected_code)
        need(expected_fixture["result"] == "unsat",
             "open focused witness: fixture does not satisfy the reference contract")
        actual_fixture = solver_result([*pre, *witness_facts], actual != expected_code)
        focused_claims = [
            {"name": "open focused witness satisfies the reference ordered contract",
             **expected_fixture},
            {"name": "open focused witness returns the expected ordered status",
             **actual_fixture}]
        if focus_output_field is not None:
            need(focus_output_field in ("length", "capacity", "stride"),
                 "open focused witness: unsupported output field")
            output_bad = z3.Or(*[
                z3.And(st.path, st.returned.term == bv(0, 64),
                       st.env["out"].fields[focus_output_field].term != outputs[focus_output_field].term)
                for st in states])
            focused_claims.append({"name": f"open focused witness exposes wrong {focus_output_field} output",
                **solver_result([*pre, *witness_facts], output_bad, wanted="sat")})
        return {"claims": focused_claims,
            "_body": body}
    # Helper spans in the reference contract are fixed and must also be safe.
    read_bad = []
    for path, fact, _label in sem.read_obligations:
        read_bad.append(z3.And(path, z3.Not(fact)))
    read_safe = z3.Not(z3.Or(*read_bad)) if read_bad else z3.BoolVal(True)
    return_exact = solver_result(pre, actual != expected)
    safety = solver_result(pre, z3.Not(read_safe))
    coverage = solver_result(pre, z3.Not(z3.Or(*[p for p, _ in returns])))
    pairwise = []
    for i in range(len(returns)):
        for j in range(i + 1, len(returns)):
            pairwise.append(z3.Not(z3.And(returns[i][0], returns[j][0])))
    exclusivity = solver_result(pre, z3.Not(z3.And(*pairwise))) if pairwise else {"result": "unsat", "counterexample": None}
    output_errors = []
    output_success = []
    for st in states:
        code = st.returned.term
        for name in ("length", "capacity", "stride"):
            old = old_out[name].term
            actual_out = st.env["out"].fields[name].term
            output_errors.append(z3.Implies(z3.And(st.path, code != bv(0, 64)), actual_out == old))
            output_success.append(z3.Implies(z3.And(st.path, code == bv(0, 64)), actual_out == outputs[name].term))
    refusal = solver_result(pre, z3.Not(z3.And(*output_errors)))
    output = solver_result(pre, z3.Not(z3.And(*output_success)))
    account_bad = []
    refusal_account_bad = []
    for st in states:
        unchanged = value_eq(st.env["a"], env["a"])
        account_bad.append(z3.And(st.path, z3.Not(unchanged)))
        refusal_account_bad.append(z3.And(st.path, st.returned.term != bv(0, 64),
                                          z3.Not(unchanged)))
    account_unchanged = solver_result(pre, z3.Or(*account_bad))
    refusal_account_unchanged = solver_result(pre, z3.Or(*refusal_account_bad))
    ub_bad = z3.Or(*[z3.And(path, z3.Not(safe))
                     for path, safe, _label in sem.ub_obligations])
    ub_safety = solver_result(pre, ub_bad)
    short_sem = Semantics({}, {})
    short_parser = CParser(lex("1 || (2147483647 + 1 < 0)"))
    short_expr = short_parser.expr()
    need(short_parser.at == len(short_parser.t), "C short-circuit regression parser did not consume expression")
    value_expr(short_expr, {}, short_sem, z3.BoolVal(True))
    short_bad = z3.Or(*[z3.And(path, z3.Not(safe))
                        for path, safe, _label in short_sem.ub_obligations])
    short_circuit = solver_result([], short_bad)
    # The exact-result theorem above compares all ordered paths with the
    # independently stated guard contract. Those guarded paths are the source
    # of the successful-open facts; duplicating their quantified byte scans in
    # a second monolithic query would add solver cost without another lemma.
    payload_i, stride_i = z3.Ints("capacity_lemma_payload capacity_lemma_stride")
    quotient_i = payload_i / stride_i
    division_lemma = solver_result([
        0 <= payload_i, payload_i < 1 << 64,
        1 <= stride_i, stride_i < 1 << 32,
        payload_i % stride_i == 0,
        quotient_i <= 0xffffffff,
    ], payload_i != quotient_i * stride_i)
    return {"claims": [
        {"name": "open exact ordered error/success contract", **return_exact},
        {"name": "open C reads stay within caller-provided objects", **safety},
        {"name": "open every path returns", **coverage},
        {"name": "open return paths are exclusive", **exclusivity},
        {"name": "refusal preserves output object", **refusal},
        {"name": "success writes exact collection fields", **output},
        {"name": "open Account object remains unchanged on success and refusal", **account_unchanged},
        {"name": "open refusal preserves the Account object", **refusal_account_unchanged},
        {"name": "open evaluated signed arithmetic and shifts avoid C undefined behavior", **ub_safety},
        {"name": "open C short-circuit skips undefined arithmetic in an unevaluated operand", **short_circuit},
        {"name": "open unsigned division/remainder yields exact capacity payload relation", **division_lemma},
    ], "verifiedFacts": [
        "owner equals program and collection is not executable before later validation",
        "collection is writable; stride is nonzero; account size is at least 56 bytes",
        "payload size is divisible by stride and capacity quotient fits u32",
        "initialization requires the collection account signer and every byte in the allocation is zero",
        "stored mode checks all 20 header bytes, all 32 state-key bytes, and stored u32 length <= capacity",
        "successful output is exactly {account, length, capacity, stride}; initialization length is zero",
        "refusal leaves all four output fields unchanged",
    ], "grammarRestrictions": [
        "only the BendCollection output receives a whole-structure store; Account member stores reject",
        "indexed stores, including account-data and const-derived stores, reject",
        "loop summaries quantify the full sequential index range only for zero-based unsigned unit increments with induction < an invariant bound, no induction or other state writes, and one constant early-return value",
        "scalar const writes reject and const-derived pointer stores reject",
        "output account-pointer identity follows the admitted aggregate assignment shape rather than a solver claim",
    ], "writeTargets": ["the sole admitted open store is the BendCollection output"],
        "readObligations": len(sem.read_obligations), "ubObligations": len(sem.ub_obligations),
        "helperCalls": sem.helper_calls,
        "returns": len(returns), "_body": body}


def short_circuit_expression_equivalence(runtime: str) -> dict[str, Any]:
    fragment = "!a->writable || (0 && (2147483647 + 1 < 0))"
    need(fragment in runtime,
         "short-circuit equivalence: expected rewritten guard expression is absent")
    sem, env, _syms = input_model()
    expressions = []
    for text in ("!a->writable", fragment):
        parser = CParser(lex(text))
        expression = parser.expr()
        need(parser.at == len(parser.t),
             "short-circuit equivalence: parser did not consume guard expression")
        expressions.append(value_expr(expression, env, sem, z3.BoolVal(True)))
    equivalent = solver_result([], z3.Not(value_eq(expressions[0], expressions[1])))
    ub_bad = z3.Or(*[z3.And(path, z3.Not(safe))
                     for path, safe, _label in sem.ub_obligations])
    ub_safety = solver_result([], ub_bad)
    return {"claims": [
        {"name": "open short-circuit guard preserves its C value", **equivalent},
        {"name": "open short-circuit guard does not evaluate signed overflow", **ub_safety},
    ]}


def open_expression_equivalence(name: str, rewritten_source: str,
                                old_statement: str, new_statement: str) -> dict[str, Any]:
    """Prove an isolated open-guard rewrite using the C expression model."""
    def parse_expected_condition(statement: str) -> Any:
        need(statement.startswith("if (") and statement.endswith(")"),
             "open expression equivalence: expected an if condition")
        parser = CParser(lex(statement[4:-1]))
        expression = parser.expr()
        need(parser.at == len(parser.t),
             "open expression equivalence: parser did not consume condition")
        return expression

    def matching_conditions(node: Any, expected: Any) -> list[Any]:
        if isinstance(node, list):
            return [match for child in node for match in matching_conditions(child, expected)]
        if not isinstance(node, tuple):
            return []
        matches = [node[1]] if node[0] == "if" and node[1] == expected else []
        return matches + [match for child in node[1:] if isinstance(child, (tuple, list))
                          for match in matching_conditions(child, expected)]

    signature = ("static inline u64 bend_collection_open(Account *a, const u8 *program, "
                 "const u8 *state_key, const u8 header[20], u32 stride, unsigned initialize, "
                 "BendCollection *out)")
    baseline_source = replace_once(rewritten_source, new_statement, old_statement,
                                   name + " source restoration")
    old_syntax = parse_expected_condition(old_statement)
    new_syntax = parse_expected_condition(new_statement)
    old_matches = matching_conditions(function_ast(baseline_source, signature), old_syntax)
    new_matches = matching_conditions(function_ast(rewritten_source, signature), new_syntax)
    need(len(old_matches) == 1 and len(new_matches) == 1,
         "open expression equivalence: expected unique parsed source conditions")
    sem, env, _syms = input_model()
    old_value = value_expr(old_matches[0], env, sem, z3.BoolVal(True))
    new_value = value_expr(new_matches[0], env, sem, z3.BoolVal(True))
    read_bad = z3.Or(*[z3.And(path, z3.Not(safe))
                       for path, safe, _label in sem.read_obligations])
    ub_bad = z3.Or(*[z3.And(path, z3.Not(safe))
                     for path, safe, _label in sem.ub_obligations])
    failed = z3.Or(z3.Not(value_eq(old_value, new_value)), read_bad, ub_bad)
    return {"claims": [{"name": f"{name} C expression value and evaluated safety", **solver_result([], failed)}]}


def fresh_collection_model() -> tuple[Semantics, StructPtr, StructPtr, StructPtr, dict[str, z3.ArithRef], list[z3.BoolRef]]:
    arrays = {name: array("life_bytes_" + name)
              for name in ("data", "owner", "program", "state_key", "header", "encoded")}
    # Quantified span arithmetic uses integer shadows, but each source C value
    # is exactly Int2BV(shadow, width).  The width-generic unsigned inverse
    # theorem below ties every shadow back to its actual C bitvector.
    size_i = z3.Int("life_size_int")
    length_i, capacity_i, stride_i = z3.Ints("life_length_int life_capacity_int life_stride_int")
    start_i, reserved_i, loaded_i = z3.Ints("life_start_int life_reserved_int life_loaded_int")
    size = z3.Int2BV(size_i, 64)
    sem = Semantics(arrays, {"data": size, "owner": bv(32, 64), "program": bv(32, 64),
        "state_key": bv(32, 64), "header": bv(20, 64), "encoded": z3.BitVec("scratch_extent", 64)})
    old_length, capacity, stride = z3.Int2BV(length_i, 32), z3.Int2BV(capacity_i, 32), z3.Int2BV(stride_i, 32)
    account = StructPtr("Account", {"data": BytePtr("data", bv(0, 64)),
        "size": CInt(size, 64, False, "u64")}, "life_account")
    collection = StructPtr("BendCollection", {"account": account,
        "length": CInt(old_length, 32, False, "u32"),
        "capacity": CInt(capacity, 32, False, "u32"),
        "stride": CInt(stride, 32, False, "u32")}, "life_collection")
    window = StructPtr("BendCollectionWindow", {
        "start": CInt(z3.Int2BV(start_i, 32), 32, False, "u32"),
        "reserved": CInt(z3.Int2BV(reserved_i, 32), 32, False, "u32"),
        "loaded": CInt(z3.Int2BV(loaded_i, 32), 32, False, "u32")}, "life_window")
    syms = {"size": size_i, "length": length_i, "capacity": capacity_i, "stride": stride_i,
        "start": start_i, "reserved": reserved_i, "loaded": loaded_i}
    open_facts = [stride_i > 0, size_i >= 56, size_i == 56 + capacity_i * stride_i,
        0 <= size_i, size_i < 1 << 64, 0 <= length_i, length_i <= capacity_i,
        0 <= capacity_i, capacity_i < 1 << 32, 0 <= stride_i, stride_i < 1 << 32]
    return sem, collection, window, account, syms, open_facts


def record_analysis(runtime: str, focus_claim: str | set[str] | None = None,
                    witness_inputs: dict[str, int] | None = None) -> dict[str, Any]:
    focus_claims = ({focus_claim} if isinstance(focus_claim, str) else focus_claim)
    signature = ("static inline const u8 *bend_collection_record(const BendCollection *c, "
                 "const BendCollectionWindow *w, u32 local)")
    body = function_ast(runtime, signature)
    sem, collection, window, account, syms, open_facts = fresh_collection_model()
    local_i = z3.Int("record_local_int")
    local = z3.Int2BV(local_i, 32)
    env: dict[str, CValue] = {"c": collection, "w": window,
        "local": CInt(local, 32, False, "u32")}
    size_i = syms["size"]
    start_i, reserved_i, loaded_i = syms["start"], syms["reserved"], syms["loaded"]
    length_i, capacity_i, stride_i = syms["length"], syms["capacity"], syms["stride"]
    size_bv = account.fields["size"].term
    start_bv, reserved_bv, loaded_bv = (window.fields[name].term
        for name in ("start", "reserved", "loaded"))
    length_bv, capacity_bv, stride_bv = (collection.fields[name].term
        for name in ("length", "capacity", "stride"))
    plan_facts = [0 <= start_i, start_i <= length_i, start_i <= capacity_i,
        0 <= reserved_i, reserved_i <= capacity_i - start_i,
        loaded_i == min_integer(length_i - start_i, reserved_i),
        0 <= local_i, local_i < 1 << 32]
    caller_facts = [*open_facts, *plan_facts]
    input_pairs = [
        ("size", size_bv, size_i, [0 <= size_i, size_i < 1 << 64]),
        ("length", length_bv, length_i, [0 <= length_i, length_i < 1 << 32]),
        ("capacity", capacity_bv, capacity_i, [0 <= capacity_i, capacity_i < 1 << 32]),
        ("stride", stride_bv, stride_i, [0 <= stride_i, stride_i < 1 << 32]),
        ("start", start_bv, start_i, [0 <= start_i, start_i < 1 << 32, start_i <= length_i,
            0 <= length_i, length_i < 1 << 32]),
        ("reserved", reserved_bv, reserved_i, [0 <= reserved_i, reserved_i < 1 << 32,
            reserved_i <= capacity_i - start_i, 0 <= start_i,
            0 <= capacity_i, capacity_i < 1 << 32]),
        ("loaded", loaded_bv, loaded_i, [0 <= loaded_i, loaded_i < 1 << 32,
            0 <= start_i, start_i <= length_i,
            0 <= reserved_i, reserved_i <= capacity_i - start_i,
            loaded_i == min_integer(length_i - start_i, reserved_i),
            0 <= capacity_i, capacity_i < 1 << 32]),
        ("local", local, local_i, [0 <= local_i, local_i < 1 << 32]),
    ]
    correspondence_applications = [
        {"name": f"record {name} input matches its C bitvector", "width": term.size()}
        for name, term, _integer, _assumptions in input_pairs
        if focus_claims is None or f"record {name} input matches its C bitvector" in focus_claims]
    capacity_stride_bv = z3.ZeroExt(32, capacity_bv) * z3.ZeroExt(32, stride_bv)
    index_facts_bv = [z3.UGE(size_bv, bv(56, 64)),
        size_bv == bv(56, 64) + capacity_stride_bv,
        z3.UGE(size_bv, capacity_stride_bv),
        z3.UGT(stride_bv, bv(0, 32)), z3.ULE(length_bv, capacity_bv),
        z3.ULE(start_bv, length_bv), z3.ULE(start_bv, capacity_bv),
        z3.ULE(z3.ZeroExt(1, start_bv) + z3.ZeroExt(1, reserved_bv),
               z3.ZeroExt(1, capacity_bv)),
        loaded_bv == z3.If(z3.ULE(length_bv - start_bv, reserved_bv),
                           length_bv - start_bv, reserved_bv)]
    witness_terms = {"size": size_bv, "length": length_bv,
        "capacity": capacity_bv, "stride": stride_bv, "start": start_bv,
        "reserved": reserved_bv, "loaded": loaded_bv, "local": local}
    witness_shadows = {"size": size_i, "length": length_i, "capacity": capacity_i,
        "stride": stride_i, "start": start_i, "reserved": reserved_i,
        "loaded": loaded_i, "local": local_i}
    witness_facts = []
    if witness_inputs is not None:
        need(set(witness_inputs) == set(witness_terms),
             "record witness: every C input must have an explicit value")
        witness_facts = [fact for name, value in witness_inputs.items()
            for fact in (witness_terms[name] == bv(value, witness_terms[name].size()),
                         witness_shadows[name] == value)]
    index_math_facts = [0 <= length_i, length_i <= capacity_i,
        0 <= capacity_i, capacity_i < 1 << 32, *plan_facts]
    states = exec_open_stmt(body, [State(z3.BoolVal(True), env, {
        "c": "BendCollection*", "w": "BendCollectionWindow*", "local": "u32",
    })], sem)
    need(all(s.returned is not None for s in states), "record: nonreturning path")
    actual: list[tuple[z3.BoolRef, CValue]] = [(s.path, s.returned) for s in states]
    record_contract = collection_contracts.instantiate("record", {
        "local": local, "loaded": loaded_bv, "start": start_bv,
        "stride": stride_bv, "data_size": size_bv,
    })
    active_bv = record_contract["active"]
    expected_offset_bv = record_contract["result_offset"]
    index_wide = z3.ZeroExt(1, start_bv) + z3.ZeroExt(1, local)
    actual_offset = bv(0, 64)
    actual_nonnull = z3.BoolVal(False)
    for path, value in actual:
        need(isinstance(value, BytePtr), "record: return is not a byte pointer")
        if not value.null:
            actual_nonnull = z3.Or(actual_nonnull, path)
            actual_offset = z3.If(path, value.offset, actual_offset)
    return_pointer_obligations = [(path, fact, label)
        for path, fact, label in sem.read_obligations
        if label == "record return pointer formation"]
    need(1 <= len(return_pointer_obligations) <= 2,
         "record pointer grammar restriction: noncanonical pointer-base arithmetic is unsupported")
    active_math = local_i < loaded_i
    logical_index = start_i + local_i
    address_math = 56 + logical_index * stride_i
    end_math = address_math + stride_i
    solver_claims = [
        ("record exact null/non-null guard", z3.Xor(actual_nonnull, active_bv), []),
        ("record address is exact 56 + (start + local) * stride",
            z3.And(active_bv, actual_offset != expected_offset_bv),
            index_facts_bv),
        ("record u32 index addition does not wrap", z3.And(active_bv,
            z3.UGT(index_wide, bv(0xffffffff, 33))), index_facts_bv),
        ("record C-width address arithmetic does not wrap", z3.And(active_math,
            z3.Or(address_math >= (1 << 64), end_math >= (1 << 64))), caller_facts),
        ("record returned stride lies within opened allocation", z3.And(active_math,
            z3.Or(address_math < 56, end_math > size_i)), caller_facts),
        ("record names a logical active record", z3.And(active_bv,
            z3.UGE(index_wide, z3.ZeroExt(1, length_bv))), index_facts_bv),
    ]
    results = [
        {"name": f"record {name} input matches its C bitvector",
         **unsigned_input_mapping(term, integer, assumptions)}
        for name, term, integer, assumptions in input_pairs
        if focus_claims is None or f"record {name} input matches its C bitvector" in focus_claims]
    for name, bad, assumptions in solver_claims:
        if os.environ.get("COLLECTION_LIFECYCLE_DEBUG"):
            print("record claim", name, flush=True)
        if focus_claims is None or name in focus_claims:
            focused_assumptions = [*assumptions, *witness_facts]
            results.append({"name": name, **solver_result(focused_assumptions, bad)})
    pointer_checks = []
    pointer_assumptions = [*index_facts_bv, *witness_facts]
    # A two-step return directly checks its intermediate base formation. The
    # final returned address is composed from the exact C-bitvector address,
    # arithmetic no-wrap, input mappings and active-record allocation-span
    # claims below. A one-step combined formation uses the same composition;
    # do not emit an empty/vacuous pointer-safety theorem for it.
    if len(return_pointer_obligations) == 2:
        path, fact, _label = return_pointer_obligations[0]
        pointer_checks.append(solver_result(pointer_assumptions,
            z3.And(path, z3.Not(fact))))
    pointer_checks.extend(solver_result(pointer_assumptions,
            z3.And(path, z3.Not(fact)))
        for path, fact, label in sem.read_obligations
        if label != "record return pointer formation")
    read_bounds = next((result for result in pointer_checks if result["result"] != "unsat"),
                       {"result": "unsat", "counterexample": None})
    if pointer_checks:
        results.append({"name": "record intermediate pointer formations and evaluated byte reads stay within caller-provided objects",
                        **read_bounds})
    if focus_claims is not None:
        if sem.ub_obligations:
            ub_safety = solver_result(index_facts_bv, z3.Or(*[
                z3.And(path, z3.Not(safe)) for path, safe, _label in sem.ub_obligations]))
            results.append({"name": "record evaluated signed arithmetic and shifts avoid C undefined behavior",
                            **ub_safety})
        returned_claim_names = {claim["name"] for claim in results}
        applicable_focus = focus_claims & {name for name, _bad, _assumptions in solver_claims}
        applicable_focus |= focus_claims & {
            f"record {name} input matches its C bitvector"
            for name, _term, _integer, _assumptions in input_pairs}
        if pointer_checks:
            applicable_focus |= focus_claims & {
                "record intermediate pointer formations and evaluated byte reads stay within caller-provided objects"}
        if sem.ub_obligations:
            applicable_focus |= focus_claims & {
                "record evaluated signed arithmetic and shifts avoid C undefined behavior"}
        need(applicable_focus <= returned_claim_names,
             "record focused claim is not present in the analyzed source")
        return {"claims": results,
            "correspondenceApplications": correspondence_applications,
            "pointerFormationObligations": sum("pointer formation" in label
                for _path, _fact, label in sem.read_obligations),
            "byteAccessObligations": sum("pointer formation" not in label
                for _path, _fact, label in sem.read_obligations),
            "grammarRestrictions": [
                "record reads are limited to modeled scalar and byte-array expressions",
                "the returned pointer uses one scalar-combined or two sequential pointer formations from account data; with two, the first formation is directly checked in C bitvectors, while the final address is tied to the exact-address, C-width no-wrap, input-correspondence and active-record span claims",
                "loop summaries require zero-based unsigned unit increments guarded by induction < invariant-bound; the exact monotonic guard enumerates the visited range",
            ], "_body": body}
    if sem.ub_obligations:
        ub_safety = solver_result(index_facts_bv, z3.Or(*[z3.And(path, z3.Not(safe))
                                                for path, safe, _label in sem.ub_obligations]))
        results.append({"name": "record evaluated signed arithmetic and shifts avoid C undefined behavior",
                        **ub_safety})
    return {"claims": results,
            "correspondenceApplications": correspondence_applications,
            "pointerFormationObligations": sum("pointer formation" in label
                for _path, _fact, label in sem.read_obligations),
            "byteAccessObligations": sum("pointer formation" not in label
                for _path, _fact, label in sem.read_obligations),
            "grammarRestrictions": [
                "record reads are limited to modeled scalar and byte-array expressions",
                "the returned pointer uses one scalar-combined or two sequential pointer formations from account data; with two, the first formation is directly checked in C bitvectors, while the final address is tied to the exact-address, C-width no-wrap, input-correspondence and active-record span claims",
                "loop summaries require zero-based unsigned unit increments guarded by induction < invariant-bound; the exact monotonic guard enumerates the visited range",
            ], "_body": body}


@dataclass
class MemUpdate:
    start: z3.BitVecRef
    count: z3.BitVecRef
    source: str | None
    source_start: z3.BitVecRef | None
    byte_values: list[z3.BitVecRef] | None


class MutableMemory:
    def __init__(self, source: z3.ArrayRef):
        self.source = source
        self.updates: list[MemUpdate] = []

    def add_copy(self, start: z3.BitVecRef, count: z3.BitVecRef,
                 source: str, source_start: z3.BitVecRef) -> None:
        self.updates.append(MemUpdate(start, count, source, source_start, None))

    def add_bytes(self, start: z3.BitVecRef, values: list[z3.BitVecRef]) -> None:
        self.updates.append(MemUpdate(start, bv(len(values), 64), None, None, values))

    def read(self, index: z3.BitVecRef, arrays: dict[str, z3.ArrayRef]) -> z3.BitVecRef:
        result = z3.Select(self.source, index)
        for update in self.updates:
            end = update.start + update.count
            cond = z3.And(z3.UGE(index, update.start), z3.ULT(index, end))
            if update.source is not None:
                src_index = update.source_start + (index - update.start)
                value = z3.Select(arrays[update.source], src_index)
            else:
                value = z3.BitVecVal(0, 8)
                for n, byte in enumerate(update.byte_values or []):
                    value = z3.If(index == update.start + bv(n, 64), byte, value)
            result = z3.If(cond, value, result)
        return result


def min_integer(a: z3.ArithRef, b: z3.ArithRef) -> z3.ArithRef:
    return z3.If(a < b, a, b)


def contains_name(node: Any, name: str) -> bool:
    if isinstance(node, tuple):
        if len(node) == 2 and node[0] == "id" and node[1] == name:
            return True
        return any(contains_name(child, name) for child in node[1:] if isinstance(child, tuple))
    if isinstance(node, list):
        return any(contains_name(child, name) for child in node)
    return False


def mentions_any(node: Any, names: set[str]) -> bool:
    return any(contains_name(node, name) for name in names)


def split_counted_index(node: Any, induction: str) -> Any:
    if node == ("id", induction):
        return ("literal", CInt(bv(0, 32), 32, True, "int"))
    if node[0] == "bin" and node[1] == "+":
        if node[2] == ("id", induction) and not contains_name(node[3], induction):
            return node[3]
        if node[3] == ("id", induction) and not contains_name(node[2], induction):
            return node[2]
    raise Grammar("commit loop: index must be base + induction with unit stride")


def commit_analysis(runtime: str, focus_claim: str | None = None,
                    witness_inputs: dict[str, int] | None = None,
                    open_claims: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    signature = ("static inline void bend_collection_commit(BendCollection *c, "
        "const BendCollectionWindow *w, u32 written, u32 next_length, "
        "const u8 *encoded, const u8 header[20], const u8 *state_key)")
    body = function_ast(runtime, signature)
    sem, collection, window, account, syms, open_facts = fresh_collection_model()
    written_i = z3.Int("commit_written_input")
    next_i = z3.Int("commit_next_length_input")
    scratch_i = z3.Int("commit_scratch_extent_input")
    written, next_bv = z3.Int2BV(written_i, 32), z3.Int2BV(next_i, 32)
    scratch_bv = z3.Int2BV(scratch_i, 64)
    arrays = {name: array("commit_bytes_" + name)
              for name in ("data", "encoded", "header", "state_key")}
    sem.arrays = arrays
    data_size_bv = account.fields["size"].term
    sem.extents = {"data": data_size_bv, "encoded": scratch_bv,
        "header": bv(20, 64), "state_key": bv(32, 64)}
    data = MutableMemory(arrays["data"])
    start_i, reserved_i, loaded_i = syms["start"], syms["reserved"], syms["loaded"]
    length_i, capacity_i, stride_i, size_i = (syms[name] for name in
        ("length", "capacity", "stride", "size"))
    start_bv = window.fields["start"].term
    reserved_bv = window.fields["reserved"].term
    loaded_bv = window.fields["loaded"].term
    length_bv = collection.fields["length"].term
    capacity_bv = collection.fields["capacity"].term
    stride_bv = collection.fields["stride"].term
    commit_address_env = {"start": start_bv, "stride": stride_bv, "written": written}
    commit_contract_doc = collection_contracts.CONTRACT_DOCUMENT["contracts"]["commit"]
    contract_record_start_bv = collection_contracts.term(commit_contract_doc["recordStart"], commit_address_env)
    contract_record_count_bv = collection_contracts.term(commit_contract_doc["recordCount"], commit_address_env)
    record_start_i = 56 + start_i * stride_i
    record_count_i = written_i * stride_i
    record_end_i = record_start_i + record_count_i
    added_i = written_i - loaded_i
    plan_facts = [0 <= start_i, start_i <= length_i, start_i <= capacity_i,
        0 <= reserved_i, reserved_i <= capacity_i - start_i,
        loaded_i == min_integer(length_i - start_i, reserved_i),
        loaded_i <= written_i, written_i <= reserved_i,
        length_i <= next_i, next_i <= capacity_i,
        added_i == next_i - length_i,
        z3.Implies(added_i > 0, length_i - start_i == loaded_i)]
    caller_facts = [*open_facts, *plan_facts,
        0 <= written_i, written_i < 1 << 32,
        0 <= next_i, next_i < 1 << 32,
        0 <= scratch_i, scratch_i < 1 << 64,
        record_count_i <= scratch_i,
        record_start_i >= 0, record_start_i <= size_i,
        record_end_i <= size_i, record_end_i < 1 << 64]
    env: dict[str, CValue] = {
        "c": collection, "w": window,
        "written": CInt(written, 32, False),
        "next_length": CInt(next_bv, 32, False),
        "encoded": BytePtr("encoded", bv(0, 64)),
        "header": BytePtr("header", bv(0, 64)),
        "state_key": BytePtr("state_key", bv(0, 64)),
    }
    span_specs: list[tuple[str, z3.ArithRef, z3.ArithRef, z3.ArithRef]] = []
    loop_layout: list[z3.BoolRef] = []
    loop_termination: list[z3.BoolRef] = []
    loop_index_semantics: list[tuple[z3.BoolRef, z3.BoolRef]] = []
    index_input_facts = [
        0 <= size_i, size_i < 1 << 64,
        0 <= start_i, start_i < 1 << 32,
        0 <= length_i, length_i < 1 << 32,
        0 <= capacity_i, capacity_i < 1 << 32,
        0 <= stride_i, stride_i < 1 << 32, stride_i > 0,
        0 <= reserved_i, reserved_i < 1 << 32,
        0 <= loaded_i, loaded_i < 1 << 32,
        0 <= written_i, written_i < 1 << 32,
        0 <= next_i, next_i < 1 << 32,
        0 <= scratch_i, scratch_i < 1 << 64,
        size_i == 56 + capacity_i * stride_i,
        written_i * stride_i <= scratch_i,
        start_i <= length_i, start_i <= capacity_i,
        reserved_i <= capacity_i - start_i,
        loaded_i == min_integer(length_i - start_i, reserved_i),
        loaded_i <= written_i, written_i <= reserved_i,
        length_i <= next_i, next_i <= capacity_i,
        added_i == next_i - length_i,
        z3.Implies(added_i > 0, length_i - start_i == loaded_i),
    ]

    local_types: dict[str, str] = {}
    local_conversions: list[dict[str, str]] = []
    const_scalars: set[str] = set()
    readonly_pointers: set[str] = {"w", "encoded", "header", "state_key"}
    verified_pointer_obligations: set[int] = set()

    def loop_store(node: Any, state_env: dict[str, CValue], type_env: dict[str, str]) -> None:
        _, typ, induction, init_ast, cond_ast, step, inner = node
        width, signed, canonical = type_shape(typ)
        need(step == ("++", induction), "commit loop: only unit-increment loops are supported")
        init = value_expr(init_ast, state_env, sem, z3.BoolVal(True))
        need(isinstance(init, CInt), "commit loop: scalar induction initializer required")
        init = convert_integer(init, typ)
        need(z3.is_bv_value(init.term) and init.term.as_long() == 0,
             f"commit loop: expected zero-based induction, found {init!r}")
        need(cond_ast[0] == "bin" and cond_ast[1] == "<" and cond_ast[2] == ("id", induction),
             "commit loop: nonmonotonic induction guard is unsupported by quantified copy")
        need(not contains_name(cond_ast[3], induction),
             "commit loop: guard bound must not depend on the induction variable")
        need(invariant_loop_bound(cond_ast[3]),
             "commit loop: bound reads mutable memory or has side effects; invariant grammar required")
        need(not has_assignment_to(inner, induction),
             f"commit loop: assignment to induction variable {induction} is unsupported")
        idx_bv = z3.BitVec("commit_i_" + str(len(data.updates)), width)
        iter_env = clone_env(state_env)
        iter_types = dict(type_env)
        iter_env[induction] = CInt(idx_bv, width, signed, ctype=canonical)
        iter_types[induction] = typ
        bound = value_expr(cond_ast[3], state_env, sem, z3.BoolVal(True))
        need(isinstance(bound, CInt), "commit loop: scalar bound required")
        _, comparison_bound, _ = usual(iter_env[induction], bound)
        comparison_type = c_runtime.usual_type(iter_env[induction].c_type, bound.c_type)
        need(not comparison_bound.signed,
             "commit loop: induction < bound must compare as an unsigned C value")
        count64 = sign_extend_or_zero(comparison_bound, 64).term
        narrowed = convert_integer(comparison_bound, canonical)
        narrowed_common = convert_integer(narrowed, comparison_type)
        count_fits_counter = comparison_bound.term == narrowed_common.term
        loop_termination.append(count_fits_counter)
        condition = value_expr(cond_ast, iter_env, sem, z3.BoolVal(True))
        need(isinstance(condition, CInt), "commit loop: guard did not produce a scalar")
        iteration_path = bool_of(condition)
        inner = inner if inner[0] == "block" and len(inner[1]) == 1 else inner
        if inner[0] == "block":
            inner = inner[1][0]
        need(inner[0] == "assign" and inner[2] == "=", "commit loop: expected one byte store")
        lhs, rhs = inner[1], inner[3]
        need(lhs[0] == "index" and rhs[0] == "index", "commit loop: expected indexed byte copy")
        target_base_ast = split_counted_index(lhs[2], induction)
        source_base_ast = split_counted_index(rhs[2], induction)
        need(invariant_loop_bound(target_base_ast),
             "commit loop: target index base reads memory or has side effects; invariant grammar required")
        need(invariant_loop_bound(source_base_ast),
             "commit loop: source index base reads memory or has side effects; invariant grammar required")
        target = value_expr(lhs[1], iter_env, sem, iteration_path)
        source = value_expr(rhs[1], iter_env, sem, iteration_path)
        need(isinstance(target, BytePtr) and isinstance(source, BytePtr),
             "commit loop: expected byte pointers")
        need(target.obj == "data",
             "commit loop: indexed destination must be collection data")
        need(not mentions_any(lhs[1], readonly_pointers),
             "commit loop: write through const-derived pointer is unsupported grammar")
        target_base = value_expr(target_base_ast, state_env, sem, z3.BoolVal(True))
        source_base = value_expr(source_base_ast, state_env, sem, z3.BoolVal(True))
        need(isinstance(target_base, CInt) and isinstance(source_base, CInt),
             "commit loop: index base must be scalar")
        target_index = value_expr(lhs[2], iter_env, sem, iteration_path)
        source_index = value_expr(rhs[2], iter_env, sem, iteration_path)
        need(isinstance(target_index, CInt) and isinstance(source_index, CInt),
             "commit loop: indexed copy expressions must remain scalar")
        target_base_c, target_induction_c, _ = usual(target_base, iter_env[induction])
        source_base_c, source_induction_c, _ = usual(source_base, iter_env[induction])
        need(not target_index.signed and not source_index.signed
             and not target_base_c.signed and not source_base_c.signed,
             "commit loop: signed byte indices are unsupported grammar")
        target_base64 = sign_extend_or_zero(target_base_c, 64).term
        source_base64 = sign_extend_or_zero(source_base_c, 64).term
        target_iteration64 = sign_extend_or_zero(target_induction_c, 64).term
        source_iteration64 = sign_extend_or_zero(source_induction_c, 64).term
        target_index64 = sign_extend_or_zero(target_index, 64).term
        source_index64 = sign_extend_or_zero(source_index, 64).term
        target_linear64 = target_base64 + target_iteration64
        source_linear64 = source_base64 + source_iteration64
        loop_index_semantics.extend([
            (iteration_path, target_index64 == target_linear64),
            (iteration_path, source_index64 == source_linear64),
        ])
        target_address = sem.pointer_add(target, target_index, iteration_path,
                                         "commit destination subscript")
        sem.span(target_address, 1, iteration_path, "commit destination byte write")
        source_address = sem.pointer_add(source, source_index, iteration_path,
                                         "commit source subscript")
        sem.span(source_address, 1, iteration_path, "commit source byte read")
        target_start = target.offset + target_base64
        source_start = source.offset + source_base64
        target_end = target_start + count64
        source_end = source_start + count64
        # The admitted grammar has unit-stride source and target indices. The
        # AST split above rejects all other index forms before this summary.
        need(source.obj in ("encoded", "header", "state_key"),
             "commit loop: unsupported byte-copy source object")
        expected_count = contract_record_count_bv \
            if source.obj == "encoded" else bv(20, 64) if source.obj == "header" else bv(32, 64)
        loop_layout.append(count64 == expected_count)
        if target.obj == "data" and source.obj == "encoded":
            expected_start = contract_record_start_bv
            loop_layout[-1] = z3.And(loop_layout[-1], target_start == expected_start,
                                     source_start == bv(0, 64))
        elif source.obj == "header":
            loop_layout[-1] = z3.And(loop_layout[-1], target_start == bv(0, 64), source_start == bv(0, 64))
        else:
            loop_layout[-1] = z3.And(loop_layout[-1], target_start == bv(24, 64), source_start == bv(0, 64))
        if source.obj == "encoded":
            span_target_start, span_count, span_source_extent = record_start_i, record_count_i, scratch_i
        elif source.obj == "header":
            span_target_start, span_count, span_source_extent = z3.IntVal(0), z3.IntVal(20), z3.IntVal(20)
        else:
            span_target_start, span_count, span_source_extent = z3.IntVal(24), z3.IntVal(32), z3.IntVal(32)
        span_specs.append((source.obj + " target", span_target_start, span_count, size_i))
        span_specs.append((source.obj + " source", z3.IntVal(0), span_count, span_source_extent))
        data.add_copy(target_start, count64, source.obj, source_start)

    def run_stmt(node: Any, state_env: dict[str, CValue], type_env: dict[str, str]) -> None:
        kind = node[0]
        if kind == "block":
            for child in node[1]:
                run_stmt(child, state_env, type_env)
            return
        if kind == "decl":
            _, typ, const, pointer, name, init_ast = node
            need(init_ast is not None, "commit: uninitialized local is outside grammar")
            pointer_obligations_before = len(sem.read_obligations)
            init = value_expr(init_ast, state_env, sem, z3.BoolVal(True))
            if pointer:
                need(isinstance(init, (BytePtr, StructPtr)), "commit declaration: pointer initializer required")
                if isinstance(init, BytePtr) and init_ast[0] == "bin" and init_ast[1] == "+":
                    new_pointer_obligations = sem.read_obligations[pointer_obligations_before:]
                    need(len(new_pointer_obligations) == 1 and init.obj == "data"
                         and z3.is_bv_value(z3.simplify(init.offset)),
                         "commit declaration: pointer-derived bases require one constant in-object offset")
                    path, fact, _label = new_pointer_obligations[0]
                    base_result = solver_result([z3.UGE(data_size_bv, bv(56, 64))],
                        z3.And(path, z3.Not(fact)))
                    need(base_result["result"] == "unsat",
                         "commit declaration: computed pointer base is unsupported because it is not proved within its object")
                    verified_pointer_obligations.update(
                        range(pointer_obligations_before, len(sem.read_obligations)))
                const_derived = mentions_any(init_ast, readonly_pointers)
                need(const or not const_derived,
                     "commit declaration: mutable alias of const-derived pointer is unsupported grammar")
                state_env[name] = init
                type_env[name] = typ + "*"
                if const or const_derived:
                    readonly_pointers.add(name)
                return
            need(isinstance(init, CInt), "commit declaration: scalar initializer required")
            need(typ in ("int", "u8", "u32", "unsigned", "u64"),
                 f"commit declaration: unsupported local type {typ}")
            type_env[name] = typ
            local_conversions.append({"name": name, "operation": "initialize",
                                      "sourceType": init.c_type,
                                      "destinationType": c_runtime.canonical_type(typ)})
            state_env[name] = convert_integer(init, typ)
            if const:
                const_scalars.add(name)
            return
        if kind == "for":
            loop_store(node, state_env, type_env)
            return
        if kind == "expr":
            call = node[1]
            need(call[0] == "call" and call[1] == "write_le" and len(call[2]) == 3,
                 "commit expression: only write_le is supported")
            pointer_start = len(sem.read_obligations)
            ptr = value_expr(call[2][0], state_env, sem, z3.BoolVal(True))
            for obligation_index in range(pointer_start, len(sem.read_obligations)):
                path, fact, _label = sem.read_obligations[obligation_index]
                pointer_result = solver_result([z3.UGE(data_size_bv, bv(56, 64))],
                    z3.And(path, z3.Not(fact)))
                need(pointer_result["result"] == "unsat",
                     "write_le destination pointer formation is not proved within account data")
                verified_pointer_obligations.add(obligation_index)
            value = value_expr(call[2][1], state_env, sem, z3.BoolVal(True))
            count = value_expr(call[2][2], state_env, sem, z3.BoolVal(True))
            need(isinstance(ptr, BytePtr) and ptr.obj == "data"
                 and not mentions_any(call[2][0], readonly_pointers)
                 and isinstance(value, CInt) and isinstance(count, CInt)
                 and z3.is_bv_value(count.term) and count.term.as_long() == 4,
                 "write_le: unsupported or const-derived destination")
            write_end = ptr.offset + bv(4, 64)
            loop_layout.append(ptr.offset == bv(20, 64))
            span_specs.append(("write_le target", z3.IntVal(20), z3.IntVal(4), size_i))
            sem.span(ptr, 4, z3.BoolVal(True), "write_le byte write")
            bytes_ = [z3.Extract(8*i+7, 8*i, sign_extend_or_zero(value, 64).term) for i in range(4)]
            data.add_bytes(ptr.offset, bytes_)
            return
        if kind == "assign":
            _, lhs, op, rhs_ast = node
            if lhs[0] == "member":
                base = value_expr(lhs[2], state_env, sem, z3.BoolVal(True))
                rhs = value_expr(rhs_ast, state_env, sem, z3.BoolVal(True))
                need(op == "=" and lhs[1] == "->" and isinstance(base, StructPtr)
                     and base.name == "BendCollection" and lhs[3] == "length" and isinstance(rhs, CInt),
                     "commit: unsupported structure write")
                need(not mentions_any(lhs[2], readonly_pointers),
                     "commit: write through const-derived pointer is unsupported grammar")
                old = base.fields["length"]
                need(isinstance(old, CInt), "commit: collection length is not scalar")
                base.fields["length"] = convert_integer(rhs, old.c_type)
                return
            if lhs[0] == "id":
                name = lhs[1]
                need(name in state_env and name in type_env and isinstance(state_env[name], CInt),
                     "commit assignment: scalar local with declared type required")
                need(name not in const_scalars,
                     f"commit assignment: write to const scalar {name} is unsupported grammar")
                if op == "=":
                    rhs = value_expr(rhs_ast, state_env, sem, z3.BoolVal(True))
                elif op in ("+=", "-="):
                    rhs = value_expr(("bin", op[0], ("id", name), rhs_ast),
                                     state_env, sem, z3.BoolVal(True))
                else:
                    raise Grammar(f"commit assignment: unsupported operator {op}")
                need(isinstance(rhs, CInt), "commit assignment: scalar result required")
                local_conversions.append({"name": name, "operation": op,
                                          "sourceType": rhs.c_type,
                                          "destinationType": c_runtime.canonical_type(type_env[name])})
                state_env[name] = convert_integer(rhs, type_env[name])
                return
            raise Grammar("commit: direct stores outside counted copy loop are unsupported")
        raise Grammar("commit: unsupported statement " + kind)

    run_stmt(body, env, local_types)
    new_length = collection.fields["length"]
    need(isinstance(new_length, CInt),
         "commit: collection length update missing")
    j = z3.BitVec("commit_observe_byte_index", 64)
    actual_byte = data.read(j, arrays)
    record_start_bv = contract_record_start_bv
    record_count_bv = contract_record_count_bv
    record_end_bv = record_start_bv + record_count_bv
    commit_contract = collection_contracts.instantiate("commit", {
        "byte_index": j, "record_start": record_start_bv,
        "record_count": record_count_bv, "data_size": data_size_bv,
        "next_length": next_bv, "new_length": new_length.term, "post_data_byte": actual_byte,
        "old_data": arrays["data"], "encoded": arrays["encoded"],
        "header": arrays["header"], "state_key": arrays["state_key"],
        "start": start_bv, "stride": stride_bv, "written": written,
        "capacity": capacity_bv, "length": length_bv,
        "reserved": reserved_bv, "loaded": loaded_bv,
        "scratch_extent": scratch_bv,
    })
    frame = commit_contract["byteFrame"]
    exact_byte = z3.And(z3.ULT(frame["index"], frame["extent"]),
                        frame["actual"] != frame["expected"])
    span_conditions = []
    no_wrap_conditions = []
    for _label, span_start, span_count, span_extent in span_specs:
        span_end = span_start + span_count
        span_conditions.append(z3.And(span_start >= 0, span_count >= 0, span_end <= span_extent))
        no_wrap_conditions.append(z3.And(span_start >= 0, span_count >= 0,
                                         span_end < (1 << 64)))
    input_mapping_specs = [
        ("size", data_size_bv, size_i, [0 <= size_i, size_i < 1 << 64]),
        ("length", length_bv, length_i, [0 <= length_i, length_i < 1 << 32]),
        ("capacity", capacity_bv, capacity_i, [0 <= capacity_i, capacity_i < 1 << 32]),
        ("stride", stride_bv, stride_i, [0 <= stride_i, stride_i < 1 << 32]),
        ("start", start_bv, start_i, [0 <= start_i, start_i < 1 << 32, start_i <= length_i,
            0 <= length_i, length_i < 1 << 32]),
        ("reserved", reserved_bv, reserved_i, [0 <= reserved_i, reserved_i < 1 << 32,
            reserved_i <= capacity_i - start_i, 0 <= start_i,
            0 <= capacity_i, capacity_i < 1 << 32]),
        ("loaded", loaded_bv, loaded_i, [0 <= loaded_i, loaded_i < 1 << 32,
            0 <= start_i, start_i <= length_i,
            0 <= reserved_i, reserved_i <= capacity_i - start_i,
            loaded_i == min_integer(length_i - start_i, reserved_i),
            0 <= capacity_i, capacity_i < 1 << 32]),
        ("written", written, written_i, [0 <= written_i, written_i < 1 << 32]),
        ("next length", next_bv, next_i, [0 <= next_i, next_i < 1 << 32]),
        ("scratch extent", scratch_bv, scratch_i, [0 <= scratch_i, scratch_i < 1 << 64]),
    ]
    correspondence_applications = [
        {"name": f"commit {name} input matches its C bitvector", "width": term.size()}
        for name, term, _integer, _assumptions in input_mapping_specs]
    input_c_mappings = [z3.BV2Int(term) == integer
        for _name, term, integer, _assumptions in input_mapping_specs]
    contract_environment = {
        "byte_index": j, "data_size": data_size_bv, "next_length": next_bv,
        "new_length": new_length.term, "post_data_byte": actual_byte,
        "old_data": arrays["data"], "encoded": arrays["encoded"],
        "header": arrays["header"], "state_key": arrays["state_key"],
        "start": start_bv, "stride": stride_bv, "written": written,
        "capacity": capacity_bv, "length": length_bv, "reserved": reserved_bv,
        "loaded": loaded_bv, "scratch_extent": scratch_bv,
    }
    # Do not recast helper conclusions as convenient symbolic caller facts.
    # The exact AST clause and its proof source travel together in the shared
    # contract document. The fresh composition parent validates every named
    # helper claim against the same-run body receipts and proves the caller's
    # accepted-plan/scratch links itself.
    contract_precondition_imports = []
    if focus_claim is None:
        bindings = commit_contract_doc["preconditionImports"]
        parts = commit_contract_doc["precondition"]["args"]
        need(len(bindings) == len(parts),
             "commit shared contract import inventory does not cover every precondition clause")
        for part, binding in zip(parts, bindings):
            contract_precondition_imports.append({
                "contractFormula": part,
                "source": binding["source"],
                "sourceClaims": binding["claims"],
                "disposition": "CHECKED_BY_FRESH_COMPOSITION_PARENT",
            })
        # The lifecycle's local open body result is already available; verify
        # its referenced imports here too. Runtime and caller references are
        # verified by the parent against this run's child receipts.
        if open_claims is not None:
            local_open_names = {claim["name"] for claim in open_claims.values()
                                if claim.get("result") == "unsat"}
            for item in contract_precondition_imports:
                if item["source"] == "open":
                    need(set(item["sourceClaims"]) <= local_open_names,
                         "commit shared precondition references an unchecked open-body claim")
    commit_witness_facts: list[z3.BoolRef] = []
    if witness_inputs is not None:
        mapping_by_name = {name: (term, integer)
            for name, term, integer, _assumptions in input_mapping_specs}
        need(set(witness_inputs) == set(mapping_by_name),
             "commit witness: every modeled C input must have an explicit value")
        for name, value in witness_inputs.items():
            term, integer = mapping_by_name[name]
            commit_witness_facts.extend([term == bv(value, term.size()), integer == value])
    # Counted copies and fixed helper writes are covered by their separate
    # pointwise index, loop summary, and summarized span theorems.  Pointer
    # aliases are checked when declared.  Any other interpreted memory access
    # (for example, a read embedded in a write_le value) gets its own SMT query.
    summary_access_labels = {
        "commit destination subscript pointer formation",
        "commit destination byte write",
        "commit source subscript pointer formation",
        "commit source byte read",
        "write_le byte write pointer formation",
        "write_le byte write",
    }
    direct_accesses = [(path, fact, label) for index, (path, fact, label)
        in enumerate(sem.read_obligations)
        if label not in summary_access_labels and index not in verified_pointer_obligations]
    direct_access_results = []
    if focus_claim == "commit byte reads and intermediate pointer formations stay within caller objects":
        need(bool(direct_accesses),
             "commit focused analysis: requested direct byte-read obligation is absent")
        access_assumptions = [*caller_facts, *input_c_mappings, *commit_witness_facts]
        for path, fact, label in direct_accesses:
            direct_access_results.append({"name": focus_claim, **solver_result(
                access_assumptions, z3.And(path, z3.Not(fact)))})
        return {"claims": direct_access_results,
            "correspondenceApplications": [],
            "directAccessObligations": len(direct_accesses),
            "pointerFormationObligations": sum("pointer formation" in label
                for _path, _fact, label in sem.read_obligations),
            "byteAccessObligations": sum("pointer formation" not in label
                for _path, _fact, label in sem.read_obligations)}

    memory_model_facts = [*span_conditions, *no_wrap_conditions, *loop_layout, *loop_termination]

    if focus_claim is not None:
        focused_result: dict[str, Any] | None = None
        if focus_claim == "commit exact header/length/key/window bytes and unchanged outside":
            focused_result = solver_result([*caller_facts, *memory_model_facts], exact_byte)
        elif focus_claim == "commit writes the planned logical length":
            focused_result = solver_result([], new_length.term != next_bv)
        elif focus_claim == "commit record range stays disjoint from header":
            focused_result = solver_result(caller_facts,
                z3.And(record_start_i < 56, record_end_i > 0))
        elif focus_claim == "commit parsed pointer formations and byte spans match bounded object ranges":
            bound_results = [solver_result(caller_facts, z3.Not(fact)) for fact in span_conditions]
            focused_result = next((result for result in bound_results if result["result"] != "unsat"),
                                  {"result": "unsat", "counterexample": None})
        elif focus_claim == "commit C-width count, stride and address calculations do not wrap":
            focused_result = solver_result(caller_facts,
                z3.Or(*[z3.Not(fact) for fact in no_wrap_conditions]))
        elif focus_claim == "commit actual C subscripts match summarized copy addresses":
            focused_result = solver_result([*index_input_facts, *input_c_mappings,
                                            *commit_witness_facts, *loop_termination],
                z3.Or(*[z3.And(guard, z3.Not(fact)) for guard, fact in loop_index_semantics]))
        elif focus_claim == "commit copy summaries match C address/count values and terminate":
            summary_results = [solver_result([*caller_facts, *input_c_mappings,
                                               *commit_witness_facts], z3.Not(fact))
                for fact in [*loop_layout, *loop_termination]]
            focused_result = next((result for result in summary_results if result["result"] != "unsat"),
                                  {"result": "unsat", "counterexample": None})
        elif focus_claim.startswith("commit ") and focus_claim.endswith(" input matches its C bitvector"):
            input_name = focus_claim[len("commit "):-len(" input matches its C bitvector")]
            mapping = next((spec for spec in input_mapping_specs if spec[0] == input_name), None)
            need(mapping is not None, "commit focused analysis: unknown input mapping claim")
            _name, term, integer, assumptions = mapping
            focused_result = unsigned_input_mapping(term, integer, assumptions)
        else:
            raise Grammar("commit focused analysis: unsupported claim " + focus_claim)
        return {"claims": [{"name": focus_claim, **focused_result}],
            "correspondenceApplications": [application for application in correspondence_applications
                if application["name"] == focus_claim],
            "directAccessObligations": len(direct_accesses),
            "pointerFormationObligations": sum("pointer formation" in label
                for _path, _fact, label in sem.read_obligations),
            "byteAccessObligations": sum("pointer formation" not in label
                for _path, _fact, label in sem.read_obligations)}

    bound_results = [solver_result(caller_facts, z3.Not(fact)) for fact in span_conditions]
    bounds = next((result for result in bound_results if result["result"] != "unsat"),
                  {"result": "unsat", "counterexample": None})
    input_mapping_claims = [{"name": f"commit {name} input matches its C bitvector",
        **unsigned_input_mapping(term, integer, assumptions)}
        for name, term, integer, assumptions in input_mapping_specs]
    arithmetic = solver_result(caller_facts,
        z3.Or(*[z3.Not(fact) for fact in no_wrap_conditions]))
    summary_results = []
    for index, fact in enumerate(loop_layout):
        if os.environ.get("COLLECTION_LIFECYCLE_DEBUG"):
            print("commit loop layout", index, len(fact.sexpr()), flush=True)
        summary_results.append(solver_result(caller_facts, z3.Not(fact)))
    for index, fact in enumerate(loop_termination):
        if os.environ.get("COLLECTION_LIFECYCLE_DEBUG"):
            print("commit loop termination", index, len(fact.sexpr()), flush=True)
        summary_results.append(solver_result(caller_facts, z3.Not(fact)))
    copy_summaries = next((result for result in summary_results if result["result"] != "unsat"),
                          {"result": "unsat", "counterexample": None})
    index_equivalence = solver_result([*index_input_facts, *loop_termination],
        z3.Or(*[z3.And(guard, z3.Not(fact)) for guard, fact in loop_index_semantics]))
    written_exact = solver_result([*caller_facts, *memory_model_facts], exact_byte)
    length_exact = solver_result([], z3.Not(commit_contract["lengthPost"]))
    record_disjoint = solver_result(caller_facts,
        z3.And(record_start_i < 56, record_end_i > 0))
    claims = [*input_mapping_claims,
        {"name": "commit exact header/length/key/window bytes and unchanged outside", **written_exact},
        {"name": "commit writes the planned logical length", **length_exact},
        {"name": "commit record range stays disjoint from header", **record_disjoint},
        {"name": "commit parsed pointer formations and byte spans match bounded object ranges", **bounds},
        {"name": "commit C-width count, stride and address calculations do not wrap", **arithmetic},
        {"name": "commit actual C subscripts match summarized copy addresses", **index_equivalence},
        {"name": "commit copy summaries match C address/count values and terminate", **copy_summaries},
    ]
    # Direct scalar/helper reads are not covered by a counted-copy summary;
    # prove each one independently. Summary-covered loop and fixed-write
    # accesses remain discharged by the span/index claims above.
    for path, fact, _label in direct_accesses:
        direct_access_results.append({"name":
            "commit byte reads and intermediate pointer formations stay within caller objects",
            **solver_result([*caller_facts, *input_c_mappings], z3.And(path, z3.Not(fact)))})
    if direct_access_results:
        claims.extend(direct_access_results)
    if sem.ub_obligations:
        ub_safety = solver_result(caller_facts,
            z3.Or(*[z3.And(path, z3.Not(safe)) for path, safe, _label in sem.ub_obligations]))
        claims.append({"name": "commit evaluated signed arithmetic and shifts avoid C undefined behavior",
                       **ub_safety})
    return {"claims": claims, "correspondenceApplications": correspondence_applications,
        "contractPreconditionImports": contract_precondition_imports,
        "copyLoops": sum(1 for update in data.updates if update.source is not None),
        "writeOperations": len(data.updates),
        "summarySpanObligations": len(span_conditions),
        "addressObligations": len(no_wrap_conditions),
        "pointerFormationObligations": sum("pointer formation" in label
            for _path, _fact, label in sem.read_obligations),
        "byteAccessObligations": sum("pointer formation" not in label
            for _path, _fact, label in sem.read_obligations),
        "directAccessObligations": len(direct_accesses),
        "indexEquivalenceObligations": len(loop_index_semantics),
        "localTypes": dict(local_types), "localConversions": local_conversions,
        "grammarRestrictions": [
            "copy loops require zero-based unit-increment induction < invariant-bound guards",
            "indexed writes target only collection data; source and destination indices are base + induction",
            "write_le accepts only the reviewed collection-data destination and four-byte use",
            "commit pointer, count, induction and byte memory semantics use C bitvectors; external integer input labels are separately proved equal to the corresponding unsigned bitvector inputs",
            "pointer variables are direct aliases or use one constant in-object base offset proved against the actual bitvector extent; variable-index addresses map pointwise to their parsed C subscript and exact loop span, and write_le maps to its fixed four-byte target span",
            "each admitted counted copy proves that its parsed C subscript equals the widened base-plus-induction address on every executed iteration",
            "each admitted counted copy is bounded and nonwrapping at both objects using the actual u64 pointer, count and extent values",
            "non-summary scalar/helper byte reads are separately SMT-checked; counted-copy and fixed-write accesses use their summarized span theorems",
            "const scalar and const-derived pointer writes reject before symbolic analysis",
            "local declarations and assignments use parsed declared C types and conversions",
        ], "_body": body}

def replace_once(text: str, old: str, new: str, name: str) -> str:
    need(text.count(old) == 1, f"mutation setup: {name} expected one target")
    return text.replace(old, new, 1)


def insert_once(text: str, anchor: str, insertion: str, name: str) -> str:
    need(text.count(anchor) == 1, f"mutation setup: {name} expected one insertion point")
    return text.replace(anchor, anchor + insertion, 1)


def proof_failures(runtime: str, min_runtime: str,
                   worker_case: tuple[str, int] | None = None) -> dict[str, Any]:
    cases: list[dict[str, Any]] = [
        {"name": "open wrong owner key", "old": "equal_key(a->owner, program)",
         "new": "equal_key(a->owner, state_key)", "target": "open", "expected": "semantic"},
        {"name": "open omits writable validation", "old": "  if (!a->writable) return 5;\n",
         "new": "", "target": "open", "expected": "semantic",
         "focus_witness": {"expected_code": 5, "size": 64, "data_size": 64, "stride": 8,
            "initialize": 0, "writable": 0, "signer": 1, "executable": 0, "stored_length": 0}},
        {"name": "open omits initialization signer", "old": "    if (!a->signer) return 7;\n",
         "new": "", "target": "open", "expected": "semantic",
         "focus_witness": {"expected_code": 7, "size": 64, "data_size": 64, "stride": 8,
            "initialize": 1, "writable": 1, "signer": 0, "executable": 0, "stored_length": 0}},
        {"name": "open omits initialization zero scan",
         "old": "    for (u64 i = 0; i < a->size; ++i) if (a->data[i]) return 4;\n",
         "new": "", "target": "open", "expected": "semantic"},
        {"name": "open header range is short",
         "old": "for (unsigned i = 0; i < 20; ++i) if (a->data[i] != header[i]) return 4;",
         "new": "for (unsigned i = 0; i < 19; ++i) if (a->data[i] != header[i]) return 4;",
         "target": "open", "expected": "semantic"},
        {"name": "open uses wrong stored key offset", "old": "a->data + 24, state_key",
         "new": "a->data + 23, state_key", "target": "open", "expected": "semantic"},
        {"name": "open uses wrong length offset", "old": "a->data + 20, 4",
         "new": "a->data + 21, 4", "target": "open", "expected": "semantic",
         "focus_witness": {"expected_code": 0, "size": 64, "data_size": 64, "stride": 4,
            "initialize": 0, "writable": 1, "signer": 1, "executable": 0, "stored_length": 1},
         "focus_output_field": "length"},
        {"name": "open omits stored length capacity bound",
         "old": "    if (length > capacity) return 4;\n", "new": "", "target": "open", "expected": "semantic",
         "focus_witness": {"expected_code": 4, "size": 64, "data_size": 64, "stride": 8,
            "initialize": 0, "writable": 1, "signer": 1, "executable": 0, "stored_length": 2}},
        {"name": "open weakens payload divisibility", "old": "payload % stride || ",
         "new": "", "target": "open", "expected": "semantic"},
        {"name": "open capacity u32 ceiling is too small", "old": "payload / stride > 0xffffffffULL",
         "new": "payload / stride > 0xfffffffeULL", "target": "open", "expected": "semantic",
         "focus_witness": {"expected_code": 0, "size": 4294967351, "data_size": 4294967351,
            "stride": 1, "initialize": 0, "writable": 1, "signer": 1,
            "executable": 0, "stored_length": 0}},
        {"name": "record accepts local equal to loaded", "old": "local >= w->loaded",
         "new": "local > w->loaded", "target": "record", "expected": "semantic",
         "focus": "record exact null/non-null guard",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "local": 1}},
        {"name": "record header offset is short",
         "old": "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "new": "return c->account->data + (BEND_COLLECTION_HEADER - 1u) + (u64)(w->start + local) * c->stride;",
         "target": "record", "expected": "semantic",
         "focus": "record address is exact 56 + (start + local) * stride",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "local": 0}},
        {"name": "record scales local but not start", "old": "(u64)(w->start + local) * c->stride",
         "new": "((u64)w->start + (u64)local * c->stride)", "target": "record", "expected": "semantic",
         "focus": "record address is exact 56 + (start + local) * stride",
         "witness_inputs": {"size": 80, "length": 3, "capacity": 3, "stride": 8,
            "start": 1, "reserved": 2, "loaded": 2, "local": 1}},
        {"name": "record unsigned unary minus changes address", "old": "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "new": "return c->account->data + BEND_COLLECTION_HEADER + (0ull - (u64)(-(w->start + local))) * c->stride;",
         "target": "record", "expected": "semantic",
         "focus": "record address is exact 56 + (start + local) * stride",
         "witness_inputs": {"size": 72, "length": 2, "capacity": 2, "stride": 8,
            "start": 0, "reserved": 2, "loaded": 2, "local": 1}},
        {"name": "record signed division truncates toward zero",
         "old": "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "new": "return c->account->data + (BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride + (u64)(((int)0 - 7) / 2 + 4));",
         "target": "record", "expected": "semantic",
         "focus": "record address is exact 56 + (start + local) * stride",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "local": 0}},
        {"name": "record proves every evaluated byte read in bounds",
         "old": "if (local >= w->loaded) return (const u8 *)0;",
         "new": "if (local >= w->loaded || (c->account->data[c->account->size + 4096] & 0)) return (const u8 *)0;",
         "target": "record", "expected": "semantic",
         "focus": "record intermediate pointer formations and evaluated byte reads stay within caller-provided objects",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "local": 0}},
        {"name": "commit omits collection header from range",
         "old": "BEND_COLLECTION_HEADER + (u64)w->start * c->stride",
         "new": "(u64)w->start * c->stride", "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 1, "scratch extent": 8}},
        {"name": "commit writes only half the planned record bytes",
         "old": "i < (u64)written * c->stride", "new": "i < ((u64)written * c->stride) / 2",
         "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 1, "scratch extent": 8}},
        {"name": "commit short header write", "old": "i < 20; ++i) data[i] = header[i]",
         "new": "i < 19; ++i) data[i] = header[i]", "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 1, "scratch extent": 8}},
        {"name": "commit writes length at wrong offset", "old": "write_le(data + 20, next_length, 4)",
         "new": "write_le(data + 21, next_length, 4)", "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 1, "scratch extent": 8}},
        {"name": "commit writes state key at wrong offset", "old": "data[24 + i] = state_key[i]",
         "new": "data[23 + i] = state_key[i]", "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 1, "scratch extent": 8}},
        {"name": "commit records old length", "old": "c->length = next_length",
         "new": "c->length = written", "target": "commit", "expected": "semantic",
         "focus": "commit writes the planned logical length"},
        {"name": "commit narrows declared u64 offset to u32 at initialization",
         "old": "u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;",
         "new": "u32 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;",
         "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 4294967304, "length": 536870906, "capacity": 536870906,
            "stride": 8, "start": 536870905, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 536870906, "scratch extent": 8}},
        {"name": "commit narrows declared u64 offset to u32 on assignment",
         "old": "  for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];",
         "new": "  offset = (u32)offset;\n  for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];",
         "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 4294967304, "length": 536870906, "capacity": 536870906,
            "stride": 8, "start": 536870905, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 536870906, "scratch extent": 8}},
        {"name": "commit u32 base plus induction wraps the actual C subscript",
         "old": "u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;\n  for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];",
         "new": "u32 offset = (u32)(BEND_COLLECTION_HEADER + (u64)w->start * c->stride);\n  for (unsigned i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];",
         "target": "commit", "expected": "semantic",
         "focus": "commit actual C subscripts match summarized copy addresses",
         "witness_inputs": {"size": 8589934646, "length": 4294967295, "capacity": 4294967295,
            "stride": 2, "start": 2147483600, "reserved": 24, "loaded": 24, "written": 24,
            "next length": 4294967295, "scratch extent": 48}},
        {"name": "commit unsigned unary minus wraps its offset",
         "old": "u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;",
         "new": "u64 offset = BEND_COLLECTION_HEADER + (0ull - (u64)(-w->start)) * c->stride;",
         "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 72, "length": 2, "capacity": 2, "stride": 8,
            "start": 1, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 2, "scratch extent": 8}},
        {"name": "commit unsigned intermediate offset wraps before pointer use",
         "old": "u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;",
         "new": "u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;\n  offset = (offset - (u64)(u32)offset) + (0ull - (u64)(-(u32)offset));",
         "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 4294967312, "length": 536870907, "capacity": 536870907,
            "stride": 8, "start": 536870906, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 536870907, "scratch extent": 8}},
        {"name": "commit unsigned unary minus wraps its count",
         "old": "for (u64 i = 0; i < (u64)written * c->stride; ++i)",
         "new": "for (u64 i = 0; i < (0ull - (u64)(-written)) * c->stride; ++i)",
         "target": "commit", "expected": "semantic",
         "focus": "commit copy summaries match C address/count values and terminate",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 1, "scratch extent": 8}},
        {"name": "commit rejects out-of-bounds read in write_le value",
         "old": "write_le(data + 20, next_length, 4);",
         "new": "write_le(data + 20, next_length + (u32)(encoded[18446744073709551615ull] * 0ull), 4);",
         "target": "commit", "expected": "semantic",
         "focus": "commit byte reads and intermediate pointer formations stay within caller objects",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 1, "scratch extent": 8}},
        {"name": "commit rejects wrapped intermediate read_le pointer",
         "old": "write_le(data + 20, next_length, 4);",
         "new": "write_le(data + 20, next_length + (u32)(read_le(data + (0ull - 56ull) + 112ull, 4) * 0ull), 4);",
         "target": "commit", "expected": "semantic",
         "focus": "commit byte reads and intermediate pointer formations stay within caller objects",
         "witness_inputs": {"size": 64, "length": 1, "capacity": 1, "stride": 8,
            "start": 0, "reserved": 1, "loaded": 1, "written": 1,
            "next length": 1, "scratch extent": 8}},
        {"name": "record rejects compensated out-of-object pointer formation",
         "old": "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "new": "return c->account->data - 56 + 112 + (u64)(w->start + local) * c->stride;",
         "target": "record", "expected": "grammar"},
        {"name": "commit rejects compensated pointer-derived base",
         "old": "u8 *data = c->account->data;\n  u64 offset = BEND_COLLECTION_HEADER + (u64)w->start * c->stride;",
         "new": "u8 *data = c->account->data - 56;\n  u64 offset = 112 + (u64)w->start * c->stride;",
         "target": "commit", "expected": "grammar"},
        {"name": "commit rejects computed pointer base outside object",
         "old": "u8 *data = c->account->data;",
         "new": "u8 *data = c->account->data + (0ull - 56ull);",
         "target": "commit", "expected": "grammar"},
        {"name": "commit rejects out-of-bounds read in copied index base",
         "old": "for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];",
         "new": "for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[(encoded[18446744073709551615ull] * 0ull) + i];",
         "target": "commit", "expected": "grammar"},
        {"name": "open signed addition overflow is rejected",
         "old": "  if (!a->writable) return 5;\n",
         "new": "  if (!a->writable || 2147483647 + 1 < 0) return 5;\n",
         "target": "open", "expected": "undefined_behavior"},
        {"name": "open out-of-range shift count is rejected",
         "old": "  if (!a->writable) return 5;\n",
         "new": "  if (!a->writable || (1 << 32)) return 5;\n",
         "target": "open", "expected": "undefined_behavior"},
        {"name": "open negative signed left shift is rejected",
         "old": "  if (!a->writable) return 5;\n",
         "new": "  if (!a->writable || ((-1) << 1)) return 5;\n",
         "target": "open", "expected": "undefined_behavior"},
        {"name": "record rejects unsigned octal integer literal",
         "old": "  if (local >= w->loaded) return (const u8 *)0;\n",
         "new": "  if (local >= w->loaded) return (const u8 *)0;\n"
                "  local = local + (10u - 010u);\n",
         "target": "record", "expected": "grammar"},
        {"name": "commit rejects signed octal integer literal",
         "old": "  c->length = next_length;",
         "new": "  c->length = next_length + (u32)(10 - 010);",
         "target": "commit", "expected": "grammar"},
    ]
    account_anchor = "    BendCollection *out) {\n"
    for field, value in (("signer", "1"), ("writable", "1"), ("owner", "program")):
        cases.append({
            "name": f"open rejects Account {field} field mutation",
            "insert": (account_anchor, f"  a->{field} = {value};\n"),
            "target": "open", "expected": "grammar",
        })
    cases.append({
        "name": "open rejects account-data byte mutation",
        "insert": (account_anchor, "  a->data[1] = 1;\n"),
        "target": "open", "expected": "grammar",
    })
    cases.append({
        "name": "open rejects loop-induction mutation that skips alternate header bytes",
        "old": "for (unsigned i = 0; i < 20; ++i) if (a->data[i] != header[i]) return 4;",
        "new": "for (unsigned i = 0; i < 20; ++i) if (a->data[i] != header[i]) return 4; else i = i + 1;",
        "target": "open", "expected": "grammar",
    })
    cases.append({
        "name": "open rejects braced loop-induction mutation",
        "old": "for (u64 i = 0; i < a->size; ++i) if (a->data[i]) return 4;",
        "new": "for (u64 i = 0; i < a->size; ++i) { if (a->data[i]) return 4; i = i - 1; }",
        "target": "open", "expected": "grammar",
    })
    cases.append({
        "name": "open rejects nonmonotonic i!=100 loop guard",
        "old": "for (u64 i = 0; i < a->size; ++i) if (a->data[i]) return 4;",
        "new": "for (u64 i = 0; i != 100; ++i) if (a->data[i]) return 4;",
        "target": "open", "expected": "grammar",
    })
    cases.append({
        "name": "open rejects memory-derived loop bound",
        "old": "for (u64 i = 0; i < a->size; ++i) if (a->data[i]) return 4;",
        "new": "for (u64 i = 0; i < a->data[0]; ++i) if (a->data[i]) return 4;",
        "target": "open", "expected": "grammar",
    })
    cases.append({
        "name": "commit rejects const-derived collection-data write",
        "old": "u8 *data = c->account->data;",
        "new": "const u8 *data = c->account->data;",
        "target": "commit", "expected": "grammar",
    })
    cases.append({
        "name": "commit rejects mutable alias of const-derived pointer",
        "old": "u8 *data = c->account->data;",
        "new": "const u8 *ro = c->account->data;\n  u8 *data = ro;",
        "target": "commit", "expected": "grammar",
    })
    original_ast = {
        "open": lambda text: open_analysis(text, False),
        "record": record_analysis,
        "commit": commit_analysis,
    }
    def isolated_result(kind: str, index: int, name: str) -> dict[str, Any]:
        environment = {key: value for key, value in os.environ.items()
                       if key != "COLLECTION_LIFECYCLE_DEBUG"}
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        try:
            completed = subprocess.run([sys.executable, str(CHECKER),
                "--isolated-probe", kind, str(index)], cwd=ROOT,
                env=environment, text=True, capture_output=True, timeout=75)
        except subprocess.TimeoutExpired as exc:
            return {"name": name, "kind": "failed", "reason":
                f"isolated {kind} process timeout after 75 seconds; stdout={exc.stdout!r}; stderr={exc.stderr!r}"}
        if completed.returncode != 0:
            return {"name": name, "kind": "failed", "reason":
                f"isolated {kind} process exited {completed.returncode}; stdout={completed.stdout[-2048:]!r}; stderr={completed.stderr[-2048:]!r}"}
        try:
            result = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            return {"name": name, "kind": "failed", "reason":
                f"isolated {kind} process returned invalid JSON: {exc}; stdout={completed.stdout[-2048:]!r}"}
        if not isinstance(result, dict) or result.get("name") != name:
            return {"name": name, "kind": "failed", "reason":
                f"isolated {kind} result name or shape mismatch: {result!r}"}
        return result

    mutations: list[dict[str, Any]] = []
    if worker_case is None:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            mutations = list(pool.map(lambda item: isolated_result(
                "mutation", item[0], item[1]["name"]), enumerate(cases)))
    elif worker_case[0] == "mutation":
        need(0 <= worker_case[1] < len(cases), "isolated mutation index out of range")
        case = cases[worker_case[1]]
        name, target, expected = case["name"], case["target"], case["expected"]
        try:
            if "insert" in case:
                anchor, insertion = case["insert"]
                mutant = insert_once(runtime, anchor, insertion, name)
            else:
                mutant = replace_once(runtime, case["old"], case["new"], name)
            if target == "record" and case.get("focus"):
                result = record_analysis(mutant, case["focus"], case.get("witness_inputs"))
            elif target == "commit" and case.get("focus"):
                result = commit_analysis(mutant, case["focus"], case.get("witness_inputs"))
            elif target == "open" and case.get("focus_witness"):
                result = open_analysis(mutant, False, case["focus_witness"],
                    focus_output_field=case.get("focus_output_field"))
            elif target == "open" and expected == "undefined_behavior":
                result = open_analysis(mutant, False, focused_ub=True)
            else:
                result = original_ast[target](mutant)
            ub_claim = next((claim for claim in result["claims"] if
                             "undefined behavior" in claim["name"] and claim["result"] == "sat"), None)
            bad_claim = next((claim for claim in result["claims"] if claim["result"] == "sat"), None)
            if expected == "grammar":
                mutations.append({"name": name, "kind": "failed", "reason": "input unexpectedly entered the semantic model"})
            elif expected == "undefined_behavior" and ub_claim is not None:
                mutations.append({"name": name, "kind": "undefined_behavior", "obligation": ub_claim["name"],
                                  "counterexample": {"solver": "sat", "input": ub_claim["counterexample"]}})
            elif expected == "semantic" and bad_claim is not None and ub_claim is None:
                mutations.append({"name": name, "kind": "semantic", "obligation": bad_claim["name"],
                                  "counterexample": {"solver": "sat", "input": bad_claim["counterexample"]}})
            else:
                mutations.append({"name": name, "kind": "survived" if bad_claim is None else "wrong-rejection",
                                  "expected": expected,
                                  "obligation": bad_claim["name"] if bad_claim else None})
        except Grammar as exc:
            mutations.append({"name": name, "kind": "grammar" if expected == "grammar" else "wrong-rejection",
                              "expected": expected, "reason": str(exc)})
        except (AssertionError, RuntimeError, z3.Z3Exception) as exc:
            mutations.append({"name": name, "kind": "failed", "expected": expected,
                              "reason": f"{type(exc).__name__}: {str(exc)[:2048]}"})
        return {"worker": mutations[0]}

    equivalents = [
        ("open owner/executable check order", "if (!equal_key(a->owner, program) || a->executable)",
         "if (a->executable || !equal_key(a->owner, program))", open_analysis),
        ("record split u32 sum cast", "(u64)(w->start + local) * c->stride",
         "((u64)(w->start + local)) * (u64)c->stride", record_analysis),
        ("record combine pointer offset into one formation",
         "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "return c->account->data + (BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride);",
         record_analysis),
        ("commit header loop before record loop",
         "  for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];\n  for (unsigned i = 0; i < 20; ++i) data[i] = header[i];",
         "  for (unsigned i = 0; i < 20; ++i) data[i] = header[i];\n  for (u64 i = 0; i < (u64)written * c->stride; ++i) data[offset + i] = encoded[i];",
         commit_analysis),
        ("commit zero-offset pointer alias preserves byte layout",
         "u8 *data = c->account->data;",
         "u8 *data = c->account->data + 0ull;", commit_analysis),
        ("open braced loop body preserves first-false semantics",
         "for (u64 i = 0; i < a->size; ++i) if (a->data[i]) return 4;",
         "for (u64 i = 0; i < a->size; ++i) { if (a->data[i]) return 4; }",
         open_analysis),
        ("open redundant condition parentheses", "if (!a->writable)", "if ((!a->writable))", open_analysis),
        ("record negated strict comparison", "if (local >= w->loaded)", "if (!(local < w->loaded))", record_analysis),
        ("open short-circuit excludes unevaluated signed overflow",
         "if (!a->writable) return 5;",
         "if (!a->writable || (0 && (2147483647 + 1 < 0))) return 5;",
         short_circuit_expression_equivalence),
        ("record unsigned unary negation wraps in C", "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "return c->account->data + (BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride + (u64)((u32)(w->start + local) + (u32)(-(w->start + local))));", record_analysis),
        ("record signed division truncates toward zero", "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "return c->account->data + (BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride + (u64)(((int)0 - 7) / 2 + 3));", record_analysis),
        ("record signed remainder truncates toward zero", "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "return c->account->data + (BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride + (u64)(((int)0 - 7) % 2 + 1));", record_analysis),
        ("record usual conversions widen before addition", "return c->account->data + BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride;",
         "return c->account->data + (BEND_COLLECTION_HEADER + (u64)(w->start + local) * c->stride + ((u64)((u32)0xffffffffu + 1ull) - 0x100000000ull));", record_analysis),
    ]
    record_address_composition = {
        "record size input matches its C bitvector",
        "record length input matches its C bitvector",
        "record capacity input matches its C bitvector",
        "record stride input matches its C bitvector",
        "record start input matches its C bitvector",
        "record reserved input matches its C bitvector",
        "record loaded input matches its C bitvector",
        "record local input matches its C bitvector",
        "record address is exact 56 + (start + local) * stride",
        "record u32 index addition does not wrap",
        "record C-width address arithmetic does not wrap",
        "record returned stride lies within opened allocation",
        "record names a logical active record",
    }
    record_equivalence_claims = {
        "record split u32 sum cast": record_address_composition,
        "record combine pointer offset into one formation": record_address_composition,
        "record negated strict comparison": {"record exact null/non-null guard"},
        "record unsigned unary negation wraps in C": record_address_composition,
        "record signed division truncates toward zero": {
            *record_address_composition,
            "record evaluated signed arithmetic and shifts avoid C undefined behavior",
        },
        "record signed remainder truncates toward zero": {
            *record_address_composition,
            "record evaluated signed arithmetic and shifts avoid C undefined behavior",
        },
        "record usual conversions widen before addition": record_address_composition,
    }
    accepted_equivalents = []
    if worker_case is None:
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            accepted_equivalents = list(pool.map(lambda item: isolated_result(
                "equivalent", item[0], item[1][0]), enumerate(equivalents)))
    elif worker_case[0] == "equivalent":
        need(0 <= worker_case[1] < len(equivalents), "isolated equivalent index out of range")
        name, old, new, prove = equivalents[worker_case[1]]
        try:
            rewritten = replace_once(runtime, old, new, name)
            if name in ("open owner/executable check order", "open redundant condition parentheses"):
                result = open_expression_equivalence(name, rewritten, old, new)
            elif name in record_equivalence_claims:
                result = record_analysis(rewritten, record_equivalence_claims[name])
            else:
                result = prove(rewritten)
            failed = [c["name"] for c in result["claims"] if c["result"] != "unsat"]
            accepted_equivalents.append({"name": name, "result": "unsat" if not failed else "failed", "failed": failed})
        except (Grammar, AssertionError, RuntimeError) as exc:
            accepted_equivalents.append({"name": name, "result": "rejected", "reason": str(exc)})
        return {"worker": accepted_equivalents[0]}
    expected_cases = [{"name": case["name"], "kind": case["expected"]} for case in cases]
    return {"mutations": mutations, "mutationCases": expected_cases, "equivalents": accepted_equivalents}


def run_proof() -> dict[str, Any]:
    runtime = RUNTIME.read_text()
    min_runtime = MIN_RUNTIME.read_text()
    check_source_headers(runtime, min_runtime)
    open_result = open_analysis(runtime)
    record_result = record_analysis(runtime)
    open_claims = {claim["name"]: claim for claim in open_result["claims"]}
    commit_result = commit_analysis(runtime, open_claims=open_claims)
    for section_name, section in (("open", open_result), ("record", record_result),
                                  ("commit", commit_result)):
        need(section["grammarRestrictions"] == EXPECTED_GRAMMAR_RESTRICTIONS[section_name],
             f"{section_name}: exact grammar restriction inventory/content changed")
    probe_result = proof_failures(runtime, min_runtime)
    mutations = probe_result["mutations"]
    equivalents = probe_result["equivalents"]
    expected_cases = probe_result["mutationCases"]
    expected_kinds = {case["name"]: case["kind"] for case in expected_cases}
    rejected_mutants = [m for m in mutations if m["kind"] != expected_kinds.get(m["name"])]
    need([m["name"] for m in mutations] == [case["name"] for case in expected_cases],
         "mutations: exact case names or ordering changed")
    for mutation in mutations:
        if mutation["kind"] in ("semantic", "undefined_behavior"):
            witness = mutation.get("counterexample")
            need(mutation.get("obligation") and isinstance(witness, dict)
                 and witness.get("solver") == "sat"
                 and isinstance(witness.get("input"), dict) and bool(witness["input"]),
                 f"mutations: {mutation['name']} lacks a solver-derived input")
        if "octal integer literal" in mutation["name"]:
            need(mutation["kind"] == "grammar"
                 and "literal: unsupported leading-zero nonhex integer literal" in mutation.get("reason", ""),
                 f"mutations: {mutation['name']} was not rejected by the integer-literal grammar")
    need(not rejected_mutants,
         f"mutations: required semantic, UB and grammar outcomes did not match: {rejected_mutants}")
    rejected_equivalents = [e for e in equivalents if e["result"] != "unsat"]
    need(not rejected_equivalents,
         f"equivalent rewrites: accepted source did not re-prove: {rejected_equivalents}")
    claims = open_result["claims"] + record_result["claims"] + commit_result["claims"]
    need(all(claim["result"] == "unsat" for claim in claims), "proof: non-UNSAT claim")
    generic_regression_names = [
        "open C short-circuit skips undefined arithmetic in an unevaluated operand",
        "open unsigned division/remainder yields exact capacity payload relation",
    ]
    correspondence_applications = (record_result["correspondenceApplications"]
        + commit_result["correspondenceApplications"])
    correspondence_names = {item["name"] for item in correspondence_applications}
    generic_regression_set = set(generic_regression_names)
    runtime_claims = [claim for claim in claims
        if claim["name"] not in correspondence_names | generic_regression_set]
    need(len(runtime_claims) == 23,
         f"proof accounting: expected 23 independent runtime obligations, got {len(runtime_claims)}")
    need(len(correspondence_applications) == 18,
         f"proof accounting: expected 18 cached correspondence applications, got {len(correspondence_applications)}")
    need(set(UNSIGNED_SHADOW_LEMMAS) == {32, 64}
         and UNSIGNED_SHADOW_LEMMA_SOLVER_CALLS == {32: 1, 64: 1}
         and all(item["result"] == "unsat" for item in UNSIGNED_SHADOW_LEMMAS.values()),
         "proof accounting: expected one successful cached 32- and 64-bit correspondence query")
    grammar_restriction_count = sum(len(section["grammarRestrictions"])
        for section in (open_result, record_result, commit_result))
    need(grammar_restriction_count == 18,
         f"proof accounting: expected exactly 18 grammar restrictions, got {grammar_restriction_count}")
    proof_accounting = {
        "claimResultEntries": len(claims),
        "independentRuntimeProofObligations": {
            "count": len(runtime_claims),
            "claims": [claim["name"] for claim in runtime_claims],
        },
        "cachedGenericCorrespondenceLemmas": [
            {"name": "unsigned Int2BV inverse", "width": width,
             "result": UNSIGNED_SHADOW_LEMMAS[width]["result"],
             "solverQueries": UNSIGNED_SHADOW_LEMMA_SOLVER_CALLS[width]}
            for width in (32, 64)
        ],
        "correspondenceApplications": correspondence_applications,
        "genericArithmeticRegressionLemmas": [
            {"name": name, "result": next(claim["result"] for claim in claims
                if claim["name"] == name)}
            for name in generic_regression_names
        ],
        "grammarRestrictions": {
            "count": grammar_restriction_count,
            "sourceShapeOnly": True,
            "scope": "Restrictions are reported in open, record and commit sections; they are parser/source-shape limits, not SMT proof obligations.",
        },
    }
    helper_imports = {
        str(path.relative_to(ROOT)): sha(path.read_bytes())
        for path in (CTYPE_HELPER, CTYPE_HELPER_DEP, ROOT / "verification/collection_contracts.py")
    }
    return {
        "schema": 6,
        "passed": True,
        "z3": z3.get_version_string(),
        "scope": "actual ABI-3 open plus record/commit under explicit select/plan preconditions",
        "compositionRunId": os.environ.get("COLLECTION_COMPOSITION_RUN_ID"),
        "contractInterface": collection_contracts.CONTRACT_DOCUMENT,
        "contractInterfaceHash": collection_contracts.CONTRACT_INTERFACE_HASH,
        "inputs": source_hashes(),
        "helperImports": helper_imports,
        "claimResults": claims,
        "proofAccounting": proof_accounting,
        "open": {k: v for k, v in open_result.items() if not k.startswith("_")},
        "record": {k: v for k, v in record_result.items() if not k.startswith("_")},
        "commit": {k: v for k, v in commit_result.items() if not k.startswith("_")},
        "mutations": mutations,
        "mutationCases": expected_cases,
        "equivalents": equivalents,
        "assumptions": EXPECTED_ASSUMPTIONS,
        "generatedCallerPreconditions": [
            "The loader supplies valid, naturally aligned Account/BendCollection/BendCollectionWindow objects, truthful sizes, readable 32-byte owner/key spans, a readable 20-byte schema header, and a collection data object whose extent is at least Account.size; data/account structs and key/header inputs are disjoint where output or commit writes can reach them.",
            "The caller passes the intended collection Account, this program id, the primary state account key, the exact collection schema header, a nonzero canonical element stride, a normalized initialization flag, and a valid disjoint output object. During initialization the collection account itself must sign; its entire reported allocation must already be zero.",
            "For stored mode, the caller's account selection and loader checks must bind this collection to the same primary state key and expected schema. open independently checks its 20-byte header, 32-byte state key and stored length bounds.",
            "A successful select on this exact BendCollection must establish start<=length, start<=capacity, reserved<=capacity-start, and loaded=min(length-start,reserved); the caller passes the same stable collection/window objects to record and uses local<loaded before decoding the full stride.",
            "Before commit, a successful plan on the same collection/window must establish loaded<=written<=reserved, oldLength<=nextLength<=capacity, written-loaded=nextLength-oldLength, and, when appending, oldLength-start=loaded. This checker assumes those facts and does not prove the live plan implementation.",
            "encoded must point to at least written*stride initialized bytes and be disjoint from the complete collection data object. Header and state-key inputs must each have their required readable extent and must not alias commit destinations; the generated adapter must also keep collection metadata and pointers stable through commit.",
            "Any effects before commit must preserve the collection account data, size, pointers and owner until commit. This slice does not compose the generated CPI/token guards or external program behavior.",
            "Generated caller must separately validate transition tags, window tags/start, canonical element encoders and all effect checks before commit. This receipt does not establish adapter rollback or atomicity.",
        ],
    }


def publish_pending(report: dict[str, Any], before: dict[str, str]) -> None:
    after = source_hashes()
    need(after == before, "source changed during proof; receipt publication refused")
    need(report["inputs"] == before, "receipt inputs differ from pre-proof hashes")
    report["source_hashes_at_end"] = after
    report["source_hashes_at_publication"] = after
    RECEIPT.parent.mkdir(parents=True, exist_ok=True)
    tmp = RECEIPT.with_suffix(RECEIPT.suffix + ".tmp")
    need(not RECEIPT.exists() and not tmp.exists(),
         "pending publication path is occupied; existing receipt bytes are preserved")
    encoded = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    with tmp.open("xb") as handle:
        handle.write(encoded)
        handle.flush()
        os.fsync(handle.fileno())
    # Publish without clobbering a receipt another process may have created
    # after the preflight. Keeping the temporary name until the link succeeds
    # also leaves the exact bytes available if publication fails.
    os.link(tmp, RECEIPT)
    tmp.unlink()
    directory_fd = os.open(RECEIPT.parent, os.O_RDONLY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--negative-probe", action="store_true")
    parser.add_argument("--unknown-probe", action="store_true")
    parser.add_argument("--literal-probe", metavar="TOKEN")
    parser.add_argument("--isolated-probe", nargs=2, metavar=("KIND", "INDEX"))
    args = parser.parse_args()
    # Captured before parsing or solving. The TypeScript parent independently
    # checks the same files before it atomically publishes the final receipt.
    before = source_hashes()
    if args.literal_probe is not None:
        parsed = literal(args.literal_probe)
        print(json.dumps({"token": args.literal_probe, "value": str(parsed.term.as_long()),
            "width": parsed.width, "signed": parsed.signed, "ctype": parsed.c_type}))
        return 0
    if args.unknown_probe:
        raise RuntimeError("UNKNOWN is not a proof (injected driver regression probe)")
    if args.isolated_probe:
        kind, index_text = args.isolated_probe
        need(kind in ("mutation", "equivalent"), "isolated probe: unsupported kind")
        need(index_text.isdigit(), "isolated probe: index must be a nonnegative integer")
        runtime = RUNTIME.read_text()
        min_runtime = MIN_RUNTIME.read_text()
        check_source_headers(runtime, min_runtime)
        result = proof_failures(runtime, min_runtime, (kind, int(index_text)))
        print(json.dumps(result["worker"], sort_keys=True))
        return 0
    if args.negative_probe:
        source = RUNTIME.read_text()
        mutant = replace_once(source,
            "    if (!equal_key(a->data + 24, state_key)) return 4;\n", "", "parent nonzero child probe")
        result = open_analysis(mutant)
        failed = next((claim for claim in result["claims"] if claim["result"] == "sat"), None)
        need(failed is not None and failed.get("counterexample"),
             "negative probe mutant lacked a solver-derived semantic counterexample")
        counterexample = dict(failed["counterexample"])
        counterexample["json_newline_probe"] = "first\nsecond"
        print(json.dumps({"negative": True, "obligation": failed["name"],
                          "counterexample": {"solver": "sat", "input": counterexample}}))
        return 23
    need(z3.get_version_string() == "5.1.0", f"z3: expected 5.1.0, got {z3.get_version_string()}")
    report = run_proof()
    report["inputs"] = before
    report["status"] = "PASS"
    report["source_hash_comparison"] = "MATCH"
    report["source_hashes_at_start"] = before
    publish_pending(report, before)
    print(json.dumps({"passed": True,
        "independentRuntimeProofObligations": report["proofAccounting"]["independentRuntimeProofObligations"]["count"],
        "cachedGenericCorrespondenceLemmas": len(report["proofAccounting"]["cachedGenericCorrespondenceLemmas"]),
        "correspondenceApplications": len(report["proofAccounting"]["correspondenceApplications"]),
        "genericArithmeticRegressionLemmas": len(report["proofAccounting"]["genericArithmeticRegressionLemmas"]),
        "claimResultEntries": report["proofAccounting"]["claimResultEntries"],
        "grammarRestrictionEntries": report["proofAccounting"]["grammarRestrictions"]["count"],
        "mutations": len(report["mutations"]), "equivalents": len(report["equivalents"]),
        "receipt": str(RECEIPT.relative_to(ROOT)), "z3": report["z3"]}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"collection-lifecycle proof rejected: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
