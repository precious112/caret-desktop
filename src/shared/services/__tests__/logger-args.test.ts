/**
 * An error's payload must survive into the log in every build.
 *
 * Arguments used to be appended only when IS_DEV — so a packaged app's
 * `Logger.error("uncaught exception:", err)` logged a bare label, and a full
 * certification run died with that as its entire evidence. Errors also went
 * through JSON.stringify, which renders them "{}".
 */
import { strict as assert } from "assert"

import { Logger } from "../Logger"

describe("Logger argument serialization", () => {
	function capture(run: () => void): string[] {
		const lines: string[] = []
		const subscriber = (msg: string) => lines.push(msg)
		Logger.subscribe(subscriber)
		try {
			run()
		} finally {
			// No unsubscribe API; the subscriber set is module-global. Keep the
			// captured lines and let later captures collect their own.
		}
		return lines
	}

	it("an Error logged at ERROR level carries its message and stack, not '{}'", () => {
		const lines = capture(() => Logger.error("[test] something broke:", new Error("the actual reason")))
		const line = lines.find((entry) => entry.includes("something broke"))
		assert(line, "the error line was not emitted")
		assert(line.includes("the actual reason"), `the error's message is missing: ${line}`)
		assert(!line.includes("{}"), `the error serialized to {}: ${line}`)
	})

	it("WARN carries its arguments too", () => {
		const lines = capture(() => Logger.warn("[test] wobbly:", { reason: "load" }))
		const line = lines.find((entry) => entry.includes("wobbly"))
		assert(line, "the warn line was not emitted")
		assert(line.includes('"reason":"load"'), `the payload is missing: ${line}`)
	})
})
