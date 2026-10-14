"""Path-sensitive obligations for the emitted pure two-record caller.

This is a restricted symbolic executor, not a general C interpreter. Scalar
inputs have their ABI widths. The collection helpers instantiate the shared
typed contract AST; codec and Bend root results remain explicit abstract inputs.
Unknown syntax rejects.
"""
import re
import z3
import collection_contracts


class PathFailure(Exception):
    def __init__(self, label, model):
        self.label, self.model = label, model
        super().__init__(label)


class Paths:
    def __init__(self, api, model):
        self.api, self.m = api, model
        self.variables, self.inputs, self.events, self.returns = {}, {}, {}, []
        self.pc = z3.BoolVal(True)
        self.constraints = []
        self.contract_links = {}
        self.checks = []
        self.observations = []
        self.observation_terms = []
        self.record_contracts = {}
        self.loop = {}
        # Entry caller supplies exactly three accounts after its checked gate.
        # This assumption must be discharged by the separate entrypoint check.
        self.variables['count'] = self.bv(3)
        if type(self) is Paths:
            # Discharged by EntryPaths: canonical mode is 0/1 and the exact
            # dispatch argument is ix[0]==0. Do not assume this for entry itself.
            self.constraints.append(z3.ULE(self.input('mode', 8), self.bv(1)))
            self.constraints.append(self.input('initialize') ==
                                    z3.If(self.input('mode', 8) == 0, self.bv(1), self.bv(0)))
        if '_interface' in model:
            for i, byte in enumerate(model['_interface']['header']):
                self.constraints.append(self.input(f'header_{i}',8) == byte)

    def bv(self, value):
        return z3.BitVecVal(value, 64)

    def truth(self, value):
        return value if z3.is_bool(value) else value != self.bv(0)

    def number(self, value):
        return z3.If(value, self.bv(1), self.bv(0)) if z3.is_bool(value) else value

    def input(self, name, bits=32):
        if name not in self.inputs:
            raw = z3.BitVec(name, bits)
            self.inputs[name] = raw if bits == 64 else z3.ZeroExt(64-bits, raw)
        return self.inputs[name]

    def event(self, name, pc=None):
        condition = self.pc if pc is None else pc
        previous = self.events.get(name, z3.BoolVal(False))
        # One nondeterministic helper result is sound only for one invocation
        # on a path. This also treats entrypoint dispatch as effectful.
        # Reading ix[0] twice is an ordinary immutable scalar read, not a call.
        if name != 'mode_read':
            self.checks.append(('stage invoked at most once: '+name,
                                z3.Implies(condition, z3.Not(previous))))
        self.events[name] = z3.Or(previous, condition)

    def observe(self, function, args, status=None, pointer_result=None, scalar_bindings=None):
        bindings = scalar_bindings or {}
        self.observations.append({
            "ordinal": len(self.observations),
            "function": function,
            "arguments": ["".join(item) for item in args],
            "statusInput": status,
            "pointerResult": pointer_result,
            "scalarBindings": {str(index): value.sexpr() for index, value in sorted(bindings.items())},
            "pathCondition": self.pc.sexpr(),
        })
        self.observation_terms.append(bindings)

    def u32(self, name):
        # Canonicalize this symbol at its actual source ABI width.  Creating
        # it first as a 64-bit helper-output symbol made later reads of a C
        # u32 field observe unconstrained high bits.
        return z3.Extract(31, 0, self.input(name, 32))

    def contract_link(self, name, formula):
        self.contract_links.setdefault(name, []).append(formula)
        self.constraints.append(formula)

    def _u32_argument(self, tokens):
        value = self.number(self.expr(tokens))
        return z3.Extract(31, 0, value)

    def _record_open_contract(self, args):
        size = self.input('collection_size', 64)
        stride = self._u32_argument(args[4])
        initialize = self.expr(args[5])
        payload = size - self.bv(56)
        stride64 = z3.ZeroExt(32, stride)
        quotient = z3.UDiv(payload, stride64)
        instance = collection_contracts.instantiate('open', {
            'base_valid': z3.And(self.input('collection_owner_equal', 1) != 0,
                                  self.input('collection_executable', 1) == 0),
            'writable': self.input('collection_writable', 1) != 0,
            'positive_stride': stride != z3.BitVecVal(0, 32),
            'minimum_header_size': z3.UGE(size, self.bv(56)),
            'divisible_payload': z3.URem(payload, stride64) == self.bv(0),
            'capacity_fits_u32': z3.ULE(quotient, self.bv(0xffffffff)),
            'initialize': self.truth(initialize),
            'signer': self.input('collection_signer', 1) != 0,
            'allocation_zero': self.input('collection_allocation_zero', 1) != 0,
            'stored_header_matches': self.input('collection_header_matches', 1) != 0,
            'stored_key_matches': self.input('collection_state_key_matches', 1) != 0,
            'stored_length_valid': z3.ULE(self.u32('collection_stored_length'),
                                          z3.Extract(31, 0, quotient)),
            'stored_length': self.u32('collection_stored_length'),
            'capacity_from_size_and_stride': z3.Extract(31, 0, quotient),
            'stride': stride,
        })
        status = self.input('open_error', 64)
        self.contract_link('open_status', z3.Implies(self.events.get('open', z3.BoolVal(False)),
                                                     status == instance['status']))
        self.open_contract = instance
        self.opened_length = z3.BitVec('opened_collection_length', 32)
        self.opened_capacity = z3.BitVec('opened_collection_capacity', 32)
        self.opened_stride = instance['outputs']['stride']
        self.contract_link('open_outputs', z3.And(
            z3.Implies(z3.And(self.events.get('open', z3.BoolVal(False)), status == 0),
                       self.opened_length == instance['outputs']['length']),
            z3.Implies(z3.And(self.events.get('open', z3.BoolVal(False)), status == 0),
                       self.opened_capacity == instance['outputs']['capacity'])))

    def _record_select_contract(self, args, scalar_bindings):
        instance = collection_contracts.instantiate('select', {
            'length': self.opened_length,
            'capacity': self.opened_capacity,
            'start': scalar_bindings[1],
            'count': scalar_bindings[2],
            'maximum': scalar_bindings[3],
            'old_start': self.u32('old_selected_start'),
            'old_reserved': self.u32('old_selected_reserved'),
            'old_loaded': self.u32('old_selected_loaded'),
        })
        status = self.input('select_ok', 1)
        event = self.events.get('select_window', z3.BoolVal(False))
        self.contract_link('select_status', z3.Implies(event, status == z3.ZeroExt(32, instance['status'])))
        for name, actual in (('start', self.u32('start')),
                             ('reserved', self.u32('reserved')),
                             ('loaded', self.u32('loaded'))):
            self.contract_link('select_outputs_'+name,
                               z3.Implies(event, actual == instance['outputs'][name]))
        self.select_contract = instance

    def _record_plan_contract(self, args):
        instance = collection_contracts.instantiate('plan', {
            'length': self.opened_length,
            'capacity': self.opened_capacity,
            'start': self.u32('start'),
            'reserved': self.u32('reserved'),
            'loaded': self.u32('loaded'),
            'written': self._u32_argument(args[2]),
            'next_length': self._u32_argument(args[3]),
        })
        status = self.input('plan_ok', 1)
        self.contract_link('plan_status', z3.Implies(self.events.get('plan', z3.BoolVal(False)),
            status == z3.ZeroExt(32, instance['status'])))
        self.plan_contract = instance

    def require(self, label, predicate):
        self.checks.append((label, z3.Implies(self.pc, predicate)))

    def set(self, name, value):
        old = self.variables.get(name, self.bv(0))
        self.variables[name] = z3.If(self.pc, self.number(value), old)

    def expr(self, tokens):
        t = self.api.strip_outer(tokens)
        # Find top-level operators. Splitting lowest precedence first preserves
        # C short circuiting and hence the reachability of codec/helper calls.
        for ops in (("?",), ("||",), ("&&",), ("==", "!="), ("<=", ">=", "<", ">"), ("+",)):
            depth = bracket = 0
            positions = []
            for i, tok in enumerate(t):
                if tok == "(": depth += 1
                elif tok == ")": depth -= 1
                elif tok == "[": bracket += 1
                elif tok == "]": bracket -= 1
                elif depth == bracket == 0 and tok in ops:
                    positions.append(i)
            # C binary operators in this subset associate left-to-right, so
            # the outermost split is the rightmost operator. Ternary is right
            # associative and nested ternaries remain outside this grammar.
            for i in (positions if ops == ("?",) else reversed(positions)):
                    tok = t[i]
                    left = self.expr(t[:i])
                    if tok == "?":
                        colons = self.api.split_top(t[i+1:], ":")
                        self.api.need(len(colons) == 2, "path expression: nested ternary unsupported")
                        saved = self.pc
                        self.pc = z3.And(saved, self.truth(left)); yes = self.expr(colons[0])
                        self.pc = z3.And(saved, z3.Not(self.truth(left))); no = self.expr(colons[1])
                        self.pc = saved
                        return z3.If(self.truth(left), self.number(yes), self.number(no))
                    saved = self.pc
                    if tok == "&&": self.pc = z3.And(saved, self.truth(left))
                    if tok == "||": self.pc = z3.And(saved, z3.Not(self.truth(left)))
                    right = self.expr(t[i+1:]); self.pc = saved
                    if tok == "&&": return z3.And(self.truth(left), self.truth(right))
                    if tok == "||": return z3.Or(self.truth(left), self.truth(right))
                    a, b = self.number(left), self.number(right)
                    if tok == "==": return a == b
                    if tok == "!=": return a != b
                    if tok == "<": return z3.ULT(a, b)
                    if tok == ">": return z3.UGT(a, b)
                    if tok == "<=": return z3.ULE(a, b)
                    if tok == ">=": return z3.UGE(a, b)
                    if tok == "+":
                        self.api.need(''.join(t) == '256ULL+code', 'path arithmetic outside checked unsigned-64 refusal addition')
                        return a + b
        # Only scalar casts with unsigned ABI meaning are accepted here.
        if len(t) > 3 and t[:3] in (["(", "unsigned", ")"], ["(", "u32", ")"]):
            return z3.ZeroExt(32, z3.Extract(31, 0, self.number(self.expr(t[3:]))))
        if t and t[0] == "!": return z3.Not(self.truth(self.expr(t[1:])))
        if len(t) == 1 and re.fullmatch(r"(?:0x[0-9a-fA-F]+|[0-9]+)[uUlL]*", t[0]):
            text = re.sub(r"[uUlL]+$", "", t[0])
            base = 16 if text.startswith("0x") else (8 if len(text) > 1 and text.startswith("0") else 10)
            self.api.need(base != 8 or all(c in '01234567' for c in text), 'invalid C octal literal')
            value = int(text, base)
            self.api.need(value < (1 << 64), 'path integer literal exceeds unsigned-64 domain')
            return self.bv(value)
        text = "".join(t)
        if text in self.loop: return self.bv(self.loop[text])
        if text in self.variables: return self.variables[text]
        byte = re.fullmatch(r'program\[([01])\]', text)
        if byte: return self.input('program_byte_'+byte[1], 8)
        if len(t) > 2 and t[1] == "(" and self.api.matching(t, 1, "(", ")") == len(t)-1:
            return self.call(t[0], self.api.split_top(t[2:-1], ","))
        fields = {
            "count": ("account_count", 64), "length": ("instruction_length", 64),
            "ix[0]": ("mode", 8), "initialize": ("initialize", 32),
            "state->executable": ("executable", 32), "state->writable": ("writable", 32),
            "state->signer": ("signer", 32), "state->size": ("state_size", 64),
            "error": ("open_error", 64),
            "selection.tag": ("selection_tag", 32), "selection.as.c1.f0.tag": ("range_tag", 32),
            "selected.loaded": ("loaded", 32), "selected.start": ("start", 32),
            "selected.reserved": ("reserved", 32),
            "selection.as.c1.f0.as.c0.f0": ("selector_start", 32),
            "selection.as.c1.f0.as.c0.f1": ("selection_count", 32),
            "result.tag": ("result_tag", 32), "result.as.c1.f0": ("code", 32),
            "after->tag": ("window_tag", 32), "after->as.c0.f1.tag": ("vector_tag", 32),
            "(*after).as.c0.f1.as.c0.f1.tag": ("pair_tag", 32),
            "after->as.c0.f0": ("after_start", 32),
            "after->as.c0.f1.as.c0.f0": ("written", 32), "result.as.c0.f2": ("next", 32),
            "state_header[i]": (f"header_{self.loop.get('i')}", 8),
            "state->data[i]": (f"data_{self.loop.get('i')}", 8),
        }
        if text in fields:
            if text.startswith('selected.'):
                self.require('selected field initialized by accepted select',z3.And(
                    self.events.get('select_window',z3.BoolVal(False)),self.input('select_ok',1) != 0))
            if text.startswith('selection.'):
                self.require('selection field initialized by selector',self.events.get('selector',z3.BoolVal(False)))
            if text.startswith('result.') or text.startswith('after->') or text.startswith('(*after)'):
                self.require('outcome field initialized by root',self.events.get('root',z3.BoolVal(False)))
            if text == 'state_header[i]':
                self.require('state header byte read inside constant array',
                             z3.ULT(self.bv(self.loop['i']), self.bv(20)))
            if text == 'state->data[i]':
                # This fixture performs all account reads before effects. Do
                # not reuse pre-state bytes after a write: discharge the
                # read-before-write obligation on every reachable path.
                self.require('state byte read precedes all mutations', z3.Not(z3.Or(*[
                    self.events.get(name,z3.BoolVal(False))
                    for name in ('commit','state_header_write','state_payload_write')
                ])))
                self.require('state byte read inside allocation',z3.UGT(self.input('state_size',64),self.bv(self.loop['i'])))
            return self.input(*fields[text])
        raise self.api.Grammar(f"path expression outside modeled scalar grammar: {text}")

    def call(self, name, args):
        a = ["".join(x) for x in args]
        if name == "equal_key":
            if a == ["state->owner", "program"]: return self.input("owner_equal", 1)
            if a == ["accounts[i].key", "accounts[j].key"]:
                return self.input(f"alias_{self.loop['i']}_{self.loop['j']}", 1)
        if name == "bend_State_decode":
            mode = "initial" if a[0] == "empty" else "stored"
            expected = self.input('initialize') != 0
            if mode == 'stored': expected = z3.Not(expected)
            self.require('codec input outside abstract call contract: '+mode, expected)
            self.event("state_decode_"+mode)
            return self.input("state_decode_"+mode, 1)
        if name == "bend_Instruction_decode":
            self.event("instruction_decode"); return self.input("instruction_decode", 1)
        if name == "sol_get_clock_sysvar":
            self.event("clock"); return self.input("clock_error", 64)
        if name == "bend_collection_select":
            self.event("select_window")
            scalar_bindings = {i: self._u32_argument(args[i]) for i in (1, 2, 3)}
            self.observe(name, args, 'select_ok', scalar_bindings=scalar_bindings)
            self._record_select_contract(args, scalar_bindings)
            return self.input("select_ok", 1)
        if name == "bend_U32_decode":
            index = 0 if a[2].endswith("f0") else 1
            self.require(f"record {index} read within loaded window", z3.UGT(self.input("loaded"), self.bv(index)))
            nested = self.api.calls(args[0])
            record_call = next((row for row in nested if row[0] == 'bend_collection_record'), None)
            self.api.need(record_call is not None, 'record observation: missing parsed record call')
            local_argument = self._u32_argument(record_call[1][2])
            self.observe('bend_collection_record', record_call[1],
                         pointer_result=f'record_pointer_{index}',
                         scalar_bindings={2: local_argument})
            record = collection_contracts.instantiate('record', {
                'local': local_argument,
                'start': self.u32('start'), 'loaded': self.u32('loaded'),
                'stride': self.opened_stride,
                'data_size': self.input('collection_size', 64),
            })
            record_active = z3.Bool(f'record_pointer_{index}_nonnull')
            record_offset = z3.BitVec(f'record_pointer_{index}_offset', 64)
            self.contract_link(f'record_pointer_{index}', z3.Implies(self.pc, z3.And(
                record_active == record['result_nonnull'],
                record_offset == record['result_offset'])))
            self.checks.append((f'record {index} active record span follows shared contract',
                                z3.Implies(self.pc,
                                           z3.Or(z3.Not(record['active']), record['activeSpan']))))
            self.record_contracts[index] = record
            self.event(f"record_decode_{index}")
            return self.input(f"record_decode_{index}", 1)
        if name == "bend_collection_plan":
            self.event("plan")
            scalar_bindings = {i: self._u32_argument(args[i]) for i in (2, 3)}
            self.observe(name, args, 'plan_ok', scalar_bindings=scalar_bindings)
            self._record_plan_contract(args)
            return self.input("plan_ok", 1)
        if name == "bend_State_encode":
            self.event("state_encode"); return self.input("state_encode", 1)
        if name == "bend_U32_encode":
            index = 0 if a[0].endswith("+0") else 1
            self.event(f"record_encode_{index}")
            return self.input(f"record_encode_{index}", 1)
        raise self.api.Grammar(f"path call outside contract: {name}({','.join(a)})")

    def simple(self, tokens):
        text = "".join(tokens)
        if text.startswith("Account*state="): return
        if text in ("bend_State_tbefore", "BendCollectioncollection", "bend_Instruction_tinstruction", "BendCollectionClockclock", "BendCollectionWindowselected", "(void)count"): return
        if re.fullmatch(r"constu8empty\[5\]=\{0\}|u8encoded_state\[5\],encoded_records\[8\]", text): return
        if text.startswith("u64error=bend_collection_open("):
            parsed = self.api.calls(tokens)
            call = next((row for row in parsed if row[0] == 'bend_collection_open'), None)
            self.api.need(call is not None, 'open observation: missing parsed call')
            self.event("open")
            scalar_bindings = {i: self._u32_argument(call[1][i]) for i in (4,)}
            scalar_bindings[5] = self.expr(call[1][5])
            self.observe('bend_collection_open', call[1], 'open_error', scalar_bindings=scalar_bindings)
            self._record_open_contract(call[1])
            self.set("error", self.input("open_error", 64)); return
        if "context=" in text:
            self.event("context"); return
        if "metadata=" in text:
            self.event("metadata"); return
        if "selection=bend_select(" in text:
            self.event("selector"); return
        if text.endswith("value={0}"):
            self.set("value_start", self.bv(0)); self.set("value_loaded", self.bv(0)); return
        if text == "value.as.c0.f0=selected.start": self.set("value_start", self.input("start")); return
        if text == "value.as.c0.f1.as.c0.f0=selected.loaded": self.set("value_loaded", self.input("loaded")); return
        if "result=bend_process(" in text:
            self.require("root receives selected start", self.variables.get("value_start", self.bv(0)) == self.input("start"))
            self.require("root receives selected length", self.variables.get("value_loaded", self.bv(0)) == self.input("loaded"))
            self.event("root"); return
        if text == "u32code=result.as.c1.f0": self.set("code", self.input("code")); return
        if "*after=&result.as.c0.f1" in text: return
        if text == "u32written=after->as.c0.f1.as.c0.f0,next=result.as.c0.f2":
            self.set("written", self.input("written")); self.set("next", self.input("next")); return
        writes = {
            "bend_collection_commit(&collection,&selected,written,next,encoded_records,collection_header,state->key)": "commit",
            "__builtin_memcpy(state->data,state_header,20)": "state_header_write",
            "__builtin_memcpy(state->data+20,encoded_state,5)": "state_payload_write",
            "sol_set_return_data(encoded_state,5)": "return_data",
        }
        if text in writes:
            self.require('write occurs at most once: '+writes[text],z3.Not(self.events.get(writes[text],z3.BoolVal(False))))
            order = ['commit','state_header_write','state_payload_write','return_data']
            which = order.index(writes[text])
            if which:
                self.require('write order: '+writes[text],self.events.get(order[which-1],z3.BoolVal(False)))
            else:
                self.require('commit consumes initialized state encoding',z3.And(
                    self.events.get('state_encode',z3.BoolVal(False)),self.input('state_encode',1) != 0))
                self.require('commit consumes an accepted bounded plan',z3.And(
                    self.events.get('plan',z3.BoolVal(False)),self.input('plan_ok',1) != 0,
                    z3.ULE(self.input('written'),self.bv(2))))
                for i in range(2):
                    self.require(f'commit consumes initialized record {i}',z3.Implies(
                        z3.UGT(self.input('written'),self.bv(i)),z3.And(
                            self.events.get(f'record_encode_{i}',z3.BoolVal(False)),self.input(f'record_encode_{i}',1) != 0)))
                if writes[text] == 'commit':
                    parsed = self.api.calls(tokens)
                    call = next((row for row in parsed if row[0] == 'bend_collection_commit'), None)
                    self.api.need(call is not None, 'commit observation: missing parsed call')
                    scalar_bindings = {i: self._u32_argument(call[1][i]) for i in (2, 3)}
                    self.observe('bend_collection_commit', call[1], scalar_bindings=scalar_bindings)
            self.event(writes[text]); return
        raise self.api.Grammar(f"path statement outside contract: {text}")

    def statements(self, body):
        for node in body: self.statement(node)

    def statement(self, node):
        kind = node[0]
        if kind == "block": self.statements(node[1]); return
        if kind == "simple": self.simple(node[1]); return
        if kind == "return":
            result = self.number(self.expr(node[1])); self.returns.append((self.pc, result))
            self.pc = z3.BoolVal(False); return
        if kind == "if":
            cond = self.truth(self.expr(node[1])); initial = self.pc
            self.pc = z3.And(initial, cond); self.statement(node[2]); yes = self.pc
            self.pc = z3.And(initial, z3.Not(cond))
            if node[3] is not None: self.statement(node[3])
            self.pc = z3.Or(yes, self.pc); return
        if kind == "for":
            initial, condition, increment = ["".join(x) for x in node[1:4]]
            self.api.need(initial == "unsignedi=0" and increment == "++i" and condition in ("i<25", "i<20"), "path loop outside fixed byte scans")
            for i in range(int(condition[2:])):
                self.loop['i'] = i; self.statement(node[4])
            self.loop.pop('i'); return
        raise self.api.Grammar(f"path statement kind unsupported: {kind}")

    def reference(self):
        """Independent ordered refusal specification and observable stages."""
        pc = z3.BoolVal(True)
        events, returns = {}, []
        def n(name, bits=32): return self.input(name, bits)
        def bad(name): return n(name, 1) == 0
        def emit(name, extra=True): events[name] = z3.And(pc, extra)
        def refuse(condition, code):
            nonlocal pc
            returns.append((z3.And(pc, condition), self.bv(code) if isinstance(code, int) else code))
            pc = z3.And(pc, z3.Not(condition))
        refuse(z3.Or(bad('owner_equal'), n('executable',32) != 0), 3)
        refuse(n('writable',32) == 0, 5)
        refuse(n('state_size',64) != 25, 4)
        init = n('initialize') != 0
        refuse(z3.And(init, n('signer',32) == 0), 7)
        dirty = z3.Or(*[n(f'data_{i}',8) != 0 for i in range(25)])
        wrong_header = z3.Or(*[n(f'data_{i}',8) != n(f'header_{i}',8) for i in range(20)])
        refuse(z3.And(init, dirty), 4)
        emit('state_decode_initial', init)
        refuse(z3.And(init, bad('state_decode_initial')), 4)
        refuse(z3.And(z3.Not(init), wrong_header), 4)
        emit('state_decode_stored', z3.Not(init))
        refuse(z3.And(z3.Not(init), bad('state_decode_stored')), 4)
        emit('open'); refuse(n('open_error',64) != 0, n('open_error',64))
        emit('instruction_decode'); refuse(bad('instruction_decode'), 2)
        emit('clock'); refuse(n('clock_error',64) != 0, 8)
        emit('context'); emit('metadata'); emit('selector')
        refuse(n('selection_tag') == 0, 23)
        refuse(z3.Or(n('selection_tag') != 1, n('range_tag') != 0), 9)
        emit('select_window'); refuse(bad('select_ok'), 23)
        for i in range(2):
            active = z3.UGT(n('loaded'), self.bv(i)); emit(f'record_decode_{i}', active)
            refuse(z3.And(active, bad(f'record_decode_{i}')), 4)
        emit('root')
        code = z3.If(z3.ULE(n('code'), self.bv(0xfffffeff)), n('code')+256, self.bv(9))
        refuse(n('result_tag') == 1, code)
        refuse(n('result_tag') != 0, 9)
        refuse(z3.Or(*[n(x) != 0 for x in ('window_tag','vector_tag','pair_tag')]), 9)
        refuse(n('after_start') != n('start'), 9)
        emit('plan'); refuse(bad('plan_ok'), 9)
        emit('state_encode'); refuse(bad('state_encode'), 9)
        for i in range(2):
            active = z3.UGT(n('written'), self.bv(i)); emit(f'record_encode_{i}', active)
            refuse(z3.And(active, bad(f'record_encode_{i}')), 9)
        for name in ('commit','state_header_write','state_payload_write','return_data'): emit(name)
        returns.append((pc, self.bv(0)))
        return events, returns

    def solve(self, label, disagreement):
        solver = z3.Solver(); solver.set(timeout=20000)
        solver.add(*self.constraints, disagreement)
        status = solver.check()
        if status == z3.unknown: raise self.api.Fatal(f'caller path UNKNOWN: {solver.reason_unknown()}')
        if status == z3.sat:
            if label.startswith('codec input outside abstract call contract: '):
                raise self.api.Grammar(label)
            if label.startswith('stage invoked at most once: '):
                raise self.api.Grammar('reachable repeated call outside single-invocation model: '+label)
            model = solver.model()
            values = {name: str(model.eval(value, model_completion=True)) for name, value in self.inputs.items()}
            raise PathFailure(label, values)
        return {'name': label, 'result': 'unsat'}

    def prove(self, body):
        check_local_scopes(self.api, body, isinstance(self, EntryPaths))
        self.statements(body)
        # These are restrictions of the abstraction, not semantic refutations.
        # Check them before comparing traces to avoid false counterexamples for
        # equivalent decoders whose byte-input relation is not modeled here.
        for label, predicate in self.checks:
            if label.startswith('codec input outside abstract call contract: '):
                self.solve(label, z3.Not(predicate))
        events, returns = self.reference()
        proofs = [self.solve('all caller paths return', self.pc)]
        for name in sorted(set(events) | set(self.events)):
            proofs.append(self.solve('reachability: '+name, events.get(name,z3.BoolVal(False)) != self.events.get(name,z3.BoolVal(False))))
        def return_value(items):
            out = self.bv(0xffffffffffffffff)
            for pc, value in items: out = z3.If(pc, value, out)
            return out
        proofs.append(self.solve('ordered refusal and success result', return_value(returns) != return_value(self.returns)))
        for label, predicate in self.checks:
            if not label.startswith('codec input outside abstract call contract: '):
                proofs.append(self.solve(label, z3.Not(predicate)))
        return proofs


