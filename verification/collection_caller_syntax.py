"""Restricted caller syntax and schema validation; no proof claims live here."""
import re
import pathlib
import hashlib
import json

class Grammar(Exception):
    """Input is outside the restricted C grammar or artifact contract."""


class Fatal(Exception):
    """Unknown solver result, stale input or incomplete driver run."""


def need(ok, why):
    if not ok:
        raise Grammar(why)


TOKEN = re.compile(
    r'[ \t\n]+|/\*[\s\S]*?\*/|//[^\n]*|"[^"\n]*"|[A-Za-z_]\w*|'
    r"0[xX][0-9a-fA-F]+[uUlL]*(?![\w.])|[0-9]+[uUlL]*(?![\w.])|"
    r"->|\+\+|--|&&|\|\||<<|>>|<=|>=|==|!=|\+=|-=|"
    r"[{}()\[\];:,.&*+|=<>!?#/%^~\-]"
)


def lex(text, where):
    need(text.isascii() and "\\" not in text and "??" not in text and "\r" not in text and
         not any(d in text for d in ("%:", "<:", ":>", "<%", "%>")),
         f"{where}: unsupported preprocessing characters")
    out, at = [], 0
    while at < len(text):
        match = TOKEN.match(text, at)
        need(match is not None, f"{where}: unsupported token near {text[at:at + 32]!r}")
        token = match.group()
        at = match.end()
        if token[0] in " \t\n" or token.startswith(("/*", "//")):
            continue
        need(token not in ("%:", "<:", ":>", "<%", "%>"), f"{where}: unsupported digraph")
        out.append(token)
    return out


def clean_directives(text, name):
    """Allow only literal include directives in translation units."""
    kept = []
    for line in text.splitlines():
        if "#" not in line:
            kept.append(line)
            continue
        if re.fullmatch(r'\s*#include\s+["<][A-Za-z0-9_.-]+[">]\s*', line):
            continue
        raise Grammar(f"preprocessing: unsupported directive in {name}: {line.strip()[:50]}")
    return "\n".join(kept)


def include_names(text, name):
    clean = re.sub(r'/\*[\s\S]*?\*/|//[^\n]*', "", text)
    found = []
    for line in clean.splitlines():
        if "#" not in line:
            continue
        match = re.fullmatch(r'\s*#include\s+["<]([A-Za-z0-9_.-]+)[">]\s*', line)
        if match:
            found.append(match.group(1)); continue
        need(re.fullmatch(r'\s*#pragma\s+once\s*', line) is not None or
             re.fullmatch(r'\s*#define\s+[A-Za-z_]\w*\s+[0-9]+[uUlL]*\s*', line) is not None,
             f"preprocessing: invalid directive in {name}")
    return found


def include_specs(text, name):
    clean = re.sub(r'/\*[\s\S]*?\*/|//[^\n]*', "", text)
    specs = []
    for line in clean.splitlines():
        if "#" not in line: continue
        match = re.fullmatch(r'\s*#include\s+(["<])([A-Za-z0-9_.-]+)([">])\s*', line)
        if match:
            need((match.group(1), match.group(3)) in (("\"", "\""), ("<", ">")),
                 f"preprocessing: mismatched include delimiter in {name}")
            specs.append((match.group(2), match.group(1)))
    return specs


def matching(tokens, at, left, right):
    need(at < len(tokens) and tokens[at] == left, f"syntax: expected {left}")
    depth = 0
    for i in range(at, len(tokens)):
        if tokens[i] == left:
            depth += 1
        elif tokens[i] == right:
            depth -= 1
            if depth == 0:
                return i
    raise Grammar(f"syntax: unmatched {left}")


def split_top(tokens, separator):
    parts, start, paren, bracket, brace = [], 0, 0, 0, 0
    for i, token in enumerate(tokens):
        if token == separator and paren == bracket == brace == 0:
            parts.append(tokens[start:i]); start = i + 1; continue
        if token == "(": paren += 1
        elif token == ")": paren -= 1
        elif token == "[": bracket += 1
        elif token == "]": bracket -= 1
        elif token == "{": brace += 1
        elif token == "}": brace -= 1
        need(paren >= 0 and bracket >= 0 and brace >= 0, "syntax: unbalanced expression")
    need(paren == bracket == brace == 0, "syntax: unbalanced expression")
    parts.append(tokens[start:])
    return parts


def strip_outer(tokens):
    out = list(tokens)
    while len(out) >= 2 and out[0] == "(" and matching(out, 0, "(", ")") == len(out) - 1:
        out = out[1:-1]
    return out


