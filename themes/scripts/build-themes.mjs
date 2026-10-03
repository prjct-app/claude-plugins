#!/usr/bin/env node
// Turns pi-palette data into Claude Code theme files.
//
//   node scripts/build-themes.mjs [library.json ...]
//
// Reads palettes.json (the bundled set) plus any pi-themes library files given,
// writes one themes/<id>.json per palette for /theme, and removes theme files
// whose palette is gone. The colors come from hooks/theme.ts, the same mapping
// the /palette mod applies at runtime.

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toClaudeTheme } from "../hooks/theme.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES = join(ROOT, "themes");
const HEX = /^#[0-9A-Fa-f]{6}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const CORE = ["canvas", "text", "accent", "secondary", "highlight", "success", "warning", "error"];

function readPalettes(path, bundled) {
	const data = JSON.parse(readFileSync(path, "utf8"));
	const list = Array.isArray(data.palettes) ? data.palettes : [];
	return list.flatMap((p) => {
		const ok = p && ID.test(p.id ?? "") && p.vars && CORE.every((k) => HEX.test(p.vars[k] ?? ""));
		if (!ok) {
			console.warn(`skipped ${p?.id ?? "a palette"} in ${path}: needs an id and the eight core colors`);
			return [];
		}
		return [{ ...p, label: p.label || p.id, group: bundled ? (p.group ?? "original") : "own", bundled }];
	});
}

function main() {
	const bundled = readPalettes(join(ROOT, "palettes.json"), true);
	const own = process.argv.slice(2).flatMap((path) => readPalettes(path, false));
	// Own palettes replace a bundled one with the same id.
	const byId = new Map([...bundled, ...own].map((p) => [p.id, p]));
	const palettes = [...byId.values()];

	mkdirSync(THEMES, { recursive: true });
	const keep = new Set(palettes.map((p) => `${p.id}.json`));
	for (const name of readdirSync(THEMES)) if (name.endsWith(".json") && !keep.has(name)) unlinkSync(join(THEMES, name));
	for (const p of palettes) writeFileSync(join(THEMES, `${p.id}.json`), `${JSON.stringify(toClaudeTheme(p), null, "\t")}\n`);

	console.log(`${palettes.length} themes (${bundled.length} bundled, ${own.length} own) → themes/`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