class EntryPaths(Paths):
    """Entrypoint control flow with the loader primitive kept conditional."""
    def __init__(self, api, model):
        super().__init__(api, model)
        self.variables.pop('count')
        aliases = [self.truth(self.input(f'alias_{i}_{j}', 1)) for i,j in ((1,0),(2,0),(2,1))]
        # Equality between three keys is an equivalence relation.
        for i in range(3):
            self.constraints.append(z3.Implies(z3.And(aliases[(i+1)%3],aliases[(i+2)%3]),aliases[i]))

    def expr(self, tokens):
        text = ''.join(self.api.strip_outer(tokens))
        if text == 'ix[0]': self.event('mode_read')
        if text == 'input[0]': return z3.ZeroExt(56,z3.Extract(7,0,self.input('account_count',64)))
        return super().expr(tokens)

    def simple(self, tokens):
        text = ''.join(tokens)
        if text == 'u64count=read_le(input,8)':
            self.set('count',self.input('account_count',64)); return
        if text == 'Accountaccounts[3]': return
        if text == 'constu8*p=input+8': self.set('p',self.bv(1)); return
        if text == 'p=read_account(p,&accounts[i])':
            index = self.loop['i']
            self.api.need(0 <= index < 3, 'loader loop unroll index outside fixed array')
            self.require('account loader receives live pointer',self.truth(self.variables.get('p',self.bv(0))))
            self.event(f'load_{index}'); self.set('p',self.input(f'load_{index}',1)); return
        if text == 'u64length=read_le(p,8)':
            self.require('instruction length read uses live pointer',self.truth(self.variables.get('p',self.bv(0))))
            self.event('length_read'); self.set('length',self.input('instruction_length',64)); return
        if text == 'constu8*ix=p+8': return
        raise self.api.Grammar('entry statement outside exact argument contract: '+text)

    def call(self, name, args):
        if name == 'bend_collection_run':
            # This is a structural ABI obligation, separate from scalar paths.
            expected = ['accounts','(unsigned)count','ix+length','ix','ix[0]==0']
            self.api.need([''.join(a) for a in args] == expected,'entry dispatch argument contract')
            for arg in (args[1],args[4]): self.expr(arg)
            self.require('dispatch count exactly three',self.variables['count'] == 3)
            self.require('dispatch canonical instruction bounds',z3.And(self.variables['length'] == 10,z3.ULE(self.input('mode',8),self.bv(1))))
            self.event('dispatch'); return self.input('run_result',64)
        return super().call(name,args)

    def statement(self, node):
        if node[0] != 'for': return super().statement(node)
        initial, condition, increment = [''.join(x) for x in node[1:4]]
        self.api.need((initial,condition,increment) in (
            ('unsignedi=0','i<count','++i'),('unsignedj=0','j<i','++j')),
            'entry loop outside bounded loader/alias loops')
        variable = 'i' if initial == 'unsignedi=0' else 'j'
        outer = self.loop.get(variable)
        exits = []
        for index in range(3):
            self.loop[variable] = index
            cond = self.truth(self.expr(node[2]))
            exits.append(z3.And(self.pc,z3.Not(cond)))
            self.pc = z3.And(self.pc,cond)
            super().statement(node[4])
        self.loop[variable] = 3
        remains = self.truth(self.expr(node[2]))
        self.require('entry loop stays within three slots',z3.Not(remains))
        exits.append(z3.And(self.pc,z3.Not(remains)))
        self.pc = z3.Or(*exits)
        if outer is None: self.loop.pop(variable)
        else: self.loop[variable] = outer

    def reference(self):
        pc = z3.BoolVal(True); events, returns = {}, []
        def emit(name,extra=True): events[name] = z3.And(pc,extra)
        def refuse(condition,code):
            nonlocal pc
            returns.append((z3.And(pc,condition),self.bv(code)))
            pc = z3.And(pc,z3.Not(condition))
        refuse(self.input('account_count',64) != 3,1)
        for i in range(3):
            emit(f'load_{i}'); refuse(self.input(f'load_{i}',1) == 0,6)
            for j in range(i): refuse(self.input(f'alias_{i}_{j}',1) != 0,6)
        emit('length_read')
        length = self.input('instruction_length',64)
        emit('mode_read',length == 10)
        refuse(z3.Or(length != 10,z3.UGT(self.input('mode',8),self.bv(1))),2)
        emit('dispatch'); returns.append((pc,self.input('run_result',64)))
        return events,returns


