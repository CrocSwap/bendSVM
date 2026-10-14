"""Fail-closed front end for the emitted ABI 1 adapter translation unit.

Only the reviewed restricted C subset is accepted. Everything else raises
`Grammar`: the text is outside what the symbolic model understands, which is a
rejection and never a proof. This is not a C parser: it recognises the shapes
`compiler/storage.ts` emits plus the statement/expression forms needed to give
reordered, weakened or truncated variants a meaning.
"""
import re


class Grammar(Exception):
    """The artifact is outside the reviewed restricted syntax."""


def need(condition, message):
    if not condition:
        raise Grammar(message)


# ---- Preprocessing-safe lexing ------------------------------------------------
TOKEN = re.compile(
    r'[ \t\n]+|/\*[\s\S]*?\*/|//[^\n]*|"[^"\n]*"|[A-Za-z_]\w*'
    r'|0[xX][0-9a-fA-F]+[uUlL]*(?![\w.])|[0-9]+[uUlL]*(?![\w.])'
    r'|->|\+\+|--|&&|\|\||<<|>>|<=|>=|==|!=|[{}()\[\];:,.&*+|=<>!?#/%^~\-]')
IDENT = re.compile(r'[A-Za-z_]\w*\Z')
NUMBER = re.compile(r'(?:0[xX][0-9a-fA-F]+|[0-9]+)[uUlL]*\Z')


def strict_tokens(text):
    """Tokens of the adapter's own text, or Grammar.

    Translation phases 1-3 are made trivial instead of emulated: no line
    splices, trigraphs, digraphs, carriage returns, control or non-ASCII
    characters, character literals or preprocessing numbers that would lex
    differently in C. Comments are removed by the same tokenizer that
    recognises string literals, so neither can hide the other.
    """
    need(text.isascii() and all(c in '\t\n' or 32 <= ord(c) <= 126 for c in text),
         'preprocessing: control or non-ASCII character')
    need('\\' not in text, 'preprocessing: backslash (line splice or escape)')
    need('??' not in text, 'preprocessing: trigraph introducer')
    need(not any(d in text for d in ('%:', '<:', ':>', '<%', '%>')), 'preprocessing: digraph')
    tokens, at = [], 0
    while at < len(text):
        match = TOKEN.match(text, at)
        need(match is not None, f'lexical: unrecognized C token near {text[at:at + 40]!r}')
        token = match.group()
        need(not (token == '/' and text[at:at + 2] in ('/*', '//')), 'lexical: unterminated comment')
        at = match.end()
        if token[0] in ' \t\n' or token.startswith(('/*', '//')):
            continue
        # `0x1e+3` is one (invalid) preprocessing number in C.
        need(not (token[:2] in ('0x', '0X') and token[-1] in 'eEpP' and text[at:at + 1] in ('+', '-')),
             'lexical: preprocessing number')
        tokens.append(token)
    return tokens


INCLUDE = re.compile(r'#include (?:"([A-Za-z0-9_.-]+)"|<([A-Za-z0-9_.-]+)>)\Z')


def split_includes(text):
    """Return (include name/form pairs, remaining tokens). Directives must be the exact,
    line-isolated includes that lead the file; any other `#` is rejected."""
    names, lead = [], []
    for line in text.split('\n'):
        if '#' in line:
            match = INCLUDE.match(line)
            need(match is not None, 'preprocessing: unsupported or non-line-isolated directive')
            names.append((match.group(1) or match.group(2), '"' if match.group(1) else '<'))
            lead += strict_tokens(line)
    tokens = strict_tokens(text)
    # A directive inside a comment, or after code, makes the token stream
    # disagree with the line scan.
    need(tokens[:len(lead)] == lead and '#' not in tokens[len(lead):],
         'preprocessing: directive inside a comment or after code')
    return names, tokens[len(lead):]


# ---- Dependency headers --------------------------------------------------------
LENIENT = re.compile(r'/\*[\s\S]*?\*/|//[^\n]*|"(?:[^"\n])*"|\'(?:[^\'\n])*\'|[A-Za-z_]\w*|[0-9]\w*|->|\S')