class Parser:
    def __init__(self, tokens, types):
        self.t, self.at, self.types = tokens, 0, set(types)

    def peek(self, offset=0):
        return self.t[self.at + offset] if self.at + offset < len(self.t) else ""

    def take(self, token):
        need(self.peek() == token, f"syntax: expected {token}, found {self.peek()}")
        self.at += 1

    def raw_until(self, stop):
        start, paren, bracket, brace = self.at, 0, 0, 0
        while self.at < len(self.t):
            token = self.peek()
            if token == stop and paren == bracket == brace == 0:
                out = self.t[start:self.at]; self.at += 1; return out
            if token == "(": paren += 1
            elif token == ")": paren -= 1
            elif token == "[": bracket += 1
            elif token == "]": bracket -= 1
            elif token == "{": brace += 1
            elif token == "}": brace -= 1
            need(paren >= 0 and bracket >= 0 and brace >= 0, "syntax: unbalanced statement")
            self.at += 1
        raise Grammar(f"syntax: missing {stop}")

    def statement(self):
        token = self.peek()
        if token == "{":
            self.take("{"); body = []
            while self.peek() != "}":
                need(self.peek() != "", "syntax: unterminated block")
                body.append(self.statement())
            self.take("}")
            return ("block", body)
        if token == "if":
            self.take("if"); self.take("("); cond = self.raw_until(")")
            yes = self.statement(); no = None
            if self.peek() == "else": self.take("else"); no = self.statement()
            return ("if", cond, yes, no)
        if token == "for":
            self.take("for"); self.take("("); header = self.raw_until(")")
            pieces = split_top(header, ";")
            need(len(pieces) == 3, "syntax: unsupported for header")
            body = self.statement()
            return ("for", pieces[0], pieces[1], pieces[2], body)
        if token == "return":
            self.take("return"); value = self.raw_until(";")
            need(value, "syntax: empty return")
            return ("return", value)
        if token in ("while", "do", "goto", "switch", "break", "continue"):
            raise Grammar(f"syntax: unsupported statement {token}")
        raw = self.raw_until(";")
        need(raw, "syntax: empty statement")
        return ("simple", raw)


def function_body(c_text, name, types):
    code = clean_directives(c_text, "collection-store.c")
    tokens = lex(code, "collection-store.c")
    candidates = []
    for i in range(len(tokens) - 1):
        if tokens[i] != name or tokens[i + 1] != "(":
            continue
        close = matching(tokens, i + 1, "(", ")")
        if close + 1 < len(tokens) and tokens[close + 1] == "{":
            candidates.append((close + 1, matching(tokens, close + 1, "{", "}")))
    need(len(candidates) == 1, f"translation unit: expected one definition of {name}, found {len(candidates)}")
    lo, hi = candidates[0]
    parser = Parser(tokens[lo + 1:hi], types)
    body = []
    while parser.at < len(parser.t):
        body.append(parser.statement())
    return body


def walk(stmts, prefix=()):
    """Yield AST nodes in source order with their syntactic branch guards."""
    for stmt in stmts:
        yield stmt, prefix
        if stmt[0] == "block":
            yield from walk(stmt[1], prefix)
        elif stmt[0] == "if":
            yield from walk([stmt[2]], prefix + ((tuple(stmt[1]), True),))
            if stmt[3] is not None:
                yield from walk([stmt[3]], prefix + ((tuple(stmt[1]), False),))
        elif stmt[0] == "for":
            yield from walk([stmt[4]], prefix + ((tuple(stmt[2]), True),))


def calls(tokens):
    out = []
    for i, token in enumerate(tokens[:-1]):
        if not re.fullmatch(r"[A-Za-z_]\w*", token) or tokens[i + 1] != "(":
            continue
        if token in {"if", "for", "while", "switch", "sizeof", "return"}:
            continue
        end = matching(tokens, i + 1, "(", ")")
        args = [] if end == i + 2 else split_top(tokens[i + 2:end], ",")
        out.append((token, args, i, end + 1))
    return out


def flat_nodes(stmts):
    return [node for node, _ in walk(stmts)]


