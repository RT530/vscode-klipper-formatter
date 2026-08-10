/**
 * Minimal glob matcher for the `exclude` setting.
 *
 * The workspace commands hand their patterns straight to `findFiles`, but
 * format-on-save needs an answer without touching the filesystem, so the same
 * patterns are compiled to a RegExp here. Supports the subset VS Code settings
 * actually use: `**`, `*`, `?` and `{a,b}` brace alternation.
 */

const SPECIAL = /[.+^$()|\\]/g;

function compile(pattern: string): RegExp {
	let out = "";
	let i = 0;

	while (i < pattern.length) {
		const c = pattern[i];

		if (c === "*") {
			if (pattern[i + 1] === "*") {
				// `**/` also matches zero directories, so `**/mmu/**` catches `mmu/x.cfg`.
				if (pattern[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 3;
					continue;
				}
				out += ".*";
				i += 2;
				continue;
			}
			out += "[^/]*";
			i++;
			continue;
		}

		if (c === "?") {
			out += "[^/]";
			i++;
			continue;
		}

		if (c === "{") {
			const end = pattern.indexOf("}", i);
			if (end > i) {
				const alts = pattern
					.slice(i + 1, end)
					.split(",")
					.map((a) => compileInner(a));
				out += `(?:${alts.join("|")})`;
				i = end + 1;
				continue;
			}
		}

		if (c === "[") {
			const end = pattern.indexOf("]", i);
			if (end > i) {
				out += pattern.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}

		out += c.replace(SPECIAL, "\\$&");
		i++;
	}

	return new RegExp(`^${out}$`);
}

function compileInner(pattern: string): string {
	const src = compile(pattern).source;
	return src.slice(1, -1);
}

const cache = new Map<string, RegExp>();

export function matchesGlob(relativePath: string, pattern: string): boolean {
	let re = cache.get(pattern);
	if (!re) {
		re = compile(pattern);
		cache.set(pattern, re);
	}
	return re.test(relativePath.replace(/\\/g, "/"));
}

export function matchesAny(relativePath: string, patterns: string[]): boolean {
	return patterns.some((p) => matchesGlob(relativePath, p));
}
