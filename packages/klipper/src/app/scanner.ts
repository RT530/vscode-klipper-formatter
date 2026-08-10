/**
 * Lexical state machine for Klipper `.cfg` files.
 *
 * Klipper builds its template environment as
 *
 *     jinja2.Environment('{%', '%}', '{', '}')
 *
 * so expressions are delimited by a *single* brace: `{printer.extruder.target}`.
 * A dict literal therefore shows up as `{{'restore': restore, 'temp': temp}}` --
 * an expression `{...}` wrapping a dict `{...}`, not a Jinja `{{ }}` output tag.
 * Any formatter that assumes stock Jinja delimiters mangles these, which is the
 * main reason a generic Jinja/INI formatter cannot be pointed at a printer.cfg.
 *
 * The scanner is deliberately character-oriented rather than regex-driven so it
 * can carry state across physical lines: a `{% set %}` tag may span several
 * lines, and those continuation lines carry hand-aligned dict literals that must
 * not be re-indented.
 */

/** Scanner state carried from one physical line to the next. */
export interface ScanState {
	/** Inside a `{% ... %}` tag whose `%}` has not been seen yet. */
	inTag: boolean;
	/** Inside a `{# ... #}` Jinja comment. */
	inComment: boolean;
	/** Inside a `{% raw %}` ... `{% endraw %}` region. */
	inRaw: boolean;
	/** Depth of unclosed single-brace `{ ... }` expressions. */
	exprDepth: number;
	/** Active quote character while inside a tag or expression. */
	quote: string | null;
	/** Accumulated body of the tag currently being read. */
	tagBuf: string;
}

export function initialScanState(): ScanState {
	return {
		inTag: false,
		inComment: false,
		inRaw: false,
		exprDepth: 0,
		quote: null,
		tagBuf: "",
	};
}

export function cloneScanState(s: ScanState): ScanState {
	return { ...s };
}

/** Whether a tag opens a block, closes one, continues one, or stands alone. */
export type TagRole = "open" | "close" | "middle" | "neutral";

export interface TagToken {
	/** Keyword that opened the tag, e.g. `if`, `endfor`, `set`. */
	name: string;
	role: TagRole;
	/** Column the tag's `{%` sat at, or -1 when it began on an earlier line. */
	col: number;
}

export interface LineScan {
	tags: TagToken[];
	/** State after consuming the line. */
	state: ScanState;
	/**
	 * The line's first tag, but only when the tag *began* on this line with
	 * nothing but whitespace in front of it. This is what decides whether the
	 * line dedents itself (`{% endif %}`, `{% else %}`).
	 */
	leadingTag: TagToken | null;
	/** The line ends mid-tag, mid-comment or mid-expression. */
	endedOpen: boolean;
	/** Net block-depth change contributed by the line. */
	net: number;
}

const OPENERS = new Set([
	"if",
	"for",
	"macro",
	"block",
	"filter",
	"call",
	"raw",
	"with",
	"trans",
	"autoescape",
]);

const CLOSERS = new Set([
	"endif",
	"endfor",
	"endmacro",
	"endblock",
	"endfilter",
	"endcall",
	"endraw",
	"endwith",
	"endtrans",
	"endautoescape",
	"endset",
]);

const MIDDLES = new Set(["else", "elif", "pluralize"]);

/** Maps a closing keyword back to the opener it terminates. */
export const CLOSER_FOR = new Map<string, string>([
	["endif", "if"],
	["endfor", "for"],
	["endmacro", "macro"],
	["endblock", "block"],
	["endfilter", "filter"],
	["endcall", "call"],
	["endraw", "raw"],
	["endwith", "with"],
	["endtrans", "trans"],
	["endautoescape", "autoescape"],
	["endset", "set"],
]);

/**
 * Classifies a tag from its body.
 *
 * `{% set x = 1 %}` assigns and stands alone; `{% set x %}...{% endset %}` opens
 * a block. They are told apart by a top-level `=` that is not part of a
 * comparison operator.
 */
export function classifyTag(body: string): TagToken {
	const trimmed = body
		.replace(/^[-+]\s*/, "")
		.replace(/\s*[-+]$/, "")
		.trim();
	const name = (/^([A-Za-z_][A-Za-z0-9_]*)/.exec(trimmed)?.[1] ?? "").toLowerCase();

	if (name === "set") {
		const rest = trimmed.slice(3);
		const assigns = /(?<![=!<>])=(?!=)/.test(stripStrings(rest));
		return { name: "set", role: assigns ? "neutral" : "open", col: -1 };
	}
	if (OPENERS.has(name)) {
		return { name, role: "open", col: -1 };
	}
	if (CLOSERS.has(name)) {
		return { name, role: "close", col: -1 };
	}
	if (MIDDLES.has(name)) {
		return { name, role: "middle", col: -1 };
	}
	return { name, role: "neutral", col: -1 };
}