def root_symbols(schema, interface):
    types = {item["name"]: item for item in schema["types"]}
    exports = [f for f in schema["exports"] if f["name"] == interface["root"]]
    selects = [f for f in schema["exports"] if f["name"] == interface["select"]]
    need(len(exports) == len(selects) == 1, "schema: unique pure transition and selector exports required")
    root, select = exports[0], selects[0]
    need(len(root["args"]) == 5 and select["args"] == root["args"][:4], "schema: invalid selection/transition signatures")
    need(root["args"][1] == interface.get("state") and root["args"][2] == interface.get("instruction"),
         "schema/interface: state or instruction binding")
    need(root["cName"] and select["cName"], "schema: missing generated root symbols")
    state = types.get(interface["state"]); instruction = types.get(interface["instruction"])
    result = types.get(root["result"])
    need(state and state["kind"] == "adt" and instruction and result and result["kind"] == "adt", "schema: missing root types")
    accepted = [v for v in result["variants"] if v["name"].split(".")[-1] == "Accepted"]
    rejected = [v for v in result["variants"] if v["name"].split(".")[-1] == "Rejected"]
    need(len(accepted) == len(rejected) == 1, "schema: expected Accepted/Rejected result")
    accepted, rejected = accepted[0], rejected[0]
    need([f["name"] for f in accepted["fields"]] == ["state", "window", "length"] and
         accepted["fields"][0]["type"] == interface["state"] and
         accepted["fields"][1]["type"] == root["args"][4] and types[accepted["fields"][2]["type"]]["kind"] == "u32",
         "schema: pure Accepted output shape")
    need([f["name"] for f in rejected["fields"]] == ["code"], "schema: Rejected code field")
    need(types[rejected["fields"][0]["type"]]["kind"] == "u32", "schema: Rejected code must be U32")
    def record(name, fields):
        t = types.get(name)
        need(t is not None and t["kind"] == "adt" and len(t["variants"]) == 1 and
             [f["name"] for f in t["variants"][0]["fields"]] == fields,
             f"schema: expected record {name}({','.join(fields)})")
        return t["variants"][0]["fields"]
    def is_u32(name): need(types.get(name, {}).get("kind") == "u32", f"schema: expected U32 field, got {name}")
    context_fields = record(root["args"][0], ["actor", "signed", "slot", "collection"])
    key_fields = record(context_fields[0]["type"], list("abcdefgh"))
    slot_fields = record(context_fields[2]["type"], ["lo", "hi"])
    need(context_fields[1]["type"] in types and types[context_fields[1]["type"]]["kind"] == "bool" and
         context_fields[3]["type"] == context_fields[0]["type"], "schema: context signer/key types")
    for field in key_fields + slot_fields: is_u32(field["type"])
    metadata_fields = record(root["args"][3], ["length", "capacity"])
    for field in metadata_fields: is_u32(field["type"])
    window_fields = record(root["args"][4], ["start", "entries"])
    is_u32(window_fields[0]["type"])
    vector_fields = record(window_fields[1]["type"], ["length", "storage"])
    is_u32(vector_fields[0]["type"])
    pair_fields = record(vector_fields[1]["type"], ["left", "right"])
    need(pair_fields[0]["type"] == pair_fields[1]["type"], "schema: collection pair storage must be homogeneous")
    for field in pair_fields: is_u32(field["type"])
    def wire_size(name, active=()):
        need(name in types and name not in active, f"schema: unknown or recursive type {name}")
        item = types[name]
        if item["kind"] == "u32": return 4
        if item["kind"] == "bool": return 1
        need(item["kind"] == "adt" and item.get("variants"), f"schema: unsupported wire type {name}")
        return 1 + max(sum(wire_size(f["type"], active + (name,)) for f in v["fields"]) for v in item["variants"])
    return {"types": types, "root": root, "select": select, "state": state, "instruction": instruction,
            "accepted": accepted["tag"], "rejected": rejected["tag"], "result": result,
            "args": root["args"], "stateBytes": interface["stateBytes"],
            "stateWireBytes": wire_size(interface["state"]), "instructionWireBytes": wire_size(interface["instruction"]),
            "instructionBytes": interface["instructionBytes"], "element": interface["collection"]["element"],
            "stride": interface["collection"]["stride"], "capacity": interface["collection"]["windowCapacity"],
            "accountIndex": interface["collection"]["accountIndex"], "schema": schema}


