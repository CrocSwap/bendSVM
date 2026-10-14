#!/usr/bin/env python3
"""Focused ABI 1/2 codec dependency annotation and binding tests.

This loads compiler-emitted headers archived by adapter-codec-bindings.ts and
runs the real schema summarizers and dependency auditors. It does not parse or
prove codec bodies, execute full adapter contracts, or validate C/LLVM/SBF.
"""
import hashlib
import json
import pathlib
import sys
import z3

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'verification'))

import adapter_contract as abi1
import multi_adapter_contract as abi2


EXPECTED = {
    'abi1-small': {'abi': 1, 'n': 5, 'ix': 2},
    'abi1-edge255': {'abi': 1, 'n': 255, 'ix': 255},
    'abi1-edge256': {'abi': 1, 'n': 256, 'ix': 256},
    'abi2-instruction255': {'abi': 2, 'n': 512, 'ix': 255, 'field_sizes': [255, 256]},
    'abi2-instruction256': {'abi': 2, 'n': 512, 'ix': 256, 'field_sizes': [255, 256]},
}


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path):
    with pathlib.Path(path).open('r', encoding='utf-8') as source:
        return json.load(source)


def clone_files(fixture):
    archive = pathlib.Path(fixture['archiveDirectory'])
    files = {}
    for name in fixture['archiveFiles']:
        path = archive / name
        check(path.is_file(), f"{fixture['name']}: missing archived include {name}")
        expected = fixture['archiveHashes'].get(name)
        check(expected is not None and sha256(path) == expected,
              f"{fixture['name']}: archived include hash mismatch: {name}")
        files[name] = path.read_text(encoding='utf-8')
    return files


def replace_once(text, old, new, label):
    count = text.count(old)
    check(count == 1, f'{label}: expected exactly one edit target, found {count}')
    return text.replace(old, new, 1)


def prefix_for(size):
    # Independent fixture expectation: only generated ADTs at 256 bytes or
    # larger carry noinline. The fixtures pin the exact 255/256 boundary.
    return 'static __attribute__((noinline)) inline' if size >= 256 else 'static inline'


def opposite_prefix(size):
    return 'static inline' if size >= 256 else 'static __attribute__((noinline)) inline'


def load_fixtures(manifest):
    fixtures = {}
    records = manifest.get('fixtures')
    check(isinstance(records, list) and len(records) == len(EXPECTED),
          'manifest must contain exactly five emitted fixtures')
    for record in records:
        name = record.get('name')
        check(name in EXPECTED and name not in fixtures, f'unknown or duplicate fixture: {name!r}')
        expected = EXPECTED[name]
        check(record.get('abi') == expected['abi'], f'{name}: manifest ABI differs from expected layout')
        layout = record.get('expected')
        check(layout is not None and layout.get('n') == expected['n'] and layout.get('ix') == expected['ix'],
              f'{name}: manifest wire boundary differs from independently expected fixture layout')
        if 'field_sizes' in expected:
            check(layout.get('fieldSizes') == expected['field_sizes'], f'{name}: fixture field widths differ')

        schema = read_json(record['schema'])
        interface = read_json(record['interface'])
        files = clone_files(record)
        check(record['adapter'] in files, f'{name}: archived adapter is missing')
        check(record['adapter'] in files and record['adapter'].endswith('.c'), f'{name}: invalid adapter name')
        if expected['abi'] == 1:
            summary = abi1.summarize(schema, interface)
            check(summary['n'] == expected['n'] and summary['ix'] == expected['ix'],
                  f'{name}: ABI 1 summarizer differs from expected layout')
            abi1.audit_dependencies(summary, record['adapter'], files)
        else:
            summary = abi2.summarize(schema, interface)
            check(summary['n'] == expected['n'] and summary['ix'] == expected['ix'],
                  f'{name}: ABI 2 summarizer differs from expected layout')
            check(summary['field_sizes'] == expected['field_sizes'],
                  f'{name}: ABI 2 field decoder widths differ from expected layout')
            abi2.audit_dependencies(summary, record['adapter'], files)

        archive = pathlib.Path(record['archiveDirectory'])
        for filename, digest in record['archiveHashes'].items():
            check(sha256(archive / filename) == digest, f'{name}: archive changed during positive audit: {filename}')
        for filename, digest in record['outputHashes'].items():
            check(sha256(pathlib.Path(record['outputDirectory']) / filename) == digest,
                  f'{name}: artifact writer output hash changed: {filename}')
        check(sha256(record['schema']) == record['archiveHashes'][pathlib.Path(record['schema']).name],
              f'{name}: schema was not read from the archived artifact')
        check(sha256(record['interface']) == record['archiveHashes'][pathlib.Path(record['interface']).name],
              f'{name}: interface was not read from the archived artifact')
        for filename, digest in record['checkedSourceHashes'].items():
            check(sha256(filename) == digest, f'{name}: checked Bend source changed: {filename}')

        record['_expected'] = expected
        record['_schema_value'] = schema
        record['_interface_value'] = interface
        record['_files'] = files
        record['_summary'] = summary
        fixtures[name] = record
    check(set(fixtures) == set(EXPECTED), 'one or more expected emitted fixtures are missing')
    return fixtures


