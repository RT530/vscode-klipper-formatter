#!/usr/bin/env python3
"""Proves the formatter cannot change what Klipper executes.

Formats every .cfg under a directory, then parses the original and the result
with the same parser Klipper uses -- configparser.RawConfigParser(strict=False,
inline_comment_prefixes=(';', '#')) -- and compares every option value.

Klipper strips each continuation line of a multi-line value before joining it,
so the comparison normalises the same way: what is compared is the G-code
Klipper would actually run.

    python3 scripts/verify-parity.py test-configs

Exits non-zero if any option value differs.
"""
import configparser
import io
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Compiled by `npm test` (tsc -p packages/klipper/tsconfig.spec.json).
FORMATTER = os.path.join(ROOT, 'dist', 'spec', 'formatter.js')


def format_tree(src, dst):
    script = """
const fs=require('fs'),path=require('path');
const {formatKlipperConfig}=require(process.argv[2]);
const src=process.argv[3],dst=process.argv[4];const aborted=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){
 const f=path.join(d,e.name);
 if(e.isDirectory())walk(f);
 else if(e.name.endsWith('.cfg')){
  const r=formatKlipperConfig(fs.readFileSync(f,'utf8'));
  if(r.aborted)aborted.push(path.relative(src,f)+': '+r.reason);
  const o=path.join(dst,path.relative(src,f));
  fs.mkdirSync(path.dirname(o),{recursive:true});
  fs.writeFileSync(o,r.text);}}})(src);
console.log(JSON.stringify(aborted));
"""
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as fh:
        fh.write(script)
        tmp = fh.name
    try:
        out = subprocess.run(
            ['node', tmp, FORMATTER, src, dst],
            capture_output=True, text=True, check=True).stdout
        return json.loads(out.strip().splitlines()[-1])
    finally:
        os.unlink(tmp)


def parse(path, ignore_blank_lines):
    cp = configparser.RawConfigParser(strict=False, inline_comment_prefixes=(';', '#'))
    with open(path, encoding='utf-8') as fh:
        cp.read_file(io.StringIO(fh.read()), path)
    result = {}
    for section in cp.sections():
        result[section] = {}
        for key, value in cp.items(section):
            lines = [ln.strip() for ln in (value or '').split('\n')]
            if ignore_blank_lines:
                lines = [ln for ln in lines if ln]
            else:
                while lines and not lines[-1]:
                    lines.pop()
            result[section][key] = '\n'.join(lines)
    return result


def main():
    src = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else 'test-configs')
    if not os.path.isdir(src):
        sys.exit(f'not a directory: {src}')
    if not os.path.exists(FORMATTER):
        sys.exit(f'{FORMATTER} is missing -- run `npm test` first to compile it.')

    with tempfile.TemporaryDirectory() as dst:
        aborted = format_tree(src, dst)
        if aborted:
            print('Safety check rejected these files (left unchanged):')
            for entry in aborted:
                print('  ' + entry)

        failures = []
        options = 0
        blank_only = 0
        files = 0

        for root, _, names in os.walk(src):
            for name in sorted(names):
                if not name.endswith('.cfg'):
                    continue
                files += 1
                original = os.path.join(root, name)
                formatted = os.path.join(dst, os.path.relpath(original, src))
                rel = os.path.relpath(original, src)

                strict_a, strict_b = parse(original, False), parse(formatted, False)
                loose_a, loose_b = parse(original, True), parse(formatted, True)

                if set(loose_a) != set(loose_b):
                    failures.append(f'{rel}: sections differ')
                    continue
                for section in loose_a:
                    if set(loose_a[section]) != set(loose_b[section]):
                        failures.append(f'{rel} [{section}]: keys differ')
                        continue
                    for key in loose_a[section]:
                        options += 1
                        if loose_a[section][key] != loose_b[section][key]:
                            failures.append(f'{rel} [{section}] {key}: value changed')
                        elif strict_a[section][key] != strict_b[section][key]:
                            blank_only += 1

        print(f'{files} files, {options} options compared.')
        print(f'{blank_only} option(s) differ only by collapsed blank lines (no effect on G-code).')
        if failures:
            print(f'\nFAIL: {len(failures)} option(s) changed:')
            for entry in failures[:40]:
                print('  ' + entry)
            sys.exit(1)
        print('PASS: every option parses identically before and after formatting.')


if __name__ == '__main__':
    main()
