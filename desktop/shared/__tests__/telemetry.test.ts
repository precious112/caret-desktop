/**
 * The telemetry contract's load-bearing guarantees: content never survives the
 * scrubber, sensitive channels never enter the allowlist, and a crash loop
 * cannot spend more than its session budget. These are the properties
 * docs/telemetry.md promises users — a failure here is a broken promise, not
 * a broken feature.
 */
import { strict as assert } from "assert"

import {
	CHANNEL_EVENTS,
	createSessionBudget,
	errorCodeProps,
	hashText,
	RENDERER_EVENTS,
	rendererEventProps,
	scrubAndTruncate,
	scrubText,
} from "../telemetry"

describe("telemetry scrubber", () => {
	it("strips POSIX home and system paths", () => {
		const out = scrubText("ENOENT: /Users/somebody/dev/secret-project/.caret/pages/home/index.tsx missing")
		assert.ok(!out.includes("somebody"), out)
		assert.ok(!out.includes("secret-project"), out)
		assert.ok(out.includes("<path>"), out)
	})

	it("strips Windows drive-letter paths", () => {
		const out = scrubText("EPERM: C:\\Users\\First Last\\project\\file.tsx locked")
		assert.ok(!out.includes("First"), out)
		assert.ok(out.includes("<path>"), out)
	})

	it("strips quoted spans, which can carry arbitrary user content", () => {
		const out = scrubText('Ignoring malformed inline-edit payload: "Buy now and save 20%"')
		assert.ok(!out.includes("Buy now"), out)
	})

	it("strips JSON bodies the way the message router embeds them", () => {
		const out = scrubText('malformed payload: {"filePath":"pages/home/index.tsx","newText":"Welcome to Acme"}')
		assert.ok(!out.includes("Acme"), out)
		assert.ok(!out.includes("filePath"), out)
	})

	// ── what makes an error FIXABLE survives ─────────────────────────────────
	// The frames below are the real shapes: the main process's ESM stack (from
	// this repo's own verify log), a packaged macOS and Windows install, and the
	// EXDEV crash PostHog received with every file shredded to "fil<path>".

	const CONTEXT = {
		roots: [
			{ path: "/Users/somebody/Library/Application Support/Caret", token: "<userData>", keepRest: true },
			{ path: "C:\\Users\\First Last\\AppData\\Roaming\\Caret", token: "<userData>", keepRest: true },
			{ path: "/var/folders/ab/xyz/T", token: "<tmp>", keepRest: false },
			{ path: "/Users/somebody", token: "<home>", keepRest: false },
		],
	}

	it("keeps file:line:col of Caret's own frames — the regression that made every frame 'fil<path>'", () => {
		const frame = "    at applyEdits (file:///Users/somebody/dev/caret-desktop/out/main/index.js:16886:13)"
		const out = scrubText(frame, CONTEXT)
		assert.equal(out, "    at applyEdits (out/main/index.js:16886:13)")
		assert.ok(!out.includes("fil<path>"), out)
	})

	it("keeps frames from a packaged install on macOS and Windows, without the install path", () => {
		const mac = scrubText(
			"    at persist$1 (file:///Applications/Caret.app/Contents/Resources/app/out/main/index.js:921:11)",
			CONTEXT,
		)
		assert.equal(mac, "    at persist$1 (out/main/index.js:921:11)")
		const win = scrubText(
			"    at setPref (file:///C:/Users/First%20Last/AppData/Local/Programs/Caret/resources/app/out/main/index.js:88:5)",
			CONTEXT,
		)
		assert.equal(win, "    at setPref (out/main/index.js:88:5)")
		const renderer = scrubText(
			"at onClick (file:///Applications/Caret.app/Contents/Resources/app/out/renderer/assets/index-Ab12.js:1:4410)",
		)
		assert.equal(renderer, "at onClick (out/renderer/assets/index-Ab12.js:1:4410)")
	})

	it("leaves Node's own frames alone", () => {
		const frame = "    at async Module.rename (node:internal/fs/promises:782:10)"
		assert.equal(scrubText(frame, CONTEXT), frame)
	})

	it("names Caret's own files by token, so EXDEV says WHICH rename failed", () => {
		const message =
			"EXDEV: cross-device link not permitted, rename '/Users/somebody/Library/Application Support/Caret/preferences.json.tmp' -> '/Users/somebody/Library/Application Support/Caret/preferences.json'"
		const out = scrubText(message, CONTEXT)
		assert.equal(
			out,
			"EXDEV: cross-device link not permitted, rename '<userData>/preferences.json.tmp' -> '<userData>/preferences.json'",
		)
		assert.ok(!out.includes("somebody"), out)
	})

	it("matches Windows roots whatever the slashes or case", () => {
		const out = scrubText("rename 'c:\\users\\first last\\appdata\\roaming\\caret\\preferences.json.tmp'", CONTEXT)
		assert.equal(out, "rename '<userData>/preferences.json.tmp'")
	})

	it("never keeps names under the home or temp folders — only that the path was there", () => {
		const out = scrubText(
			"ENOENT: /Users/somebody/dev/secret-project/.caret/pages/launch/index.tsx and /var/folders/ab/xyz/T/caret-app-x1/a.tsx",
			CONTEXT,
		)
		assert.equal(out, "ENOENT: <home>/… and <tmp>/…")
	})

	it("still drops a quoted span that holds anything besides a sanitized path", () => {
		const out = scrubText("bad edit 'Buy /Users/somebody/x.png now' and 'out/main/index.js:1:2'", CONTEXT)
		assert.ok(!out.includes("Buy") && !out.includes("somebody"), out)
		assert.ok(out.includes("'out/main/index.js:1:2'"), out)
	})

	it("without a context, Caret paths are hidden like any other — the safe default", () => {
		const out = scrubText("rename '/Users/somebody/Library/Application Support/Caret/preferences.json.tmp'")
		assert.ok(!out.includes("somebody") && !out.includes("Library"), out)
	})

	it("leaks nothing from a home path with spaces, even outside quotes", () => {
		const out = scrubText("ENOENT: open /Users/somebody/My Projects/Secret Launch App/src/page.tsx failed", CONTEXT)
		for (const word of ["somebody", "Projects", "Secret", "Launch", "page.tsx"]) assert.ok(!out.includes(word), out)
	})

	it("keeps a raw Windows frame whose install path has a space in the username", () => {
		const out = scrubText(
			"    at persist (C:\\Users\\First Last\\AppData\\Local\\Programs\\Caret\\resources\\app\\out\\main\\index.js:5:6)",
			CONTEXT,
		)
		assert.equal(out, "    at persist (out/main/index.js:5:6)")
	})

	it("drops page names carried in payloads and URLs' query strings", () => {
		const out = scrubText(
			'[canvas] failed to load http://127.0.0.1:5173/?page=secret-launch with {"pageId":"secret-launch"}',
			CONTEXT,
		)
		assert.ok(!out.includes('"pageId"'), out)
	})

	it("carries Node's error code, syscall and errno — fixed vocabulary, never content", () => {
		const err = Object.assign(new Error("EXDEV: …"), { code: "EXDEV", syscall: "rename", errno: -18, path: "/Users/x" })
		assert.deepEqual(errorCodeProps(err), { error_code: "EXDEV", syscall: "rename", errno: -18 })
		assert.deepEqual(errorCodeProps(Object.assign(new Error("x"), { code: "not a code /Users/x" })), {})
	})

	it("truncates to the property budget", () => {
		const out = scrubAndTruncate("x".repeat(500), 200)
		assert.ok(out.length <= 201, String(out.length))
	})
})