def header_tokens(text):
    return [t for t in LENIENT.findall(text) if not t.startswith(('/*', '//'))]


def header_directives(name, text):
    """(macro names, include names) of a dependency header. Conditionals,
    #undef, splices and alternative spellings are rejected, so every macro
    that can reach the adapter is in the returned list."""
    need(text.isascii() and '\r' not in text, f'dependency {name}: non-ASCII or carriage return')
    need('\\' not in text and '??' not in text and not any(d in text for d in ('%:', '<:', ':>', '<%', '%>')),
         f'dependency {name}: line splice, trigraph or digraph')
    # Comments become one space, as in translation phase 3, before lines are
    # classified; string and character literals are kept intact.
    flat = ''.join(' ' if t.startswith(('/*', '//')) else t
                   for t in re.findall(r'/\*[\s\S]*?\*/|//[^\n]*|"(?:[^"\n])*"|\'(?:[^\'\n])*\'|[\s\S]', text))
    need('/*' not in re.sub(r'"(?:[^"\n])*"|\'(?:[^\'\n])*\'', '', flat), f'dependency {name}: unterminated comment')
    macros, includes = [], []
    for line in flat.split('\n'):
        if '#' not in line:
            continue
        line = line.strip()
        need(line.startswith('#'), f'dependency {name}: directive is not line-isolated')
        if re.fullmatch(r'#\s*pragma\s+once', line):
            continue
        match = re.fullmatch(r'#\s*include\s*(?:"([A-Za-z0-9_.-]+)"|<([A-Za-z0-9_.-]+)>)', line)
        if match:
            includes.append(match.group(1) or match.group(2))
            continue
        match = re.fullmatch(r'#\s*define\s+([A-Za-z_]\w*)(?:[(\s].*)?', line)
        need(match is not None, f'dependency {name}: unsupported directive {line[:40]!r}')
        macros.append(match.group(1))
    return macros, includes


class AuditedHeaderTokens(list):
    pass


def audited_header_tokens(name, text):
    """Live header tokens: numeric object macros only, directives excluded.

    This prevents reviewed declarations from being supplied as unused macro
    replacement text, or macros from hiding braces from the scope audit.
    header_directives must also validate this header's directive forms.
    """
    flat = ''.join(' ' if t.startswith(('/*', '//')) else t
                   for t in re.findall(r'/\*[\s\S]*?\*/|//[^\n]*|"(?:[^"\n])*"|\'(?:[^\'\n])*\'|[\s\S]', text))
    live = []
    for line in flat.split('\n'):
        if line.lstrip().startswith('#'):
            if re.match(r'#\s*define\b', line.strip()):
                match = re.fullmatch(r'#\s*define\s+[A-Za-z_]\w*\s+([^\s]+)\s*', line.strip())
                need(match is not None and NUMBER.fullmatch(match.group(1)) is not None,
                     f'dependencies: {name}: macro replacement must be a single integer literal')
                literal(match.group(1))
            continue
        live.append(line)
    tokens = AuditedHeaderTokens(header_tokens('\n'.join(live)))
    need('overloadable' not in tokens and not any(tokens[i:i + 2] == ['[', '[']
         for i in range(len(tokens) - 1)),
         f'dependencies: {name}: unsupported attribute or function overloading')
    need('_Pragma' not in tokens and '__declspec' not in tokens and '__attribute' not in tokens,
         f'dependencies: {name}: unsupported layout or pragma control')
    for i, token in enumerate(tokens):
        if token == '__attribute__':
            need(tokens[i:i + 6] == ['__attribute__', '(', '(', 'noinline', ')', ')'],
                 f'dependencies: {name}: unsupported attribute')
    depth, tokens.declarations = 0, {}
    for i, token in enumerate(tokens):
        if depth == 0 and (i == 0 or tokens[i - 1] in (';', '}')):
            tokens.declarations.setdefault(token, []).append(i)
        if token == '{':
            depth += 1
        elif token == '}':
            depth -= 1
            need(depth >= 0, 'dependencies: unmatched closing brace')
    need(depth == 0, 'dependencies: unmatched opening brace')
    return tokens


