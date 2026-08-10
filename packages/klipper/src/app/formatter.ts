/**
 * Whitespace-only formatter for Klipper `.cfg` files.
 *
 * The engine has no `vscode` import so it can be unit tested as plain Node.
 *
 * Design constraint: this runs against configs for a machine that melts plastic
 * at 250C, so the formatter is only ever allowed to move whitespace. Every
 * result is checked against the input (see `canonicalize`) and the format is
 * abandoned wholesale if a single token moved. A config that comes back
 * unchanged is always preferable to one that comes back subtly different.
 */

import { initialScanState, scanLine, ScanState, CLOSER_FOR } from "./scanner";

export interface FormatOptions {
	/** Spaces for one level of indent inside a multi-line value. */
	indentSize: number;
	/** Spaces added per nested Jinja block; 0 means "use indentSize". */
	jinjaIndentSize: number;
	/** Indent `{% if %}` / `{% for %}` bodies. */
	indentJinjaBlocks: boolean;
	/** Rewrite `key   : value` as `key: value`. */
	normalizeSeparatorSpacing: boolean;
	maxConsecutiveBlankLines: number;
	blankLinesBeforeSection: number;
	trimLeadingBlankLines: boolean;
}

export const defaultOptions: FormatOptions = {
	indentSize: 4,
	jinjaIndentSize: 0,
	indentJinjaBlocks: true,
	normalizeSeparatorSpacing: true,
	maxConsecutiveBlankLines: 1,
	blankLinesBeforeSection: 1,
	trimLeadingBlankLines: true,
};

export interface FormatResult {
	text: string;
	changed: boolean;
	/** Set when the safety check rejected the result; `text` is then the input. */
	aborted: boolean;
	reason?: string;
}

export interface BlockProblem {
	/** 0-based line. */
	line: number;
	column: number;
	endColumn: number;
	message: string;
	severity: "error" | "warning";
}

type LineKind = "blank" | "section" | "comment" | "key" | "value" | "continuation" | "orphan";