/** Blanks out quoted runs so operator detection ignores string contents. */
function stripStrings(s: string): string {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === quote) {
				quote = null;
			}
			continue;
		}
		if (c === '"' || c === "'") {
			quote = c;
			continue;
		}
		out += c;
	}
	return out;
}

/**
 * True when a `#` or `;` at `i` starts a config comment.
 *
 * Klipper reads its files with `configparser.RawConfigParser(..., inline_comment_prefixes=(';', '#'))`,
 * and configparser only honours an inline prefix at the start of a line or after
 * whitespace. Matching that rule keeps `{#`, `M117 #3` and similar from being
 * mistaken for comments.
 */
function startsComment(line: string, i: number): boolean {
	const c = line[i];
	if (c !== "#" && c !== ";") {
		return false;
	}
	return i === 0 || /\s/.test(line[i - 1]);
}

/**
 * Consumes one physical line, returning the tags it completed and the state the
 * next line inherits.
 */
export function scanLine(line: string, prev: ScanState): LineScan {
	const state = cloneScanState(prev);
	const tags: TagToken[] = [];
	let leadingTag: TagToken | null = null;
	let tagCol = state.inTag ? -1 : 0;

	let i = 0;
	const n = line.length;

	while (i < n) {
		const c = line[i];
		const pair = line.substr(i, 2);

		// --- inside a quoted string (only reachable within a tag or expression) ---
		if (state.quote) {
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === state.quote) {
				state.quote = null;
			}
			if (state.inTag) {
				state.tagBuf += c;
			}
			i++;
			continue;
		}

		// --- inside a {# Jinja comment #} ---
		if (state.inComment) {
			if (pair === "#}") {
				state.inComment = false;
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		// --- inside a {% tag %} ---
		if (state.inTag) {
			if (pair === "%}") {
				const tok = classifyTag(state.tagBuf);
				tok.col = tagCol;
				const wasRaw = state.inRaw;
				state.inTag = false;
				state.tagBuf = "";

				if (tok.name === "raw" && tok.role === "open") {
					state.inRaw = true;
				} else if (tok.name === "endraw") {
					state.inRaw = false;
				}

				// Inside {% raw %} everything but {% endraw %} is literal text and must
				// not move the block depth.
				if (wasRaw && tok.name !== "endraw") {
					i += 2;
					continue;
				}

				tags.push(tok);
				if (leadingTag === null && tok.col >= 0 && line.slice(0, tok.col).trim() === "") {
					leadingTag = tok;
				}
				i += 2;
				continue;
			}
			if (c === '"' || c === "'") {
				state.quote = c;
			}
			state.tagBuf += c;
			i++;
			continue;
		}

		// --- inside a {% raw %} region: only {% endraw %} matters ---
		if (state.inRaw) {
			if (pair === "{%") {
				state.inTag = true;
				state.tagBuf = "";
				tagCol = i;
				i += 2;
				continue;
			}
			i++;
			continue;
		}

		// --- ordinary text, or inside a single-brace expression ---
		if (pair === "{%") {
			state.inTag = true;
			state.tagBuf = "";
			tagCol = i;
			i += 2;
			continue;
		}
		if (pair === "{#") {
			state.inComment = true;
			i += 2;
			continue;
		}
		if (c === "{") {
			state.exprDepth++;
			i++;
			continue;
		}
		if (c === "}") {
			if (state.exprDepth > 0) {
				state.exprDepth--;
			}
			i++;
			continue;
		}
		if (state.exprDepth > 0 && (c === '"' || c === "'")) {
			state.quote = c;
			i++;
			continue;
		}
		if (state.exprDepth === 0 && startsComment(line, i)) {
			// Rest of the line is a comment; nothing after it can affect state.
			break;
		}
		i++;
	}

	let net = 0;
	for (const t of tags) {
		if (t.role === "open") {
			net++;
		} else if (t.role === "close") {
			net--;
		}
	}

	return {
		tags,
		state,
		leadingTag,
		endedOpen: state.inTag || state.inComment || state.exprDepth > 0,
		net,
	};
}