def has_file_scope_tokens(haystack, needle):
    """Match one declaration/body at a file-scope declaration boundary."""
    return sum(haystack[i:i + len(needle)] == needle
               for i in haystack.declarations.get(needle[0], [])) == 1


def unique_file_scope_name(headers, name):
    """A summarized function may have only its reviewed file-scope binding.

    Count identifiers outside bodies/structs, including prototypes and alias
    declarations. Call sites inside function bodies do not count.
    """
    count = 0
    for tokens in headers:
        depth = 0
        for token in tokens:
            if depth == 0 and token == name:
                count += 1
            if token == '{':
                depth += 1
            elif token == '}':
                depth -= 1
    need(count == 1, f'dependencies: ambiguous file-scope binding for {name}')


def has_tokens(haystack, needle, exactly=1):
    n, hits = len(needle), 0
    for i in range(len(haystack) - n + 1):
        if haystack[i] == needle[0] and haystack[i:i + n] == needle:
            hits += 1
    return hits == exactly


# ---- Restricted statement and expression parser --------------------------------
SCALARS = {'u8': 'u8', 'u32': 'u32', 'u64': 'u64', 'unsigned': 'u32'}
KEYWORDS = {'if', 'else', 'for', 'return', 'const', 'unsigned', 'while', 'do', 'goto', 'switch', 'case', 'default',
            'break', 'continue', 'sizeof', 'struct', 'union', 'enum', 'typedef', 'static', 'extern', 'inline',
            'void', 'int', 'long', 'short', 'char', 'signed', 'float', 'double', 'volatile', 'register', 'auto',
            'restrict', '_Bool', '_Static_assert', '_Pragma', '_Generic', '_Alignof', '_Atomic', 'asm',
            '__asm', '__asm__', '__attribute__', '__extension__', '__typeof__', 'typeof'}


def literal(token):
    body = token.rstrip('uUlL')
    original_suffix = token[len(body):]
    need('lL' not in original_suffix and 'Ll' not in original_suffix,
         f'expression: invalid integer suffix {token!r}')
    suffix = original_suffix.lower()
    need(suffix in ('', 'u', 'ull'), f'expression: unsupported integer suffix {token!r}')
    if body[:2] in ('0x', '0X'):
        value, hexadecimal = int(body, 16), True
    else:
        need(body == '0' or body[0] != '0', f'expression: octal constant {token!r}')
        value, hexadecimal = int(body), False
    if suffix == 'ull':
        need(value < 1 << 64, 'expression: constant exceeds 64 bits')
        return ('num', value, 'u64')
    if suffix == 'u' or (hexadecimal and value >= 1 << 31):
        need(value < 1 << 32, f'expression: constant {token!r} is not a 32-bit unsigned value')
        return ('num', value, 'u32')
    need(value < 1 << 31, f'expression: constant {token!r} is not an int')
    return ('num', value, 'int')


