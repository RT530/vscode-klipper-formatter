import {
	commands,
	Diagnostic,
	DiagnosticCollection,
	DiagnosticSeverity,
	DocumentFormattingEditProvider,
	DocumentRangeFormattingEditProvider,
	DocumentSelector,
	ExtensionContext,
	languages,
	ProgressLocation,
	Range,
	TextDocument,
	TextEdit,
	Uri,
	window,
	workspace,
	WorkspaceEdit,
} from "vscode";

import { findBlockProblems, formatKlipperConfig, FormatOptions } from "./formatter";
import { matchesAny } from "./glob";

/**
 * Only `klipper-cfg` is formatted. `klipper-gcode` and `klipper-script` have no
 * multi-line config values to indent.
 */
const LANGUAGE_IDS = ["klipper-cfg"];
const CFG_GLOB = "**/*.cfg";

function readOptions(scope?: Uri): FormatOptions {
	const c = workspace.getConfiguration("klipperFormatter", scope);
	return {
		indentSize: c.get<number>("indentSize", 4),
		jinjaIndentSize: c.get<number>("jinjaIndentSize", 0),
		indentJinjaBlocks: c.get<boolean>("indentJinjaBlocks", true),
		normalizeSeparatorSpacing: c.get<boolean>("normalizeSeparatorSpacing", true),
		maxConsecutiveBlankLines: c.get<number>("maxConsecutiveBlankLines", 1),
		blankLinesBeforeSection: c.get<number>("blankLinesBeforeSection", 1),
		trimLeadingBlankLines: c.get<boolean>("trimLeadingBlankLines", true),
	};
}

function excludePatterns(): string[] {
	return workspace.getConfiguration("klipperFormatter").get<string[]>("exclude", []);
}

