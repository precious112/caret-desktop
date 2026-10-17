/**
 * The interview's test switch must never reach users: an installed build
 * ignores it whatever the environment says.
 */
import { strict as assert } from "assert"

import { interviewBackendOverride } from "../interview-backend"

describe("interview test switch", () => {
	it("is off in an installed build, even with the variables set", () => {
		assert.equal(interviewBackendOverride({ CARET_INTERVIEW_REPLAY: "/tmp/r.json" }, true), null)
		assert.equal(interviewBackendOverride({ CARET_INTERVIEW_RECORD: "/tmp/r.json" }, true), null)
	})

	it("is off when nothing is set", () => {
		assert.equal(interviewBackendOverride({}, false), null)
	})

	it("turns on replay or recording in a development build", () => {
		assert.deepEqual(
			interviewBackendOverride({ CARET_INTERVIEW_REPLAY: "/tmp/r.json", CARET_INTERVIEW_REPLAY_LOG: "/tmp/r.log" }, false),
			{ kind: "replay", file: "/tmp/r.json", logFile: "/tmp/r.log" },
		)
		assert.deepEqual(interviewBackendOverride({ CARET_INTERVIEW_RECORD: "/tmp/rec.json" }, false), {
			kind: "record",
			file: "/tmp/rec.json",
		})
	})

	it("refuses both at once rather than guessing which was meant", () => {
		assert.throws(() => interviewBackendOverride({ CARET_INTERVIEW_REPLAY: "a", CARET_INTERVIEW_RECORD: "b" }, false))
	})
})
