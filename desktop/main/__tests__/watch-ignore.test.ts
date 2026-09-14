/**
 * What the healer is allowed to sleep through.
 *
 * This exists because the previous ignore list was a list of globs handed to
 * chokidar 4, which dropped glob support in `ignored` and compares string
 * entries literally. Nothing matched: `.caret/node_modules` (which Vite writes
 * into constantly while optimising deps) and every file Caret regenerates were
 * all watched, and the certification log carried the proof — provenance entries
 * for `node_modules/fsevents/*` and `node_modules/.vite-temp/*`. A silently
 * inert config is exactly the kind of thing a test has to hold down.
 */
import { strict as assert } from "assert"
import * as path from "path"

import { isIgnoredPath } from "../watch-and-heal"

const CARET = path.join("/tmp", "proj", ".caret")
const under = (...parts: string[]) => path.join(CARET, ...parts)

describe("isIgnoredPath", () => {
	it("ignores node_modules at any depth, so Vite's dep churn never wakes the healer", () => {
		assert.equal(isIgnoredPath(CARET, under("node_modules")), true)
		assert.equal(isIgnoredPath(CARET, under("node_modules", ".vite", "deps", "react.js")), true)
		assert.equal(isIgnoredPath(CARET, under("node_modules", "fsevents", "package.json")), true)
		assert.equal(isIgnoredPath(CARET, under("node_modules", ".vite-temp", "vite.config.ts.timestamp-1.mjs")), true)
	})

	it("ignores the files Caret itself regenerates", () => {
		for (const name of [
			"caret-theme.css",
			"caret-fonts.css",
			"canvas-layout.json",
			"sync-manifest.json",
			".provenance.jsonl",
			".undo-journal.json",
			".interview.json",
			".variants.json",
			".checks-results.json",
			".corrections-state.json",
			".sync-pending.json",
			".mcp.json",
			"vite.log",
		]) {
			assert.equal(isIgnoredPath(CARET, under(name)), true, `${name} should not wake the healer`)
		}
	})

	it("ignores Caret's own output directories and video posters", () => {
		assert.equal(isIgnoredPath(CARET, under("lib", "canvas", "CanvasApp.tsx")), true)
		assert.equal(isIgnoredPath(CARET, under("thumbnails", "home.png")), true)
		assert.equal(isIgnoredPath(CARET, under("assets", ".posters", "reel.jpg")), true)
		assert.equal(isIgnoredPath(CARET, under("pages", "home", "index.tsx.tmp")), true)
	})

	it("watches design content — the whole point of the watcher", () => {
		assert.equal(isIgnoredPath(CARET, under("pages", "about", "index.tsx")), false)
		assert.equal(isIgnoredPath(CARET, under("pages", "about", "meta.json")), false)
		assert.equal(isIgnoredPath(CARET, under("components", "Card.tsx")), false)
		assert.equal(isIgnoredPath(CARET, under("tokens", "foundation.json")), false)
		assert.equal(isIgnoredPath(CARET, under("assets", "hero.png")), false)
		assert.equal(isIgnoredPath(CARET, under("flows", "main.flow.json")), false)
	})

	it("only claims Caret's names at the top of the tree, and a user's `lib` is content", () => {
		// A component folder called lib is a user's, not the generated canvas.
		assert.equal(isIgnoredPath(CARET, under("components", "lib", "Button.tsx")), false)
		// A page that happens to be named like Caret's scratch is still a page.
		assert.equal(isIgnoredPath(CARET, under("pages", "x", "canvas-layout.json")), false)
	})

	it("says nothing about paths outside the tree it was asked about", () => {
		assert.equal(isIgnoredPath(CARET, "/tmp/proj/src/App.tsx"), false)
		assert.equal(isIgnoredPath(CARET, CARET), false)
	})
})