function excludeGlob(): string | undefined {
	const patterns = excludePatterns();
	if (!patterns.length) return undefined;
	return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

/**
 * Mirrors the `exclude` setting for single-document work (format-on-save and
 * diagnostics), where a workspace-wide file search would be far too expensive.
 */
function isExcluded(uri: Uri): boolean {
	const patterns = excludePatterns();
	if (!patterns.length) return false;
	return matchesAny(workspace.asRelativePath(uri, false), patterns);
}

function fullRange(document: TextDocument): Range {
	const last = document.lineCount - 1;
	return new Range(0, 0, last, document.lineAt(last).text.length);
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Formatting providers
// ---------------------------------------------------------------------------

const documentFormatter: DocumentFormattingEditProvider = {
	provideDocumentFormattingEdits(document) {
		if (isExcluded(document.uri)) return [];

		const result = formatKlipperConfig(document.getText(), readOptions(document.uri));
		if (result.aborted) {
			window.showWarningMessage(
				`Klipper: left ${workspace.asRelativePath(document.uri)} untouched -- ${result.reason}.`
			);
			return [];
		}
		if (!result.changed) return [];

		return [TextEdit.replace(fullRange(document), result.text)];
	},
};

/**
 * Range formatting re-runs the whole document and then keeps only the lines the
 * selection covers. Indent depth inside a `gcode:` block depends on every
 * `{% if %}` above it, so a range cannot be formatted in isolation.
 */
const rangeFormatter: DocumentRangeFormattingEditProvider = {
	provideDocumentRangeFormattingEdits(document, range) {
		if (isExcluded(document.uri)) return [];

		const result = formatKlipperConfig(document.getText(), readOptions(document.uri));
		if (result.aborted || !result.changed) return [];

		const before = document.getText().split(/\r?\n/);
		const after = result.text.split(/\r?\n/);
		// Blank-line collapsing can shift line numbers, which would misalign a
		// partial replacement. Fall back to replacing the document in that case.
		if (before.length !== after.length) {
			return [TextEdit.replace(fullRange(document), result.text)];
		}

		const edits: TextEdit[] = [];
		for (let i = range.start.line; i <= range.end.line && i < before.length; i++) {
			if (before[i] !== after[i]) {
				edits.push(TextEdit.replace(new Range(i, 0, i, before[i].length), after[i]));
			}
		}
		return edits;
	},
};

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function refreshDiagnostics(document: TextDocument, collection: DiagnosticCollection): void {
	if (!LANGUAGE_IDS.includes(document.languageId)) return;
	if (isExcluded(document.uri)) {
		collection.delete(document.uri);
		return;
	}

	const enabled = workspace
		.getConfiguration("klipperFormatter", document.uri)
		.get<boolean>("diagnostics.enabled", true);
	if (!enabled) {
		collection.delete(document.uri);
		return;
	}

	collection.set(
		document.uri,
		findBlockProblems(document.getText()).map((p) => {
			const d = new Diagnostic(
				new Range(p.line, p.column, p.line, p.endColumn),
				p.message,
				p.severity === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning
			);
			d.source = "klipper";
			return d;
		})
	);
}

// ---------------------------------------------------------------------------
// Workspace-wide commands
// ---------------------------------------------------------------------------

interface FileOutcome {
	uri: Uri;
	changed: boolean;
	aborted: boolean;
	reason?: string;
	formatted: string;
	original: string;
}

async function scanWorkspace(title: string): Promise<FileOutcome[]> {
	const files = await workspace.findFiles(CFG_GLOB, excludeGlob());
	const outcomes: FileOutcome[] = [];

	await window.withProgress(
		{ location: ProgressLocation.Notification, title, cancellable: true },
		async (progress, token) => {
			for (let i = 0; i < files.length; i++) {
				if (token.isCancellationRequested) break;

				const uri = files[i];
				progress.report({
					increment: 100 / files.length,
					message: `${i + 1}/${files.length} ${workspace.asRelativePath(uri)}`,
				});

				const original = decode(await workspace.fs.readFile(uri));
				const result = formatKlipperConfig(original, readOptions(uri));
				outcomes.push({
					uri,
					changed: result.changed,
					aborted: result.aborted,
					reason: result.reason,
					formatted: result.text,
					original,
				});
			}
		}
	);

	return outcomes;
}

function summarize(outcomes: FileOutcome[]): string {
	const changed = outcomes.filter((o) => o.changed).length;
	const aborted = outcomes.filter((o) => o.aborted).length;
	let msg = `${changed} of ${outcomes.length} .cfg file${
		outcomes.length === 1 ? "" : "s"
	} need formatting.`;
	if (aborted) msg += ` ${aborted} skipped by the safety check.`;
	return msg;
}

async function formatWorkspace(): Promise<void> {
	const outcomes = await scanWorkspace("Klipper: formatting .cfg files");
	const toWrite = outcomes.filter((o) => o.changed && !o.aborted);

	if (!toWrite.length) {
		window.showInformationMessage(`Klipper: nothing to change. ${summarize(outcomes)}`);
		return;
	}

	const confirm = await window.showWarningMessage(
		`Klipper: rewrite ${toWrite.length} .cfg file${
			toWrite.length === 1 ? "" : "s"
		}? Only whitespace changes; content is verified unchanged before each write.`,
		{ modal: true },
		"Format Files",
		"Preview First"
	);

	if (confirm === "Preview First") return previewWorkspace();
	if (confirm !== "Format Files") return;

	const edit = new WorkspaceEdit();
	for (const o of toWrite) {
		const doc = await workspace.openTextDocument(o.uri);
		edit.replace(o.uri, fullRange(doc), o.formatted);
	}
	if (!(await workspace.applyEdit(edit))) {
		window.showErrorMessage("Klipper: the workspace edit was rejected; nothing was written.");
		return;
	}

	// applyEdit leaves the documents dirty, which is a usable checkpoint on its
	// own, but saving keeps this consistent with a normal format-on-save run.
	const save = await window.showInformationMessage(
		`Klipper: formatted ${toWrite.length} file${toWrite.length === 1 ? "" : "s"}. Save them now?`,
		"Save All",
		"Keep Unsaved"
	);
	if (save === "Save All") await workspace.saveAll(false);
}

async function previewWorkspace(): Promise<void> {
	const outcomes = await scanWorkspace("Klipper: checking .cfg files");
	const changed = outcomes.filter((o) => o.changed);
	const aborted = outcomes.filter((o) => o.aborted);

	const lines = ["# Klipper formatting preview", "", summarize(outcomes), ""];

	if (aborted.length) {
		lines.push("## Skipped by the safety check", "");
		for (const o of aborted) {
			lines.push(`- ${workspace.asRelativePath(o.uri)} -- ${o.reason}`);
		}
		lines.push("");
	}

	if (!changed.length) {
		lines.push("Every file already matches the configured format.");
	} else {
		lines.push("## Files that would change", "");
		for (const o of changed) {
			const before = o.original.split(/\r?\n/);
			const after = o.formatted.split(/\r?\n/);
			let touched = 0;
			for (let i = 0; i < Math.max(before.length, after.length); i++) {
				if (before[i] !== after[i]) touched++;
			}
			lines.push(
				`- ${workspace.asRelativePath(o.uri)} -- ${touched} line${touched === 1 ? "" : "s"}`
			);
		}
		lines.push("", 'Run "Klipper: Format All .cfg Files in Workspace" to apply.');
	}

	const doc = await workspace.openTextDocument({
		content: lines.join("\n"),
		language: "markdown",
	});
	await window.showTextDocument(doc, { preview: true });
}

async function checkBlocks(collection: DiagnosticCollection): Promise<void> {
	const files = await workspace.findFiles(CFG_GLOB, excludeGlob());
	let total = 0;

	for (const uri of files) {
		const problems = findBlockProblems(decode(await workspace.fs.readFile(uri)));
		total += problems.length;
		collection.set(
			uri,
			problems.map((p) => {
				const d = new Diagnostic(
					new Range(p.line, p.column, p.line, p.endColumn),
					p.message,
					DiagnosticSeverity.Error
				);
				d.source = "klipper";
				return d;
			})
		);
	}

	if (!total) {
		window.showInformationMessage(
			`Klipper: Jinja blocks balance in all ${files.length} .cfg file${
				files.length === 1 ? "" : "s"
			}.`
		);
	} else {
		window.showWarningMessage(
			`Klipper: found ${total} unbalanced Jinja block${
				total === 1 ? "" : "s"
			}. See the Problems panel.`
		);
		await commands.executeCommand("workbench.actions.view.problems");
	}
}

// ---------------------------------------------------------------------------

export function activate(context: ExtensionContext) {
	const selector: DocumentSelector = LANGUAGE_IDS.map((language) => ({
		language,
		scheme: "file",
	}));
	const collection = languages.createDiagnosticCollection("klipper");

	context.subscriptions.push(
		collection,
		languages.registerDocumentFormattingEditProvider(selector, documentFormatter),
		languages.registerDocumentRangeFormattingEditProvider(selector, rangeFormatter),
		commands.registerCommand("klipperFormatter.formatWorkspace", formatWorkspace),
		commands.registerCommand("klipperFormatter.previewWorkspace", previewWorkspace),
		commands.registerCommand("klipperFormatter.checkBlocks", () => checkBlocks(collection)),
		workspace.onDidOpenTextDocument((d) => refreshDiagnostics(d, collection)),
		workspace.onDidChangeTextDocument((e) => refreshDiagnostics(e.document, collection)),
		workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
		workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("klipperFormatter")) {
				for (const d of workspace.textDocuments) refreshDiagnostics(d, collection);
			}
		})
	);

	for (const d of workspace.textDocuments) refreshDiagnostics(d, collection);
}

export function deactivate() {}