describe("channel allowlist", () => {
	it("never contains a content-carrying channel", () => {
		const channels = Object.keys(CHANNEL_EVENTS)
		for (const forbidden of ["secrets:", "prefs:", "tokens:write", "agent:send", "canvas:", "assets:"]) {
			assert.ok(!channels.some((channel) => channel.startsWith(forbidden)), `allowlist contains a ${forbidden}* channel`)
		}
	})

	it("prop extractors admit only fixed vocabulary, never the argument", () => {
		const props = CHANNEL_EVENTS["wizard:start"].props?.(["/Users/x/proj", "an ecommerce site for my dog", "ai-led"])
		assert.deepEqual(props, { mode: "ai-led" })
		const raw = CHANNEL_EVENTS["agent:selectBackend"].props?.(["some/arbitrary/string"])
		assert.deepEqual(raw, { backend_id: "other" })
	})

	it("renderer event names are a closed set", () => {
		assert.deepEqual([...RENDERER_EVENTS].sort(), ["renderer_exception", "setup_route_chosen", "surface_switched"])
	})

	it("renderer event props are rebuilt from fixed vocabulary, never spread", () => {
		const smuggled = { surface: "/Users/someone/secret", initial: "yes", note: "free text" }
		assert.deepEqual(rendererEventProps("surface_switched", smuggled), { surface: "other" })
		assert.deepEqual(rendererEventProps("surface_switched", { surface: "foundation", initial: true }), {
			surface: "foundation",
			initial: true,
		})
		assert.deepEqual(rendererEventProps("setup_route_chosen", { route: "from-app", hasAppCode: true, path: "/x" }), {
			route: "from-app",
			has_app_code: true,
		})
		assert.deepEqual(rendererEventProps("setup_route_chosen", { route: "a description they typed" }), {
			route: "other",
			has_app_code: false,
		})
	})
})

describe("session budget", () => {
	it("dedupes identical error hashes and caps the session", () => {
		const budget = createSessionBudget({ errorLines: 3, exceptions: 2 })
		const hash = hashText("same error")
		assert.equal(budget.allowErrorLine(hash), true)
		assert.equal(budget.allowErrorLine(hash), false, "identical hash sent twice")
		assert.equal(budget.allowErrorLine(hashText("second")), true)
		assert.equal(budget.allowErrorLine(hashText("third")), true)
		assert.equal(budget.allowErrorLine(hashText("fourth")), false, "cap not enforced")
		assert.equal(budget.allowException(), true)
		assert.equal(budget.allowException(), true)
		assert.equal(budget.allowException(), false, "exception cap not enforced")
	})

	it("hashes are stable and printable", () => {
		assert.equal(hashText("abc"), hashText("abc"))
		assert.match(hashText("abc"), /^[0-9a-z]+$/)
	})
})