def audit_fixture(fixture, files):
    if fixture['abi'] == 1:
        return abi1.audit_dependencies(fixture['_summary'], fixture['adapter'], files)
    return abi2.audit_dependencies(fixture['_summary'], fixture['adapter'], files)


def expect_rejection(results, label, fixture, edited_files, expected_diagnostic):
    check(set(edited_files) == set(fixture['_files']), f'{label}: mutation changed the file inventory')
    changed = {name: {
        'beforeSha256': hashlib.sha256(fixture['_files'][name].encode('utf-8')).hexdigest(),
        'afterSha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
    } for name, text in edited_files.items() if text != fixture['_files'][name]}
    check(len(changed) == 1, f'{label}: expected one changed header, found {len(changed)}')
    try:
        audit_fixture(fixture, edited_files)
    except (abi1.Grammar, abi2.Grammar) as error:
        diagnostic = str(error)
        check(expected_diagnostic in diagnostic,
              f'{label}: rejected for the wrong reason; expected {expected_diagnostic!r}, got {diagnostic!r}')
        results.append({
            'name': label,
            'fixture': fixture['name'],
            'diagnostic': diagnostic,
            'expectedReason': expected_diagnostic,
            'mutatedFiles': changed,
        })
    else:
        raise RuntimeError(f'{label}: dependency audit unexpectedly accepted the mutated header')


def edited_wire(fixture, text):
    wire = fixture['adapter'][:-2] + '.wire.h'
    copied = dict(fixture['_files'])
    copied[wire] = text
    return copied


def toggle_annotation(results, fixture, function, size, reason):
    wire = fixture['adapter'][:-2] + '.wire.h'
    old = prefix_for(size) + f' int {function}('
    new = opposite_prefix(size) + f' int {function}('
    text = replace_once(fixture['_files'][wire], old, new, f'{fixture["name"]}:{function} annotation toggle')
    expected = reason
    expect_rejection(results, f'wrong annotation: {fixture["name"]}:{function}', fixture,
                     edited_wire(fixture, text), expected)


def declaration_line(fixture, function, prefix):
    wire = fixture['adapter'][:-2] + '.wire.h'
    matches = [line for line in fixture['_files'][wire].splitlines()
               if line.startswith(prefix + f' int {function}(') and line.rstrip().endswith('{')]
    check(len(matches) == 1, f'{fixture["name"]}:{function}: expected one emitted function header')
    return matches[0]


def function_header_line(header, function):
    matches = [line for line in header.splitlines()
               if f'{function}(' in line and line.rstrip().endswith('{')]
    check(len(matches) == 1, f'{function}: expected one emitted function definition header')
    return matches[0]


def prototype_before_definition(fixture, filename, function, definition_prefix, prototype_prefix, label):
    original_header = fixture['_files'][filename]
    original = function_header_line(original_header, function)
    check(original.startswith(definition_prefix + ' '),
          f'{label}: definition does not have expected prefix {definition_prefix!r}')
    prototype = replace_once(original[:-1], definition_prefix, prototype_prefix, label) + ';'
    mutated = replace_once(original_header, original, prototype + '\n' + original, label)
    files = dict(fixture['_files'])
    files[filename] = mutated
    return files


