/**
 * The telemetry contract's load-bearing guarantees: content never survives the
 * scrubber, sensitive channels never enter the allowlist, and a crash loop
 * cannot spend more than its session budget. These are the properties
 * docs/telemetry.md promises users — a failure here is a broken promise, not
 * a broken feature.
 */
import { strict as assert } from "assert"

import { CHANNEL_EVENTS, createSessionBudget, hashText, RENDERER_EVENTS, scrubAndTruncate, scrubText } from "../telemetry"

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
		assert.deepEqual([...RENDERER_EVENTS].sort(), ["renderer_exception", "surface_switched"])
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