def check_declarations(api, text, interface):
    """Close the declaration/signature boundary of this exact fixture slice."""
    def skeleton(source):
        tokens = api.lex(api.clean_directives(source, 'caller'), 'caller')
        result, index = [], 0
        while index < len(tokens):
            if tokens[index] in ('bend_collection_run', 'entrypoint') and index+1 < len(tokens) and tokens[index+1] == '(':
                end = api.matching(tokens, index+1, '(', ')')
                if end+1 < len(tokens) and tokens[end+1] == '{':
                    close = api.matching(tokens, end+1, '{', '}')
                    result.extend(tokens[index:end+2]); result.append('}')
                    index = close+1; continue
            result.append(tokens[index]); index += 1
        return result
    expected = '''
typedef struct {u64 slot; long long epoch_start_timestamp; u64 epoch; u64 leader_schedule_epoch; long long unix_timestamp;} BendCollectionClock;
extern u64 sol_get_clock_sysvar(void *);
static const u8 state_header[20]={STATE};
static const u8 collection_header[20]={COLLECTION};
__attribute__((noinline)) static u64 bend_collection_run(Account *accounts,unsigned count,const u8 *program,const u8 *ix,unsigned initialize) {}
__attribute__((visibility("default"))) u64 entrypoint(const u8 *input) {}
'''.replace('STATE', ','.join(map(str,interface['header']))).replace('COLLECTION', ','.join(map(str,interface['collection']['header'])))
    api.need(skeleton(text) == skeleton(expected), 'caller declarations/signatures outside checked ABI')