def run(manifest_path, output_path):
    check(z3.get_version_string() == '5.1.0',
          f'expected Z3 Python binding 5.1.0, found {z3.get_version_string()}')
    manifest = read_json(manifest_path)
    check(manifest.get('version') == 1, 'unsupported manifest version')
    check(manifest.get('scope') ==
          'ABI 1 and ABI 2 emitted-header dependency annotation and unique file-scope binding checks only',
          'manifest scope differs from this test')
    for filename, digest in manifest['sourceHashes'].items():
        check(sha256(filename) == digest, f'source changed before Python audit: {filename}')

    fixtures = load_fixtures(manifest)
    positives = [{'name': name, 'kind': 'emitted-baseline'} for name in sorted(fixtures)]

    # Harmless whitespace remains token-equivalent and accepted.
    small = fixtures['abi1-small']
    small_wire = small['adapter'][:-2] + '.wire.h'
    state_decode = small['_summary']['state_decode']
    whitespace_header = replace_once(
        small['_files'][small_wire], f'static inline int {state_decode}(',
        f'static \n  inline\tint {state_decode}(', 'ABI 1 harmless whitespace')
    audit_fixture(small, edited_wire(small, whitespace_header))
    positives.append({'name': 'abi1-small-whitespace', 'kind': 'harmless-whitespace'})

    mutations = []
    for fixture_name, state_width, instruction_width in (
        ('abi1-small', 5, 2), ('abi1-edge255', 255, 255), ('abi1-edge256', 256, 256),
    ):
        fixture = fixtures[fixture_name]
        summary = fixture['_summary']
        wire = fixture['adapter'][:-2] + '.wire.h'
        for label, name, width in (
            ('state decoder', summary['state_decode'], state_width),
            ('instruction decoder', summary['ix_decode'], instruction_width),
        ):
            expected_line = declaration_line(fixture, name, prefix_for(width))
            reason = f'dependencies: {wire} differs from the reviewed text near {expected_line[:48]!r}'
            toggle_annotation(mutations, fixture, name, width, reason)

    for fixture_name, instruction_width in (('abi2-instruction255', 255), ('abi2-instruction256', 256)):
        fixture = fixtures[fixture_name]
        summary = fixture['_summary']
        toggle_annotation(mutations, fixture, summary['ix_decode'], instruction_width,
                          f'dependencies: {summary["ix_decode"]} signature')
        if fixture_name == 'abi2-instruction255':
            for index, field_width in enumerate(summary['field_sizes']):
                toggle_annotation(mutations, fixture, summary['state_decoders'][index], field_width,
                                  f'dependencies: field {index} decoder signature')

    # Unsupported attributes must retain the auditor's early allowlist error.
    fixture = fixtures['abi1-edge256']
    wire = fixture['adapter'][:-2] + '.wire.h'
    name = fixture['_summary']['state_decode']
    old = prefix_for(256) + f' int {name}('
    new = 'static __attribute__((always_inline)) inline' + f' int {name}('
    text = replace_once(fixture['_files'][wire], old, new, 'ABI 1 unsupported attribute')
    expect_rejection(mutations, 'unsupported attribute: ABI 1 early allowlist', fixture, edited_wire(fixture, text),
                     f'dependencies: {wire}: unsupported attribute')

    fixture = fixtures['abi2-instruction256']
    wire = fixture['adapter'][:-2] + '.wire.h'
    name = fixture['_summary']['state_decoders'][1]
    old = prefix_for(256) + f' int {name}('
    new = 'static __attribute__((always_inline)) inline' + f' int {name}('
    text = replace_once(fixture['_files'][wire], old, new, 'ABI 2 unsupported attribute')
    expect_rejection(mutations, 'unsupported attribute: ABI 2 early allowlist', fixture, edited_wire(fixture, text),
                     f'dependencies: {wire}: unsupported attribute')

    # An accepted attribute in an unreviewed position still fails the exact
    # emitted signature check.
    fixture = fixtures['abi1-edge256']
    wire = fixture['adapter'][:-2] + '.wire.h'
    name = fixture['_summary']['state_decode']
    old = 'static __attribute__((noinline)) inline' + f' int {name}('
    new = '__attribute__((noinline)) static inline' + f' int {name}('
    text = replace_once(fixture['_files'][wire], old, new, 'ABI 1 reordered annotation')
    expect_rejection(mutations, 'reordered annotation: ABI 1', fixture, edited_wire(fixture, text),
                     f'dependencies: {wire} differs from the reviewed text near '
                     f'{declaration_line(fixture, name, prefix_for(256))[:48]!r}')

    fixture = fixtures['abi2-instruction256']
    wire = fixture['adapter'][:-2] + '.wire.h'
    name = fixture['_summary']['state_decoders'][1]
    old = 'static __attribute__((noinline)) inline' + f' int {name}('
    new = '__attribute__((noinline)) static inline' + f' int {name}('
    text = replace_once(fixture['_files'][wire], old, new, 'ABI 2 reordered annotation')
    expect_rejection(mutations, 'reordered annotation: ABI 2', fixture, edited_wire(fixture, text),
                     'dependencies: field 1 decoder signature')

    fixture = fixtures['abi1-small']
    wire = fixture['adapter'][:-2] + '.wire.h'
    name = fixture['_summary']['state_decode']
    text = f'#define {name} 1\n' + fixture['_files'][wire]
    expect_rejection(mutations, 'dependency macro decoy rewrites adapter call', fixture, edited_wire(fixture, text),
                     f'preprocessing: dependency macro {name!r}')

    # Each ABI 1 summarized codec function has one top-level binding. Conflicting
    # annotations on prototypes/definitions remain visible even if the reviewed
    # function body itself still matches exactly.
    fixture = fixtures['abi1-small']
    summary = fixture['_summary']
    wire = fixture['adapter'][:-2] + '.wire.h'
    prefix = opposite_prefix(summary['n'])
    prototype = (f'{prefix} int {summary["state_decode"]}(const unsigned char *p, unsigned long long n, '
                 f'{summary["state_type"]} *out);\n')
    text = fixture['_files'][wire] + prototype
    expect_rejection(mutations, 'ABI 1 state decoder conflicting prototype', fixture, edited_wire(fixture, text),
                     f'dependencies: ambiguous file-scope binding for {summary["state_decode"]}')

    fixture = fixtures['abi1-edge256']
    summary = fixture['_summary']
    wire = fixture['adapter'][:-2] + '.wire.h'
    original = declaration_line(fixture, summary['ix_decode'], prefix_for(summary['ix']))
    duplicate = replace_once(original, prefix_for(summary['ix']), opposite_prefix(summary['ix']),
                             'ABI 1 duplicate decoder body annotation') + '\n  return 0;\n}\n'
    text = fixture['_files'][wire] + '\n' + duplicate
    expect_rejection(mutations, 'ABI 1 instruction decoder duplicate body', fixture, edited_wire(fixture, text),
                     f'dependencies: ambiguous file-scope binding for {summary["ix_decode"]}')

    fixture = fixtures['abi1-small']
    summary = fixture['_summary']
    wire = fixture['adapter'][:-2] + '.wire.h'
    prototype = (f'static inline int {summary["state_encode"]}(unsigned char *p, unsigned long long n, '
                 f'const {summary["state_type"]} *value);\n')
    text = fixture['_files'][wire] + prototype
    expect_rejection(mutations, 'ABI 1 state encoder duplicate prototype', fixture, edited_wire(fixture, text),
                     f'dependencies: ambiguous file-scope binding for {summary["state_encode"]}')

    # ABI 2 already had uniqueness; preserve direct coverage for prototypes and
    # definitions while the ABI 1 implementation adopts the same reviewed helper.
    fixture = fixtures['abi2-instruction256']
    summary = fixture['_summary']
    wire = fixture['adapter'][:-2] + '.wire.h'
    name = summary['state_decoders'][0]
    prototype = (f'{opposite_prefix(summary["field_sizes"][0])} int {name}(const unsigned char *p, '
                 f'unsigned long long n, {summary["types"][summary["field_types"][0]]["cType"]} *out);\n')
    text = fixture['_files'][wire] + prototype
    expect_rejection(mutations, 'ABI 2 field decoder conflicting prototype', fixture, edited_wire(fixture, text),
                     f'dependencies: ambiguous file-scope binding for {name}')

    fixture = fixtures['abi2-instruction255']
    summary = fixture['_summary']
    wire = fixture['adapter'][:-2] + '.wire.h'
    name = summary['state_decoders'][1]
    original = declaration_line(fixture, name, prefix_for(summary['field_sizes'][1]))
    duplicate = replace_once(original, prefix_for(summary['field_sizes'][1]),
                             opposite_prefix(summary['field_sizes'][1]),
                             'ABI 2 duplicate field body annotation') + '\n  return 0;\n}\n'
    text = fixture['_files'][wire] + '\n' + duplicate
    expect_rejection(mutations, 'ABI 2 field decoder duplicate body', fixture, edited_wire(fixture, text),
                     f'dependencies: ambiguous file-scope binding for {name}')

    # Prototypes before definitions are the dangerous attribute-merging form:
    # Clang applies their inline attributes to the following maker/codec body.
    # Keep exact binding diagnostics so an unrelated text mismatch cannot pass.
    fixture = fixtures['abi1-small']
    summary = fixture['_summary']
    wire = fixture['adapter'][:-2] + '.wire.h'
    for label, name in (
        ('state decoder', summary['state_decode']),
        ('instruction decoder', summary['ix_decode']),
    ):
        files = prototype_before_definition(fixture, wire, name, 'static inline',
                                            'static __attribute__((noinline)) inline',
                                            f'ABI 1 {label} before-definition prototype')
        expect_rejection(mutations, f'ABI 1 {label} before-definition prototype', fixture, files,
                         f'dependencies: ambiguous file-scope binding for {name}')

    files = prototype_before_definition(fixture, wire, summary['state_encode'], 'static inline',
                                        'static __attribute__((noinline)) inline',
                                        'ABI 1 state encoder before-definition prototype')
    expect_rejection(mutations, 'ABI 1 state encoder before-definition prototype', fixture, files,
                     f'dependencies: ambiguous file-scope binding for {summary["state_encode"]}')

    native = fixture['adapter'][:-2] + '.h'
    for label, name in (
        ('context maker', summary['context_maker']),
        ('key maker', summary['key_maker']),
        ('slot maker', summary['slot_maker']),
    ):
        files = prototype_before_definition(fixture, native, name, 'static inline',
                                            'static __attribute__((noinline)) inline',
                                            f'ABI 1 {label} before-definition prototype')
        expect_rejection(mutations, f'ABI 1 {label} before-definition prototype', fixture, files,
                         f'dependencies: ambiguous file-scope binding for {name}')

    files = prototype_before_definition(fixture, native, summary['root'],
                                        'static __attribute__((noinline))', 'static inline',
                                        'ABI 1 root before-definition prototype')
    expect_rejection(mutations, 'ABI 1 root before-definition prototype', fixture, files,
                     f'dependencies: ambiguous file-scope binding for {summary["root"]}')

    # Comment text containing binding names stays harmless alongside the
    # existing whitespace-positive control above.
    comment = (f'/* static __attribute__((noinline)) inline {summary["key_maker"]}(...) */\n'
               f'// {summary["root"]}(...) is documentation, not a declaration.\n')
    commented_files = dict(fixture['_files'])
    commented_files[native] = comment + commented_files[native]
    audit_fixture(fixture, commented_files)
    positives.append({'name': 'abi1-small-comments', 'kind': 'commented-binding-names'})

    check(len(positives) == 7, 'positive-control count')
    check(len(mutations) == 27, f'expected 27 negative controls, found {len(mutations)}')

    for filename, digest in manifest['sourceHashes'].items():
        check(sha256(filename) == digest, f'source changed during Python audit: {filename}')

    output = {
        'version': 1,
        'passed': True,
        'scope': manifest['scope'],
        'fixtures': [{
            'name': name,
            'abi': fixtures[name]['abi'],
            'schemaSha256': sha256(fixtures[name]['schema']),
            'interfaceSha256': sha256(fixtures[name]['interface']),
            'wireSha256': fixtures[name]['archiveHashes'][name + '.wire.h'],
            'expectedLayout': fixtures[name]['_expected'],
            'observedLayout': {
                'n': fixtures[name]['_summary']['n'],
                'ix': fixtures[name]['_summary']['ix'],
                **({'fieldSizes': fixtures[name]['_summary']['field_sizes']}
                   if fixtures[name]['abi'] == 2 else {}),
            },
        } for name in sorted(fixtures)],
        'positives': positives,
        'mutations': mutations,
        'sourceHashes': manifest['sourceHashes'],
        'sourceHashesUnchanged': True,
        'pythonVersion': sys.version.split()[0],
        'z3Version': z3.get_version_string(),
        'limits': [
            'No claim about codec body correctness or a codec theorem.',
            'No claim about C compilation, LLVM, SBF, runtime behavior, stack use or call depth.',
            'No full ABI 1/ABI 2 symbolic adapter contract or end-to-end compiler claim.',
        ],
    }
    output_path = pathlib.Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(f"Focused dependency audit passed: {len(output['fixtures'])} fixtures, "
          f"{len(output['mutations'])} expected rejections.")


def main():
    check(len(sys.argv) == 3, 'usage: adapter-codec-bindings.py MANIFEST OUTPUT')
    run(sys.argv[1], sys.argv[2])


if __name__ == '__main__':
    main()
