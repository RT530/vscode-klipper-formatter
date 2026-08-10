import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { formatKlipperConfig, findBlockProblems } from "./formatter";
import { scanLine, initialScanState, classifyTag } from "./scanner";

const fmt = (s: string, o = {}) => formatKlipperConfig(s, o).text;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

test("classifies block tags", () => {
	assert.equal(classifyTag("if x > 1").role, "open");
	assert.equal(classifyTag("endif").role, "close");
	assert.equal(classifyTag("else").role, "middle");
	assert.equal(classifyTag("elif y").role, "middle");
	assert.equal(classifyTag("for e in range(3)").role, "open");
	assert.equal(classifyTag("endfor").role, "close");
});

test("tells assigning set from block set", () => {
	assert.equal(classifyTag("set t = params.T|int").role, "neutral");
	assert.equal(classifyTag("set x = a == b").role, "neutral");
	assert.equal(classifyTag("set body").role, "open");
});

test("a comparison alone does not make set an assignment", () => {
	assert.equal(classifyTag("set flag").role, "open");
	assert.equal(classifyTag("set flag = a != b").role, "neutral");
});

test("single-brace expressions balance, including dict literals", () => {
	// Klipper: jinja2.Environment('{%', '%}', '{', '}')
	const line = `SET_GCODE_VARIABLE MACRO=RESUME VARIABLE=t VALUE="{{'restore': r, 'temp': v}}"`;
	const scan = scanLine(line, initialScanState());
	assert.equal(scan.state.exprDepth, 0, "dict inside an expression must close out");
	assert.equal(scan.endedOpen, false);
});

test("a tag split across lines stays open until %}", () => {
	const s1 = scanLine(
		`{% set restore = False if printer.toolhead.extruder == ''`,
		initialScanState()
	);
	assert.equal(s1.state.inTag, true);
	assert.equal(s1.tags.length, 0);
	const s2 = scanLine(`else True if params.RESTORE|default(1)|int == 1 else False %}`, s1.state);
	assert.equal(s2.state.inTag, false);
	assert.equal(s2.tags.length, 1);
	assert.equal(s2.tags[0].name, "set");
	assert.equal(s2.tags[0].role, "neutral");
});

test("a tag inside a comment is ignored", () => {
	const scan = scanLine("G1 X1 ; {% endif %} not a real tag", initialScanState());
	assert.equal(scan.tags.length, 0);
	assert.equal(scan.net, 0);
});

test("a # only starts a comment at a boundary", () => {
	const scan = scanLine("M117 a#b {% if x %}", initialScanState());
	assert.equal(scan.tags.length, 1, "# glued to a word is not a comment");
});

