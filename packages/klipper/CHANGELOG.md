# Changelog

## 0.3.0

First release of this fork. Everything before 0.3.0 is the upstream history of
[dannymcgee/vscode-klipper](https://github.com/dannymcgee/vscode-klipper), whose
syntax highlighting this builds on unchanged.

### Added

- **Formatter** for `klipper-cfg` — Format Document, format-on-save, and range
  formatting. Understands Klipper's Jinja environment, which is built as
  `jinja2.Environment('{%', '%}', '{', '}')`, so expressions take a single brace
  and `{{'a': 1}}` is a dict inside an expression rather than an output tag.
- **Diagnostics** for unbalanced Jinja blocks — an `{% if %}` with no
  `{% endif %}`, a closer that doesn't match its opener, a stray `{% else %}`,
  and unterminated `{% ... %}` tags. Klipper only reports a template error when
  the macro first runs, which in practice means mid-print.
- **Commands**: format every `.cfg` in the workspace, a dry-run preview of the
  same, and a workspace-wide Jinja block check.
- **Settings** under `klipperFormatter.*`, including `exclude` globs for
  vendor-managed trees.
- `indentationRules` and `folding` markers for `klipper-cfg`, so auto-indent
  while typing agrees with the formatter.

### Safety

The formatter may only move whitespace, and this is enforced rather than
assumed: every run reduces input and output to the tokens Klipper actually reads
and compares them, abandoning the format and returning the file untouched if a
single token moved. Continuation lines are clamped so they can never reach
column 0, where `configparser` would read them as a new option and silently
truncate the value. Wrapped `{% set %}` tags keep their hand alignment.

`tools/verify-parity.py` checks this end to end against a real config tree by
parsing before and after with the same parser Klipper uses. Across 49 files,
all 1155 options parse identically.

## 0.2.2 and earlier

See the [upstream releases](https://github.com/dannymcgee/vscode-klipper/releases).
