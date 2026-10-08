/**
 * What PostHog actually receives for an exception — built by the PostHog SDK's
 * own event builder (the one `captureException` uses), from an error scrubbed
 * the way the app scrubs it. The SDK, not a re-implementation of its parser:
 * the regression this holds down was a scrub that left PostHog with
 * `fil<path>` for every frame of Caret's own code and no line number at all,
 * so a real crash could not be located.
 */
import { strict as assert } from "assert"
import * as path from "path"
import { pathToFileURL } from "url"

import { errorCodeProps, scrubText } from "../telemetry"

const CONTEXT = {
	roots: [
		{ path: "C:\\Users\\First Last\\AppData\\Roaming\\Caret", token: "<userData>", keepRest: true },
		{ path: "C:\\Users\\First Last", token: "<home>", keepRest: false },
	],
}

describe("the exception PostHog receives", () => {
	it("locates Caret's frames by file and line, names Caret's files, and carries no username", async () => {
		// Loading the Node entry point configures the SDK's error builder; the
		// builder itself is not an exported subpath, so it is loaded by file.
		const dist = path.resolve(path.dirname(require.resolve("posthog-node")), "..")
		const builderUrl = pathToFileURL(path.join(dist, "extensions", "error-tracking", "index.mjs")).href
		const nodeEntryUrl = pathToFileURL(path.join(dist, "entrypoints", "index.node.mjs")).href
		await import(nodeEntryUrl)
		const { default: errorTracking } = (await import(builderUrl)) as {
			default: { buildEventMessage(error: Error, hint: object, distinctId: string, props: object): Promise<any> }
		}

		const raw = Object.assign(
			new Error(
				"EXDEV: cross-device link not permitted, rename 'C:\\Users\\First Last\\AppData\\Roaming\\Caret\\preferences.json.tmp' -> 'C:\\Users\\First Last\\AppData\\Roaming\\Caret\\preferences.json'",
			),
			{ code: "EXDEV", syscall: "rename", errno: -4037 },
		)
		raw.stack = `Error: ${raw.message}
    at async Module.rename (node:internal/fs/promises:782:10)
    at async persist$1 (file:///C:/Users/First%20Last/AppData/Local/Programs/Caret/resources/app/out/main/index.js:5023:3)
    at async setPref (file:///C:/Users/First%20Last/AppData/Local/Programs/Caret/resources/app/out/main/index.js:5061:5)`

		const clean = new Error(scrubText(raw.message, CONTEXT))
		clean.stack = scrubText(raw.stack, CONTEXT)
		const event = await errorTracking.buildEventMessage(
			clean,
			{ syntheticException: new Error("PostHog syntheticException") },
			"test-user",
			{ source: "main", ...errorCodeProps(raw) },
		)

		const exception = event.properties.$exception_list[0]
		assert.equal(
			exception.value,
			"EXDEV: cross-device link not permitted, rename '<userData>/preferences.json.tmp' -> '<userData>/preferences.json'",
		)
		const frames = exception.stacktrace.frames.map((f: { function: string; filename: string; lineno: number }) => [
			f.function,
			f.filename,
			f.lineno,
		])
		assert.deepEqual(
			frames.filter(([, file]: [string, string]) => file === "out/main/index.js"),
			[
				["setPref", "out/main/index.js", 5061],
				["persist$1", "out/main/index.js", 5023],
			],
		)
		assert.equal(event.properties.error_code, "EXDEV")
		assert.equal(event.properties.syscall, "rename")
		assert.doesNotMatch(JSON.stringify(event), /First|Last|Users/, "the username or a user path reached the payload")
	})
})