const SECTION_RE = /^\[[^\]]*\]/;
const KEY_RE = /^([^:=\[#;][^:=]*?)\s*([:=])\s*(.*)$/;

/**
 * Reduces a document to the tokens that matter to Klipper, so two versions can
 * be compared while ignoring exactly the whitespace the formatter is allowed to
 * touch.
 *
 * Klipper parses with `configparser.RawConfigParser`, which strips each
 * continuation line of a multi-line value before joining it, so leading and
 * trailing whitespace inside a `gcode:` block carries no meaning. Blank lines
 * are dropped here for the same reason.
 */
function canonicalize(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const trimmed = raw.trim();
		if (trimmed === "") {
			continue;
		}
		const topLevel = !/^\s/.test(raw);
		if (topLevel && !SECTION_RE.test(trimmed) && !/^[#;]/.test(trimmed)) {
			const m = KEY_RE.exec(trimmed);
			if (m) {
				out.push(`${m[1].trim()}${m[2]}${m[3].trim()}`);
				continue;
			}
		}
		out.push(trimmed);
	}
	return out;
}

function detectEol(text: string): string {
	return /\r\n/.test(text) ? "\r\n" : "\n";
}

function leadingWhitespace(line: string): string {
	return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** Visual width of an indent, counting a tab as one indent level. */
function indentWidth(ws: string, tabSize: number): number {
	let w = 0;
	for (const ch of ws) {
		w += ch === "\t" ? tabSize : 1;
	}
	return w;
}

function normalizeKeyLine(trimmed: string, enabled: boolean): string {
	if (!enabled) {
		return trimmed;
	}
	const m = KEY_RE.exec(trimmed);
	if (!m) {
		return trimmed;
	}
	const key = m[1].trim();
	const sep = m[2];
	const value = m[3];
	// `:` binds tight, `=` gets spaces on both sides -- the same shape
	// configparser writes when Klipper's save_variables rewrites variables.cfg.
	if (value === "") {
		return `${key}${sep}`;
	}
	return sep === "=" ? `${key} = ${value}` : `${key}: ${value}`;
}

export function formatKlipperConfig(
	text: string,
	optionsIn: Partial<FormatOptions> = {}
): FormatResult {
	const opts: FormatOptions = { ...defaultOptions, ...optionsIn };
	const eol = detectEol(text);
	const lines = text.split(/\r?\n/);

	const baseUnit = " ".repeat(opts.indentSize);
	const jinjaStep = opts.jinjaIndentSize > 0 ? opts.jinjaIndentSize : opts.indentSize;

	// A run of column-0 comments sitting directly on top of a [section] header
	// documents that header, so the blank line separating sections belongs above
	// the comment rather than between the comment and the header.
	const opensSection = new Array<boolean>(lines.length).fill(false);
	for (let i = 0; i < lines.length; i++) {
		const t = lines[i].trim();
		if (t === "" || !/^[#;]/.test(t) || /^\s/.test(lines[i])) {
			continue;
		}
		if (i > 0) {
			const prev = lines[i - 1].trim();
			if (prev !== "" && /^[#;]/.test(prev) && !/^\s/.test(lines[i - 1])) {
				continue; // not the first comment of the run
			}
		}
		for (let j = i; j < lines.length; j++) {
			const tj = lines[j].trim();
			if (tj !== "" && /^[#;]/.test(tj) && !/^\s/.test(lines[j])) {
				continue;
			}
			if (SECTION_RE.test(tj)) {
				opensSection[i] = true;
			}
			break;
		}
	}

	const out: string[] = [];
	let state: ScanState = initialScanState();
	let jinjaDepth = 0;
	let afterKey = false;
	let pendingBlanks = 0;
	let lastKind: LineKind | "none" = "none";
	/** Column delta applied to lines continuing an unterminated construct. */
	let continuationShift = 0;

	const flushBlanks = (upcoming: LineKind, index: number) => {
		let count = Math.min(pendingBlanks, opts.maxConsecutiveBlankLines);
		if (out.length === 0) {
			count = opts.trimLeadingBlankLines ? 0 : count;
		} else if (upcoming === "comment" && opensSection[index]) {
			count = Math.max(count, opts.blankLinesBeforeSection);
		} else if (upcoming === "section" && lastKind !== "comment" && lastKind !== "section") {
			// A comment sitting directly above a header documents it, so no blank
			// line is forced between the two. Neither is one forced between two bare
			// headers: `[pause_resume]` / `[display_status]` / `[respond]` are
			// conventionally grouped, and the first of them has no options to
			// separate anyway.
			count = Math.max(count, opts.blankLinesBeforeSection);
		}
		for (let i = 0; i < count; i++) {
			out.push("");
		}
		pendingBlanks = 0;
	};

	for (let index = 0; index < lines.length; index++) {
		const raw = lines[index];
		if (raw.trim() === "") {
			pendingBlanks++;
			continue;
		}

		const ws = leadingWhitespace(raw);
		const origIndent = indentWidth(ws, opts.indentSize);
		const trimmed = raw.trim();
		const carriedOpen = state.inTag || state.inComment || state.exprDepth > 0;

		let kind: LineKind;
		if (carriedOpen) {
			kind = "continuation";
		} else if (origIndent === 0) {
			if (SECTION_RE.test(trimmed)) {
				kind = "section";
			} else if (/^[#;]/.test(trimmed)) {
				kind = "comment";
			} else if (KEY_RE.test(trimmed)) {
				kind = "key";
			} else {
				kind = "orphan";
			}
		} else {
			kind = afterKey ? "value" : "orphan";
		}

		flushBlanks(kind, index);

		switch (kind) {
			case "section": {
				out.push(trimmed);
				state = initialScanState();
				jinjaDepth = 0;
				afterKey = false;
				break;
			}

			case "comment": {
				out.push(trimmed);
				break;
			}

			case "key": {
				const line = normalizeKeyLine(trimmed, opts.normalizeSeparatorSpacing);
				out.push(line);
				state = initialScanState();
				jinjaDepth = 0;
				afterKey = true;
				// A value can begin on the key line and run over, e.g.
				//   variable_park: {'x': 10,
				//                   'y': 20}
				const scan = scanLine(line, state);
				state = scan.state;
				jinjaDepth = Math.max(0, jinjaDepth + scan.net);
				if (scan.endedOpen) {
					continuationShift = line.length - raw.length;
				}
				break;
			}

			case "value": {
				const scan = scanLine(trimmed, state);
				let depth = jinjaDepth;
				const lead = scan.leadingTag;
				if (
					opts.indentJinjaBlocks &&
					lead &&
					(lead.role === "close" || lead.role === "middle")
				) {
					depth--;
				}
				depth = Math.max(0, depth);

				const indent = opts.indentJinjaBlocks
					? baseUnit + " ".repeat(jinjaStep * depth)
					: baseUnit;

				out.push(indent + trimmed);
				state = scan.state;
				jinjaDepth = Math.max(0, jinjaDepth + scan.net);
				if (scan.endedOpen) {
					continuationShift = indent.length - origIndent;
				}
				break;
			}

			case "continuation": {
				// Hand-aligned dict literals and wrapped boolean expressions live here.
				// Their internal alignment is preserved by shifting them exactly as far
				// as the line that opened the construct moved. A continuation may never
				// reach column 0: configparser would read it as a new option and the
				// value would silently lose everything after this point.
				const width = Math.max(1, origIndent + continuationShift);
				const scan = scanLine(trimmed, state);
				out.push(" ".repeat(width) + trimmed);
				state = scan.state;
				jinjaDepth = Math.max(0, jinjaDepth + scan.net);
				break;
			}

			case "orphan": {
				// Not something the grammar accounts for -- indentation is left alone
				// so nothing is guessed at.
				out.push(ws + trimmed);
				break;
			}
		}

		lastKind = kind;
	}

	let result = out.join(eol);
	if (result !== "") {
		result += eol;
	}

	const before = canonicalize(text);
	const after = canonicalize(result);
	if (before.length !== after.length) {
		return {
			text,
			changed: false,
			aborted: true,
			reason: `line count changed (${before.length} -> ${after.length})`,
		};
	}
	for (let i = 0; i < before.length; i++) {
		if (before[i] !== after[i]) {
			return {
				text,
				changed: false,
				aborted: true,
				reason: `content changed near "${before[i].slice(0, 60)}"`,
			};
		}
	}

	return { text: result, changed: result !== text, aborted: false };
}

/**
 * Reports unbalanced Jinja blocks.
 *
 * Klipper reports a template error only when the macro is first rendered, which
 * in practice means mid-print. Catching it in the editor is the entire point.
 */
export function findBlockProblems(text: string): BlockProblem[] {
	const problems: BlockProblem[] = [];
	const lines = text.split(/\r?\n/);

	let state: ScanState = initialScanState();
	let afterKey = false;
	const stack: { name: string; line: number; col: number }[] = [];
	let openTagLine = -1;
	let openTagCol = -1;

	const closeSection = () => {
		for (const open of stack) {
			problems.push({
				line: open.line,
				column: open.col,
				endColumn: open.col + open.name.length + 5,
				message: `{% ${open.name} %} is never closed -- expected a matching {% end${open.name} %}.`,
				severity: "error",
			});
		}
		stack.length = 0;
		if (state.inTag && openTagLine >= 0) {
			problems.push({
				line: openTagLine,
				column: openTagCol,
				endColumn: openTagCol + 2,
				message: "Unterminated {% ... %} tag -- no closing %} was found.",
				severity: "error",
			});
		}
		state = initialScanState();
		openTagLine = -1;
	};

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		if (raw.trim() === "") {
			continue;
		}
		const carriedOpen = state.inTag || state.inComment || state.exprDepth > 0;
		const origIndent = leadingWhitespace(raw).length;
		const trimmed = raw.trim();

		if (!carriedOpen && origIndent === 0) {
			if (SECTION_RE.test(trimmed)) {
				closeSection();
				afterKey = false;
				continue;
			}
			if (/^[#;]/.test(trimmed)) {
				continue;
			}
			if (KEY_RE.test(trimmed)) {
				closeSection();
				afterKey = true;
				const scan = scanLine(raw, state);
				state = scan.state;
				if (state.inTag) {
					openTagLine = i;
					openTagCol = raw.length;
				}
				continue;
			}
			continue;
		}

		if (!afterKey && !carriedOpen) {
			continue;
		}

		const wasInTag = state.inTag;
		const scan = scanLine(raw, state);
		for (const tag of scan.tags) {
			const col = tag.col >= 0 ? tag.col : origIndent;
			if (tag.role === "open") {
				stack.push({ name: tag.name, line: i, col });
			} else if (tag.role === "close") {
				const expected = CLOSER_FOR.get(tag.name);
				const top = stack[stack.length - 1];
				if (!top) {
					problems.push({
						line: i,
						column: col,
						endColumn: col + tag.name.length + 5,
						message: `{% ${tag.name} %} has no matching {% ${expected ?? "block"} %}.`,
						severity: "error",
					});
				} else if (expected && top.name !== expected) {
					problems.push({
						line: i,
						column: col,
						endColumn: col + tag.name.length + 5,
						message: `{% ${tag.name} %} closes {% ${top.name} %}, opened on line ${
							top.line + 1
						}.`,
						severity: "error",
					});
					stack.pop();
				} else {
					stack.pop();
				}
			} else if (tag.role === "middle" && stack.length === 0) {
				problems.push({
					line: i,
					column: col,
					endColumn: col + tag.name.length + 5,
					message: `{% ${tag.name} %} is outside any {% if %} or {% for %} block.`,
					severity: "error",
				});
			}
		}
		state = scan.state;
		if (state.inTag && !wasInTag) {
			openTagLine = i;
			openTagCol = raw.length;
		}
	}

	closeSection();
	problems.sort((a, b) => a.line - b.line || a.column - b.column);
	return problems;
}