def check_run_arguments(api, body, m):
    """Independent schema-derived statement/call closure; no cast erasure."""
    api.need((m['stateBytes'],m['instructionBytes'],m['capacity'],m['stride']) == (25,10,2,4),
             'caller path model supports only the declared two-U32 fixture')
    types = m['types']
    context = types[m['args'][0]]
    context_fields = context['variants'][0]['fields']
    key = types[context_fields[0]['type']]['variants'][0]['cMaker']
    slot = types[context_fields[2]['type']]['variants'][0]['cMaker']
    context_make = context['variants'][0]['cMaker']
    meta = types[m['args'][3]]
    meta_make = meta['variants'][0]['cMaker']
    window = types[m['args'][4]]['cType']
    def key_expr(pointer): return key+'('+','.join(f'(u32)read_le({pointer}+{i},4)' for i in range(0,32,4))+')'
    context_expr = f'{context_make}({key_expr("actor->key")},actor->signer,{slot}((u32)clock.slot,(u32)(clock.slot>>32)),{key_expr("accounts[2].key")})'
    allowed = [
        'Account *state=&accounts[0],*actor=&accounts[1]', 'bend_State_t before',
        'const u8 empty[5]={0}', 'BendCollection collection',
        'u64 error=bend_collection_open(&accounts[2],program,state->key,collection_header,4,initialize,&collection)',
        'bend_Instruction_t instruction','BendCollectionClock clock',
        f'{context["cType"]} context={context_expr}',
        f'{meta["cType"]} metadata={meta_make}(collection.length,collection.capacity)',
        f'{types[m["select"]["result"]]["cType"]} selection=bend_select(context,before,instruction,metadata)',
        'BendCollectionWindow selected',f'{window} value={{0}}',
        'value.as.c0.f0=selected.start','value.as.c0.f1.as.c0.f0=selected.loaded',
        'bend_Outcome_t result=bend_process(context,before,instruction,metadata,value)',
        'u32 code=result.as.c1.f0',f'{window} *after=&result.as.c0.f1',
        'u32 written=after->as.c0.f1.as.c0.f0,next=result.as.c0.f2',
        'u8 encoded_state[5],encoded_records[8]','(void)count',
        'bend_collection_commit(&collection,&selected,written,next,encoded_records,collection_header,state->key)',
        '__builtin_memcpy(state->data,state_header,20)',
        '__builtin_memcpy(state->data+20,encoded_state,5)',
        'sol_set_return_data(encoded_state,5)',
    ]
    allowed_tokens = {tuple(api.lex(x,'expected statement')) for x in allowed}
    calls = [
        'equal_key(state->owner,program)',
        'bend_State_decode(empty,5,&before)','bend_State_decode(state->data+20,5,&before)',
        'bend_Instruction_decode(ix+1,9,&instruction)','sol_get_clock_sysvar(&clock)',
        'bend_collection_select(&collection,selection.as.c1.f0.as.c0.f0,selection.as.c1.f0.as.c0.f1,2,&selected)',
        'bend_collection_plan(&collection,&selected,written,next)',
        'bend_State_encode(encoded_state,5,&result.as.c0.f0)',
    ]
    for i in range(2):
        calls.extend([
            f'bend_collection_record(&collection,&selected,{i})',
            f'bend_U32_decode(bend_collection_record(&collection,&selected,{i}),4,&value.as.c0.f1.as.c0.f1.as.c0.f{i})',
            f'bend_U32_encode(encoded_records+{i*4},4,&(*after).as.c0.f1.as.c0.f1.as.c0.f{i})',
        ])
    call_tokens = {tuple(api.lex(x,'expected call')) for x in calls}
    # Every statement is checked even when its path is infeasible. Unsupported
    # syntax must not acquire an invented meaning by hiding in a dead branch.
    for node in api.flat_nodes(body):
        if node[0] == 'simple':
            api.need(tuple(node[1]) in allowed_tokens,'run statement/declaration outside exact argument contract: '+''.join(node[1]))
        elif node[0] in ('if','return'):
            for name,args,start,end in api.calls(node[1]):
                api.need(tuple(node[1][start:end]) in call_tokens,'run helper argument contract: '+name)

