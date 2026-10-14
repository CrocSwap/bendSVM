"""Bind parsed token validation to extracted fields and adapter observations.

Each instance describes one immutable account snapshot shared by all slots.
The caller must establish count 4..12 at every actual validation call. Account
storage/pointers, custody identity, CPI execution and machine code are not modeled.
"""
import z3
import token_validate as token


class Validation:
    def __init__(self, files):
        self.model, self.interpreter, self.actual, self.claims = token.evaluate(files)
        self.runtime_hashes = {name: token.sha(files[name])
                               for name in ('token.h', 'cpi_abi.h', 'solana_min.h')}
        m, f = self.model, self.model.fields
        success = self.actual == token.bv(0, 64)
        invokes = z3.Or(f['active'] == 1, f['active'] == 3, f['active'] == 4)
        self.claims = {'caller-count': m.pre, **self.claims,
            'executor-mint-index': z3.Implies(z3.And(success, invokes),
                                             z3.ULT(f['mint'], m.count)),
            'executor-decimals-read': z3.Implies(z3.And(success, invokes),
                                                z3.UGT(m.size(f['mint']), token.bv(44, 64))),
            'executor-transfer-indices': z3.Implies(z3.And(success, f['active'] == 1),
                z3.And(z3.ULT(f['source'], m.count), z3.ULT(f['destination'], m.count))),
            'executor-transfer-authority': z3.Implies(z3.And(success, f['active'] == 1),
                                                      z3.ULE(f['authority'], token.bv(1)))}

    def bind(self, slot, count, accounts):
        """Return the actual result and guarded claims over caller expressions.

        Owner/data arrays are independent token inputs. Reserved account values
        in these arrays are irrelevant to returns, as verify_reserved proves.
        All observable key/flag/size entries 0..11 must be supplied explicitly.
        """
        m = self.model
        expected = {(name,) for name in m.fields} | {('amount',)}
        expected |= {((name,), i) for name in m.native_keys for i in range(32)}
        token.need(set(slot) == expected, 'validator binding: exact slot field inventory')
        token.need_bv(count, 64, 'adapter count')
        pairs = [(m.count, z3.Extract(31, 0, count))]
        for name, symbol in m.fields.items():
            token.need_bv(slot[(name,)], 32, name)
            pairs.append((symbol, slot[(name,)]))
        token.need_bv(slot[('amount',)], 64, 'amount')
        pairs.append((m.amount, slot[('amount',)]))
        for name, symbol in m.native_keys.items():
            parts = [slot[((name,), i)] for i in range(32)]
            for part in parts:
                token.need_bv(part, 8, name + ' byte')
            pairs.append((symbol, z3.Concat(*parts[::-1])))
        widths = {'keys': 256, 'size': 64, 'signer': 32, 'writable': 32, 'executable': 32}
        token.need(set(accounts) == set(widths), 'validator binding: account view inventory')
        for name, width in widths.items():
            values = accounts[name]
            token.need(len(values) == 12, 'validator binding: twelve account observations required')
            array = getattr(m, 'account_' + name)
            mapped = array
            for i, value in enumerate(values):
                token.need_bv(value, width, 'account ' + name)
                mapped = z3.Store(mapped, token.bv(i), value)
            pairs.append((array, mapped))
        apply = lambda value: z3.simplify(z3.substitute(value, *pairs))
        claims = {name: apply(value) for name, value in self.claims.items()}
        # Count is U64 in the adapter but unsigned/U32 in the helper. The
        # original full-width count must satisfy the bound, not just its low word.
        claims['caller-count'] = z3.And(z3.UGE(count, token.bv(4, 64)),
                                        z3.ULE(count, token.bv(12, 64)))
        return apply(self.actual), claims

    def bind_world(self, world, slot):
        scalar = lambda values: [z3.If(v, token.bv(1), token.bv(0)) for v in values]
        return self.bind(slot, world.COUNT, {
            'keys': [world.key_bytes(i) for i in range(len(world.KEY))],
            'size': world.SIZE, 'signer': scalar(world.SIGNER),
            'writable': scalar(world.WRITABLE), 'executable': scalar(world.EXECUTABLE)})

    def verify_reserved(self):
        """Prove why reserved owners/data can remain independent of state bytes."""
        pairs = []
        for name in ('account_owners', 'account_data'):
            original = getattr(self.model, name)
            updated = original
            for i in range(4):
                value = z3.Const('replacement_' + name + str(i), original.range())
                updated = z3.Store(updated, token.bv(i), value)
            pairs.append((original, updated))
        # Discharge frame facts before reusing them in the larger return guards.
        # The indices come from the actual parsed expressions, including nested
        # data-array reads; no fixed list of field names is assumed.
        lemmas = []
        for original, updated in pairs:
            pending = [value for row in self.interpreter.returns for value in row]
            seen, indices = set(), {}
            while pending:
                value = pending.pop()
                if value.get_id() in seen:
                    continue
                seen.add(value.get_id())
                if z3.is_select(value) and value.arg(0).eq(original):
                    index = value.arg(1)
                    indices[index.get_id()] = index
                pending.extend(value.children())
            for index in indices.values():
                lemma = z3.Implies(z3.UGE(index, token.bv(4)),
                    z3.Select(original, index) == z3.Select(updated, index))
                token.solve(self.model, z3.Not(lemma), 'unsat')
                lemmas.append(lemma)
        # Prove each parsed return guard is unchanged, and its selected return
        # value is unchanged. Together with complete return coverage (checked
        # in the composed claims), this establishes equality of the result.
        # Splitting avoids a large comparison between two nested return ITEs.
        for guard, value in self.interpreter.returns:
            changed_guard = z3.substitute(guard, *pairs)
            token.solve(self.model, z3.And(*lemmas,
                z3.simplify(guard != changed_guard)), 'unsat')
            changed_value = z3.substitute(value, *pairs)
            token.solve(self.model, z3.And(*lemmas,
                z3.simplify(z3.And(guard, value != changed_value))), 'unsat')
        return {'name': 'validator-return-independent-of-reserved-data-and-owners',
                'result': 'unsat'}