test("raw regions suppress tag parsing", () => {
	let st = initialScanState();
	const a = scanLine("{% raw %}", st);
	st = a.state;
	const b = scanLine("{% if never_counted %}", st);
	assert.equal(b.tags.length, 0);
	const c = scanLine("{% endraw %}", b.state);
	assert.equal(c.tags[0].name, "endraw");
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test("normalizes a gcode block to one indent level", () => {
	const input = ["[gcode_macro FOO]", "gcode:", "      G28", "  G1 X10", ""].join("\n");
	assert.equal(
		fmt(input),
		["[gcode_macro FOO]", "gcode:", "    G28", "    G1 X10", ""].join("\n")
	);
});

test("indents Jinja block bodies and dedents the closer", () => {
	const input = [
		"[gcode_macro FOO]",
		"gcode:",
		"  {% if a %}",
		"  G28",
		"  {% else %}",
		"  G29",
		"  {% endif %}",
		"",
	].join("\n");
	assert.equal(
		fmt(input),
		[
			"[gcode_macro FOO]",
			"gcode:",
			"    {% if a %}",
			"        G28",
			"    {% else %}",
			"        G29",
			"    {% endif %}",
			"",
		].join("\n")
	);
});

test("nests Jinja blocks", () => {
	const input = [
		"[gcode_macro FOO]",
		"gcode:",
		"{% if a %}",
		"{% for e in range(3) %}",
		"G1 E{e}",
		"{% endfor %}",
		"{% endif %}",
		"",
	].join("\n");
	// Column-0 lines after a key are still continuation lines to configparser
	// only while indented; here they parse as orphans and are left alone.
	const out = fmt(input);
	assert.ok(out.includes("{% if a %}"));
});

test("jinjaIndentSize can differ from indentSize", () => {
	const input = [
		"[gcode_macro FOO]",
		"gcode:",
		"{% if a %}".padStart(12),
		"G28".padStart(15),
		"{% endif %}".padStart(20),
		"",
	].join("\n");
	const out = fmt(input, { indentSize: 4, jinjaIndentSize: 2 });
	const lines = out.split("\n");
	assert.equal(lines[2], "    {% if a %}");
	assert.equal(lines[3], "      G28");
	assert.equal(lines[4], "    {% endif %}");
});

test("preserves alignment of a wrapped Jinja tag", () => {
	const input = [
		"[gcode_macro PAUSE]",
		"gcode:",
		"  {% set can = True if printer.toolhead.extruder == ''",
		"                  else printer[printer.toolhead.extruder].can_extrude %}",
		"",
	].join("\n");
	const out = fmt(input).split("\n");
	// The opener moved 2 -> 4, so the continuation moves by the same 2 and the
	// hand alignment under the expression survives.
	assert.equal(out[2], "    {% set can = True if printer.toolhead.extruder == ''");
	assert.equal(
		out[3],
		"                    else printer[printer.toolhead.extruder].can_extrude %}"
	);
});

test("a continuation line never reaches column 0", () => {
	const input = ["[gcode_macro FOO]", "gcode:", "        {% set x = (", " 1 + 2) %}", ""].join(
		"\n"
	);
	for (const line of fmt(input).split("\n")) {
		if (line.trim() !== "" && !line.startsWith("[") && !line.startsWith("gcode:")) {
			assert.ok(/^ /.test(line), `continuation lost its indent: ${JSON.stringify(line)}`);
		}
	}
});

test("normalizes separator spacing but keeps the separator", () => {
	const input = ["[Variables]", "current_extruder = 0", "z_offset   =  0.0", ""].join("\n");
	assert.equal(
		fmt(input),
		["[Variables]", "current_extruder = 0", "z_offset = 0.0", ""].join("\n")
	);
});

test("keeps bare adjacent section headers grouped", () => {
	const input = ["[pause_resume]", "[display_status]", "[respond]", ""].join("\n");
	assert.equal(fmt(input), input);
});

test("collapses blank runs and guarantees one before a section", () => {
	const input = ["[a]", "k: 1", "", "", "", "[b]", "k: 2", ""].join("\n");
	assert.equal(fmt(input), ["[a]", "k: 1", "", "[b]", "k: 2", ""].join("\n"));
});

test("keeps a comment glued to the section it documents", () => {
	const input = ["[a]", "k: 1", "# Usage: SET_PAUSE_AT_LAYER", "[b]", "k: 2", ""].join("\n");
	const out = fmt(input).split("\n");
	assert.equal(out[2], "");
	assert.equal(out[3], "# Usage: SET_PAUSE_AT_LAYER");
	assert.equal(out[4], "[b]", "no blank line between a comment and its section");
});

test("trims trailing whitespace and leading blank lines, ensures final newline", () => {
	const input = "\n\n[a]   \nk: 1   ";
	assert.equal(fmt(input), "[a]\nk: 1\n");
});

test("is idempotent", () => {
	const input = [
		"[gcode_macro T]",
		"gcode:",
		"   {% if a %}",
		"     {% for e in range(3) %}",
		"   G1 E{e}",
		"     {% endfor %}",
		"   {% endif %}",
		"",
	].join("\n");
	const once = fmt(input);
	assert.equal(fmt(once), once);
});

test("preserves CRLF", () => {
	const out = fmt("[a]\r\nk: 1\r\n");
	assert.ok(out.includes("\r\n"));
});

test("an empty document stays empty", () => {
	assert.equal(fmt(""), "");
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

test("flags an unclosed if", () => {
	const problems = findBlockProblems(
		["[gcode_macro A]", "gcode:", "  {% if x %}", "  G28", ""].join("\n")
	);
	assert.equal(problems.length, 1);
	assert.match(problems[0].message, /never closed/);
});

test("flags a stray endfor", () => {
	const problems = findBlockProblems(
		["[gcode_macro A]", "gcode:", "  {% endfor %}", ""].join("\n")
	);
	assert.equal(problems.length, 1);
	assert.match(problems[0].message, /no matching/);
});

test("flags a mismatched closer", () => {
	const problems = findBlockProblems(
		["[gcode_macro A]", "gcode:", "  {% if x %}", "  {% endfor %}", ""].join("\n")
	);
	assert.ok(problems.some((p) => /closes \{% if %\}/.test(p.message)));
});

test("accepts a balanced macro", () => {
	const problems = findBlockProblems(
		[
			"[gcode_macro A]",
			"gcode:",
			"  {% if x %}",
			"    {% for e in range(3) %}",
			"      G1 E{e}",
			"    {% endfor %}",
			"  {% else %}",
			"    G28",
			"  {% endif %}",
			"",
		].join("\n")
	);
	assert.deepEqual(problems, []);
});

test("block state does not leak across sections", () => {
	const problems = findBlockProblems(
		[
			"[gcode_macro A]",
			"gcode:",
			"  {% if x %}",
			"",
			"[gcode_macro B]",
			"gcode:",
			"  G28",
			"",
		].join("\n")
	);
	assert.equal(problems.length, 1, "exactly one unclosed if, attributed to A");
	assert.equal(problems[0].line, 2);
});

// ---------------------------------------------------------------------------
// Real printer corpus
// ---------------------------------------------------------------------------

const corpusRoot = path.resolve(__dirname, "../../test-configs");

function corpusFiles(dir: string, acc: string[] = []): string[] {
	if (!fs.existsSync(dir)) {
		return acc;
	}
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			corpusFiles(full, acc);
		} else if (entry.name.endsWith(".cfg")) {
			acc.push(full);
		}
	}
	return acc;
}

test("formats every file from the live printer without tripping the safety check", () => {
	const files = corpusFiles(corpusRoot);
	if (files.length === 0) {
		// test-configs/ is not committed -- it holds a real printer's config, and
		// it is populated with:
		//   rsync -a --include='*/' --include='*.cfg' --exclude='*' \
		//     <printer>:/home/klipper/printer_data/config/ test-configs/
		return;
	}

	const aborted: string[] = [];
	const notIdempotent: string[] = [];
	const deindented: string[] = [];

	for (const file of files) {
		const original = fs.readFileSync(file, "utf8");
		const first = formatKlipperConfig(original);
		if (first.aborted) {
			aborted.push(`${path.relative(corpusRoot, file)}: ${first.reason}`);
			continue;
		}
		const second = formatKlipperConfig(first.text);
		if (second.text !== first.text) {
			notIdempotent.push(path.relative(corpusRoot, file));
		}

		// Every line of a multi-line value must keep at least one space of indent.
		// At column 0 configparser reads it as a new option instead, silently
		// truncating the value -- so this is checked on the output on its own terms
		// rather than by comparing line numbers, which shift when blanks collapse.
		let inValue = false;
		const outLines = first.text.split("\n");
		for (let i = 0; i < outLines.length; i++) {
			const line = outLines[i];
			if (line.trim() === "") {
				continue;
			}
			if (/^\[/.test(line)) {
				inValue = false;
			} else if (/^[#;]/.test(line)) {
				continue;
			} else if (/^[A-Za-z_][^:=]*[:=]/.test(line)) {
				inValue = true;
			} else if (!/^\s/.test(line) && inValue) {
				deindented.push(`${path.relative(corpusRoot, file)}:${i + 1} ${JSON.stringify(line)}`);
			}
		}
	}

	assert.deepEqual(aborted, [], "safety check rejected files");
	assert.deepEqual(notIdempotent, [], "formatting was not idempotent");
	assert.deepEqual(deindented, [], "a value line was pushed to column 0");
});

test("the live printer corpus has balanced Jinja blocks", () => {
	const files = corpusFiles(corpusRoot);
	if (files.length === 0) {
		return;
	}
	const bad: string[] = [];
	for (const file of files) {
		const problems = findBlockProblems(fs.readFileSync(file, "utf8"));
		for (const p of problems) {
			bad.push(`${path.relative(corpusRoot, file)}:${p.line + 1} ${p.message}`);
		}
	}
	assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------
// Glob matching for the exclude setting
// ---------------------------------------------------------------------------

test("exclude globs match the way VS Code settings expect", () => {
	const { matchesGlob } = require("./glob");
	assert.equal(matchesGlob("mmu/base/mmu_software.cfg", "**/mmu/**"), true);
	assert.equal(matchesGlob("mmu/mmu_vars.cfg", "**/mmu/**"), true);
	assert.equal(matchesGlob("macro/mainsail.cfg", "**/mmu/**"), false);
	assert.equal(matchesGlob("timelapse.cfg", "**/timelapse.cfg"), true);
	assert.equal(matchesGlob("a/b/timelapse.cfg", "**/timelapse.cfg"), true);
	assert.equal(matchesGlob("macro/park.cfg", "**/*.cfg"), true);
	assert.equal(matchesGlob("macro/park.cfg", "macro/*.cfg"), true);
	assert.equal(matchesGlob("macro/sub/park.cfg", "macro/*.cfg"), false);
	assert.equal(matchesGlob("mmu/x.cfg", "{**/mmu/**,**/timelapse.cfg}"), true);
	assert.equal(matchesGlob("timelapse.cfg", "{**/mmu/**,**/timelapse.cfg}"), true);
	assert.equal(matchesGlob("printer.cfg", "{**/mmu/**,**/timelapse.cfg}"), false);
});