def assert_schema(schema, interface):
    m = root_symbols(schema, interface)
    need(interface.get("version") == 3 and interface.get("effects") == "none" and interface.get("effectSlots") == 0,
         "interface: this slice accepts pure ABI 3 only")
    need(interface.get("modes") == {"initialize": 0, "transition": 1}, "interface: mode bytes")
    need(interface.get("accounts") == ["state", "actor", "collection"], "interface: pure ABI 3 account order")
    need(m["accountIndex"] == 2 and interface["collection"].get("headerBytes") == 56 and
         interface["collection"].get("boundStateOffset") == 24 and interface["collection"].get("lengthOffset") == 20,
         "interface: collection layout")
    element = m["types"].get(m["element"])
    need(element and element.get("kind") == "u32" and element.get("cType") == "bend_u32" and m["stride"] == 4,
         "schema: this caller slice expects the emitted U32 collection fixture")
    need(m["capacity"] == 2, "interface: this slice models the two-record emitted fixture")
    need(interface["stateBytes"] > 20 and interface["instructionBytes"] > 1,
         "interface: invalid state/instruction wire sizes")
    need(interface["stateBytes"] == 20 + m["stateWireBytes"], "interface: state allocation and wire payload disagree")
    need(interface["instructionBytes"] == 1 + m["instructionWireBytes"], "interface: instruction wire size disagrees with schema")
    expected_state_header = schema_header(schema, interface["state"], 83)
    expected_collection_header = schema_header(schema, interface["collection"]["element"], 67)
    need(interface["header"] == expected_state_header, "interface: state header does not hash the checked schema")
    need(interface["collection"]["header"] == expected_collection_header,
         "interface: collection header does not hash the element schema")
    return m


def schema_header(schema, root, kind_byte):
    types = {item["name"]: item for item in schema["types"]}
    reachable = {}
    def visit(name):
        need(name in types, f"schema header: unknown type {name}")
        if name in reachable: return
        t = types[name]
        if t["kind"] == "adt":
            reachable[name] = {"name": name, "kind": "adt", "variants": [
                {"name": v["name"], "tag": v["tag"], "fields": v["fields"]} for v in t["variants"]]}
            for variant in t["variants"]:
                for field in variant["fields"]: visit(field["type"])
        else:
            reachable[name] = {"name": name, "kind": t["kind"]}
    visit(root)
    digest = hashlib.sha256(json.dumps(list(reachable.values()), separators=(",", ":"), ensure_ascii=False).encode()).digest()
    return [66, 68, kind_byte, 49, *digest[:16]]