def check_local_scopes(api, body, entry=False):
    """Validate lexical binding before applying the unshadowed symbolic model.

    Reject shadowing explicitly; declaration placement and every local use must
    obey C block/for scope. This is a supported-subset check, not a proof that
    a shadowed C program has the original program's behavior.
    """
    parameters = {'input'} if entry else {'accounts','count','program','ix','initialize'}
    local_names = {'state','actor','before','empty','collection','error','instruction','clock',
                   'context','metadata','selection','selected','value','result','code','after',
                   'written','next','encoded_state','encoded_records','accounts','count','p','length','ix','i','j'}
    known = local_names | parameters
    scopes = [set(parameters)]
    def uses(tokens):
        for index, token in enumerate(tokens):
            if token in known and (index == 0 or tokens[index-1] not in ('.','->')):
                api.need(any(token in s for s in scopes), 'local used outside declaration scope: '+token)
    def simple(tokens, declarations_allowed=True):
        t = list(tokens)
        if t[:1] == ['const']: t = t[1:]
        declaration = bool(t) and (t[0] in ('u8','u32','u64','unsigned','Account','BendCollection','BendCollectionClock','BendCollectionWindow') or
                                   re.fullmatch(r'bend_\w+_t',t[0]) is not None)
        if not declaration:
            uses(tokens); return
        api.need(declarations_allowed, 'declaration requires C compound-statement scope')
        for part in api.split_top(t[1:], ','):
            while part[:1] == ['*']: part = part[1:]
            api.need(bool(part) and part[0] in local_names, 'unsupported local declarator')
            name = part[0]
            api.need(not any(name in s for s in scopes), 'shadowed or repeated local declaration: '+name)
            scopes[-1].add(name)
            uses(part[1:])
    def walk(node, declarations_allowed=False):
        kind = node[0]
        if kind == 'block':
            scopes.append(set())
            for child in node[1]: walk(child,True)
            scopes.pop()
        elif kind == 'simple': simple(node[1],declarations_allowed)
        elif kind == 'return': uses(node[1])
        elif kind == 'if':
            uses(node[1]); walk(node[2])
            if node[3] is not None: walk(node[3])
        elif kind == 'for':
            scopes.append(set()); simple(node[1]); uses(node[2]); uses(node[3]); walk(node[4]); scopes.pop()
        else: raise api.Grammar('scope check outside supported statement grammar: '+kind)
    for node in body: walk(node,True)