class Parser:
    def __init__(self, tokens, types):
        self.t, self.at, self.types = tokens, 0, set(types)

    def peek(self, ahead=0):
        return self.t[self.at + ahead] if self.at + ahead < len(self.t) else ''

    def take(self, *expected):
        for token in expected:
            need(self.peek() == token, f'syntax: expected {token!r}, found {self.peek()!r} at token {self.at}')
            self.at += 1

    def exact(self, text, what):
        tokens = strict_tokens(text)
        need(self.t[self.at:self.at + len(tokens)] == tokens, f'syntax: {what} differs from the reviewed text')
        self.at += len(tokens)

    def ident(self):
        token = self.peek()
        need(IDENT.match(token) and token not in KEYWORDS, f'syntax: expected identifier, found {token!r}')
        self.at += 1
        return token

    def integer(self):
        token = self.peek()
        need(NUMBER.match(token) is not None, f'syntax: expected integer constant, found {token!r}')
        self.at += 1
        return literal(token)[1]

    # expressions -----------------------------------------------------------
    def expr(self):
        cond = self.binary(0)
        if self.peek() == '?':
            self.take('?')
            then = self.expr()
            self.take(':')
            return ('cond', cond, then, self.expr())
        return cond

    LEVELS = [('||',), ('&&',), ('|',), ('==', '!='), ('<', '>', '<=', '>='), ('<<', '>>'), ('+',)]

    def binary(self, level):
        if level == len(self.LEVELS):
            return self.unary()
        left = self.binary(level + 1)
        while self.peek() in self.LEVELS[level]:
            op = self.peek()
            self.at += 1
            right = self.binary(level + 1)
            left = ('lor', left, right) if op == '||' else ('land', left, right) if op == '&&' else ('bin', op, left, right)
        return left

    def unary(self):
        token = self.peek()
        if token == '!':
            self.take('!')
            return ('not', self.unary())
        if token == '&':
            self.take('&')
            return ('addr', self.unary())
        if token == '(' and self.peek(1) in SCALARS and self.peek(2) == ')':
            ctype = SCALARS[self.peek(1)]
            self.at += 3
            return ('cast', ctype, self.unary())
        return self.postfix()

    def postfix(self):
        token = self.peek()
        if token == '(':
            self.take('(')
            node = self.expr()
            self.take(')')
        elif NUMBER.match(token):
            self.at += 1
            node = literal(token)
        else:
            node = ('id', self.ident())
        while True:
            token = self.peek()
            if token == '[':
                self.take('[')
                node = ('index', node, self.expr())
                self.take(']')
            elif token == '.':
                self.take('.')
                node = ('member', node, self.ident())
            elif token == '(':
                need(node[0] == 'id', 'expression: call through a non-identifier')
                self.take('(')
                args = []
                if self.peek() != ')':
                    args.append(self.expr())
                    while self.peek() == ',':
                        self.take(',')
                        args.append(self.expr())
                self.take(')')
                node = ('call', node[1], args)
            else:
                return node

    # statements ------------------------------------------------------------
    def statement(self):
        token = self.peek()
        if token == '{':
            self.take('{')
            body = []
            while self.peek() != '}':
                need(self.peek() != '', 'syntax: unterminated block')
                body.append(self.statement())
            self.take('}')
            return ('block', body)
        if token == 'if':
            self.take('if', '(')
            cond = self.expr()
            self.take(')')
            then = self.statement()
            other = None
            if self.peek() == 'else':
                self.take('else')
                other = self.statement()
            need(then[0] not in ('decl', 'decls') and (other is None or other[0] not in ('decl', 'decls')), 'syntax: declaration as a branch')
            return ('if', cond, then, other)
        if token == 'for':
            self.take('for', '(', 'unsigned')
            var = self.ident()
            self.take('=')
            init = self.expr()
            self.take(';')
            cond = self.expr()
            self.take(';', '++')
            need(self.ident() == var, 'syntax: loop increments a different variable')
            self.take(')')
            body = self.statement()
            need(body[0] not in ('decl', 'decls'), 'syntax: declaration as a loop body')
            return ('for', var, init, cond, body)
        if token == 'return':
            self.take('return')
            value = self.expr()
            self.take(';')
            return ('return', value)
        if token == 'const' or token in self.types:
            const = token == 'const'
            if const:
                self.take('const')
            ctype = self.peek()
            need(ctype in self.types, f'syntax: unknown type {ctype!r}')
            self.at += 1
            items = []
            while True:
                pointer = self.peek() == '*'
                if pointer:
                    self.take('*')
                name = self.ident()
                size = init = None
                if self.peek() == '[':
                    self.take('[')
                    size = self.integer()
                    self.take(']')
                if self.peek() == '=':
                    self.take('=')
                    if self.peek() == '{':
                        self.take('{')
                        values = [self.integer()]
                        while self.peek() == ',':
                            self.take(',')
                            values.append(self.integer())
                        self.take('}')
                        init = ('list', values)
                    else:
                        init = ('expr', self.expr())
                items.append(('decl', ctype, const, pointer, name, size, init))
                if self.peek() != ',':
                    break
                self.take(',')
            self.take(';')
            return items[0] if len(items) == 1 else ('decls', items)
        if IDENT.match(token) and token not in KEYWORDS and self.peek(1) == '=':
            name = self.ident()
            self.take('=')
            value = self.expr()
            self.take(';')
            return ('assign', name, value)
        value = self.expr()
        need(value[0] == 'call', 'syntax: expression statement is not a call')
        self.take(';')
        return ('expr', value)


