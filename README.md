# Klipper Config + Formatter

Rich language support for Klipper configuration files and Klipper-flavored
GCode, plus a **whitespace-safe formatter** and **Jinja block diagnostics**.

A fork of [dannymcgee/vscode-klipper](https://github.com/dannymcgee/vscode-klipper).
All syntax highlighting is his work, unchanged; this fork adds the formatter and
the "Diagnostics" item from that project's roadmap.

## Formatting

Klipper configs are INI with Jinja2 embedded in every `gcode:` block, and the
Jinja is not stock Jinja — Klipper builds its environment as

```python
jinja2.Environment('{%', '%}', '{', '}')
```

so expressions take a **single** brace. `{printer.extruder.target}` is an
expression, and `{{'restore': restore, 'temp': temp}}` is an expression wrapping
a dict literal, not a `{{ }}` output tag. That combination is why a generic INI
or Jinja formatter mangles a `printer.cfg`.

Format Document, format-on-save, and three commands:

| Command | Purpose |
| --- | --- |
| `Klipper: Format All .cfg Files in Workspace` | Bulk cleanup. Asks before writing, and reports anything the safety check rejected. |
| `Klipper: Preview Formatting of All .cfg Files (dry run)` | Lists which files would change and by how many lines. Writes nothing. |
| `Klipper: Check Jinja Block Balance in Workspace` | Scans every `.cfg` and fills the Problems panel. |

The workspace format leaves files **dirty** and offers to save, so an unexpected
result can be undone before it reaches disk.

## Safety

The formatter may only move whitespace, and that is enforced rather than assumed.
Every run reduces input and output to the tokens Klipper actually reads and
compares them; if a single token moved, **the format is abandoned and the file is
returned untouched**. A file that comes back unchanged beats one that comes back
subtly different.

Three cases get specific care:

- **A continuation line never reaches column 0.** `configparser` reads a
  column-0 line as a new option, which would silently truncate a `gcode:` block.
- **Wrapped tags keep their alignment.** A `{% set %}` spanning lines is shifted
  by exactly what its opening line moved, so alignment under a dict literal or a
  wrapped boolean survives.
- **`{% raw %}` content is left alone.**

`tools/verify-parity.py` proves this end to end: it formats every file, then
parses original and result with the same parser Klipper uses and compares every
option value.

```
$ npm test && npm run verify-parity
49 files, 1155 options compared.
3 option(s) differ only by collapsed blank lines (no effect on G-code).
PASS: every option parses identically before and after formatting.
```

## Diagnostics

Reports an `{% if %}` with no `{% endif %}`, a closer that does not match its
opener, a stray `{% else %}`, and unterminated `{% ... %}` tags — as you type.
Klipper only surfaces a template error when the macro first runs, which in
practice means mid-print.

## Settings

All under `klipperFormatter.*`: `indentSize` (4), `jinjaIndentSize` (0 = use
`indentSize`), `indentJinjaBlocks`, `normalizeSeparatorSpacing`,
`maxConsecutiveBlankLines`, `blankLinesBeforeSection`, `trimLeadingBlankLines`,
`diagnostics.enabled`, and `exclude`.

Vendor-managed trees are worth excluding, since reformatting them only creates
conflicts when they are next updated:

```jsonc
"klipperFormatter.exclude": ["**/mmu/**", "**/timelapse.cfg"]
```

To format on save:

```jsonc
"[klipper-cfg]": { "editor.formatOnSave": true }
```

On a large tree, `editor.formatOnSaveMode: "modifications"` reformats only the
lines you touched, so a bulk reindent never lands by accident.

## Building

```sh
npm install
npm test                 # 30 tests, no VS Code harness needed
npm run build            # nx build -> dist/packages/vscode-klipper/*.vsix, and installs it
npm run verify-parity    # needs test-configs/
```

`test-configs/` is not committed — it holds a real printer's config. The corpus
test and the parity script skip when it is absent. Populate it with:

```sh
rsync -a --include='*/' --include='*.cfg' --exclude='*' \
  <printer>:/home/klipper/printer_data/config/ test-configs/
```

## Icon

The icon is the upstream `dannymcgee.klipper` icon with a brace mark laid over
the V's opening -- Klipper's single-brace `{expr}` syntax wrapped around
indented config lines. `tools/make-icons.py` renders every variant to its own
file under `tools/icon-assets/`; `--use <name>` promotes one to the shipped
`packages/klipper/src/assets/icon.png`.

## Licence

MIT. Copyright 2023 Danny McGee for the original work; see `LICENSE`.