def hash_file(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def validate_input(payload):
    need(payload.get("version") == 1, "driver payload version")
    baseline = pathlib.Path(payload["baselineRoot"]).resolve()
    manifest_path = pathlib.Path(payload["manifestPath"])
    manifest = json.loads(manifest_path.read_text())
    schema = json.loads(pathlib.Path(payload["schemaPath"]).read_text())
    interface = json.loads(pathlib.Path(payload["interfacePath"]).read_text())
    need(manifest.get("source") == "tests/collection-store.bend" and manifest.get("root") == "process" and
         manifest.get("bendCommit") == "7561656155a4285c1e4ccfcb3505ab59524de973", "manifest: wrong generated fixture/pinned Bend")
    c_path = pathlib.Path(payload["adapterPath"])
    artifacts = manifest.get("artifacts", {})
    for suffix, key in ((".c", "adapterPath"), (".h", "headerPath"), (".wire.h", "wirePath"),
                        (".schema.json", "schemaPath"), (".interface.json", "interfacePath")):
        need(suffix in artifacts and hash_file(payload[key]) == artifacts[suffix], f"manifest: generated {suffix} hash mismatch")
    for name, digest in manifest["inputs"].items():
        if name.startswith(".deps/"):
            need(name == ".deps/bend/bend2/base.bend", "manifest: unexpected external Bend input")
            external = payload.get("immutableSources", {}).get(name)
            if external:
                need(hash_file(external) == digest, "manifest: external Bend source hash mismatch")
            else:
                raise Grammar("manifest: immutable Bend source unavailable")
            continue
        source = baseline / name
        need(source.is_file() and hash_file(source) == digest, f"snapshot source hash mismatch: {name}")
    # Verify the direct includes and the full file set supplied by the TS
    # driver. Ambiguous names and unresolved includes fail closed there.
    files = payload["includeFiles"]
    c_text = c_path.read_text()
    need(include_specs(c_text, "collection-store.c") == [("collection-store.wire.h", '"'), ("bend_collection_runtime.h", '"')],
         "include closure: generated C include list")
    # Check actual file bytes before read_text can normalize CR/CRLF endings.
    # These constants are independent of the candidate-generated manifest.
    for name, expected in GENERATED_HEADER_CONTRACT.items():
        need(hash_file(files[name]) == expected,
             'generated-header artifact outside reviewed allowlist: '+name)
    wire_text = pathlib.Path(files["collection-store.wire.h"]).read_text()
    need(include_specs(wire_text, "collection-store.wire.h") == [("collection-store.h", '"')], "include closure: wire header")
    check_generated_header_directives(schema, pathlib.Path(files["collection-store.h"]).read_text(), wire_text)
    rt_text = pathlib.Path(files["bend_collection_runtime.h"]).read_text()
    need(include_specs(rt_text, "bend_collection_runtime.h") == [("solana_min.h", '"')], "include closure: runtime header")
    need(not include_names(pathlib.Path(files["solana_min.h"]).read_text(), "solana_min.h"), "include closure: unexpected runtime include")
    return manifest, schema, interface, c_text, files


def sha_inputs(payload, files):
    out = {}
    for logical, path in sorted(files.items()):
        out[logical] = hash_file(path)
    for key in ("adapterPath", "headerPath", "wirePath", "schemaPath", "interfacePath", "manifestPath"):
        out[f"artifact:{key}"] = hash_file(payload[key])
    for name, path in sorted(payload.get("immutableSources", {}).items()):
        out[name] = hash_file(path)
    for logical, path in sorted(payload.get("checkerFiles", {}).items()):
        out[logical] = hash_file(path)
    return out


# Positive, exact-artifact allowlist for the conditional two-record fixture.
# This is an input restriction, not a proof of codec/root semantics. A new
# compiler output requires a separate review and deliberate pin update. Never
# derive these constants from the candidate manifest being checked.
GENERATED_HEADER_CONTRACT = {
    'collection-store.h': '6712d216dac31c9e70ac1aca98b40b380895acc8196f870d56e464c705f532f6',
    'collection-store.wire.h': 'a01209ca535642ed70f95133f8eead5ddc6915c17d31b5dba3608dda219acfa6',
}


def check_generated_header_directives(schema, header, wire):
    """Require reviewed complete generated headers, including all bodies.

    A directive/token blacklist cannot exclude all C extensions that can bind
    external symbols. The complete artifact must match the positive allowlist.
    Keep schema/directive validation as an additional consistency check.
    """
    for name, text in [('collection-store.h', header), ('collection-store.wire.h', wire)]:
        need(hashlib.sha256(text.encode('utf8')).hexdigest() == GENERATED_HEADER_CONTRACT[name],
             'generated-header artifact outside reviewed allowlist: '+name)
    types = {t['name']:t for t in schema['types']}
    def size(name, active=()):
        need(name in types and name not in active, 'header schema contains unknown/recursive type')
        t=types[name]
        if t['kind']=='u32': return 4
        if t['kind']=='bool': return 1
        need(t['kind']=='adt' and t['variants'], 'unsupported header wire type')
        return 1+max(sum(size(f['type'],active+(name,)) for f in v['fields']) for v in t['variants'])
    macros={}
    for name in types:
        need(name.isascii(), 'non-ASCII schema name outside header contract')
        symbol='bend_'+''.join(c if c.isalnum() else '_'+format(ord(c),'x')+'_' for c in name)
        need(symbol+'_WIRE_SIZE' not in macros, 'duplicate generated wire macro')
        macros[symbol+'_WIRE_SIZE']=str(size(name))+'u'
    for name,text,expected in [('collection-store.h',header,{}),('collection-store.wire.h',wire,macros)]:
        tokens = lex(text,name)  # Reject escapes, line splices, digraphs and trigraphs.
        clean=re.sub(r'/\*[\s\S]*?\*/|//[^\n]*','',text)
        found={}; pragmas=0; includes=[]
        for line in clean.splitlines():
            if '#' not in line: continue
            if re.fullmatch(r'\s*#pragma\s+once\s*',line): pragmas+=1;continue
            if re.fullmatch(r'\s*#include\s+"collection-store.h"\s*',line):includes.append('collection-store.h');continue
            match=re.fullmatch(r'\s*#define\s+([A-Za-z_]\w*)\s+([0-9]+u)\s*',line)
            need(match is not None, 'generated-header preprocessing outside contract: '+name)
            macro,value=match.groups()
            need(macro in expected and macro not in found and value==expected[macro], 'generated-header macro outside schema contract: '+macro)
            found[macro]=value
        need(pragmas==1 and found==expected, 'generated-header pragma/macro inventory mismatch: '+name)
        need(includes==(['collection-store.h'] if name.endswith('.wire.h') else []), 'generated-header include inventory mismatch: '+name)