CLOCK = '''typedef struct { u64 slot; long long epoch_start_timestamp; u64 epoch;
  u64 leader_schedule_epoch; long long unix_timestamp; } BendClock;
_Static_assert(sizeof(BendClock) == 40, "Clock ABI");
extern u64 sol_get_clock_sysvar(void *);
__attribute__((visibility("default")))
u64 entrypoint(const u8 *input) {'''


def parse_adapter(text, wire_name, effect, types):
    """Account for every token of the written adapter file.

    `effect` is None or (include name, effect C type, effects C type, slot
    struct). Returns the entrypoint statements and the slot indices written by
    the emitted bend_extract_effects.
    """
    includes, tokens = split_includes(text)
    expected = [(wire_name, '"'), ('solana_min.h', '"')] + ([(effect[0], '<' if effect[0] == 'bend_cpi.h' else '"')] if effect else [])
    need(includes == expected, f'preprocessing: includes {includes} differ from {expected}')
    parser = Parser(tokens, types)
    slots = None
    if effect:
        _, effect_type, effects_type, slot_type = effect
        parser.exact(f'static inline int bend_extract_effect(const {effect_type} *value, {slot_type} *out) {{',
                     'effect extraction signature')
        single = extraction_body(parser, slot_type)
        need(all(single[i + 1:i + 2] in (['->'], ['=']) for i, token in enumerate(single) if token == 'out'),
             'effect extraction: write outside the single output slot')
        parser.exact(f'static inline int bend_extract_effects(const {effects_type} *value, {slot_type} *out) {{',
                     'effects extraction signature')
        body = extraction_body(parser, slot_type)
        written = set()
        for i, token in enumerate(body):
            if token == 'out':
                need(len(body) > i + 3 and body[i + 1] == '[' and NUMBER.match(body[i + 2]) and body[i + 3] == ']',
                     'effects extraction: unindexed output')
                written.add(literal(body[i + 2])[1])
        need(written and written == set(range(len(written))), 'effects extraction: output slots are not 0..n-1')
        slots = len(written)
    parser.exact(CLOCK, 'Clock declaration or entrypoint header')
    body = []
    while parser.peek() != '}':
        need(parser.peek() != '', 'syntax: unterminated entrypoint')
        body.append(parser.statement())
    parser.take('}')
    need(parser.at == len(tokens), 'syntax: text after the entrypoint')
    return body, slots


def extraction_body(parser, slot_type):
    """Scan a trusted effect-extraction body using a narrow identifier filter.

    This filter does not establish memory safety, initialized slots or
    noninterference. Those are explicit helper assumptions, not proved facts.
    """
    depth, start = 1, parser.at
    while depth:
        token = parser.peek()
        need(token != '', 'syntax: unterminated effect extraction')
        depth += (token == '{') - (token == '}')
        parser.at += 1
    body = parser.t[start:parser.at - 1]
    allowed = {'value', 'out', 'if', 'else', 'return', 'u64', 'write_le', 'bend_extract_effect', slot_type}
    for i, token in enumerate(body):
        if IDENT.match(token) and token not in allowed:
            need(i > 0 and body[i - 1] in ('.', '->'), f'effect extraction: unexpected identifier {token!r}')
    return body
