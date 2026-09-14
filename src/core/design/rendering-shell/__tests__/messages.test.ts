/**
 * Payloads from the preview iframe are untrusted input: the canvas runs
 * generated and user-authored code, and a malformed message must be ignored,
 * never crash a handler — and never put a fabricated number in front of a
 * model as measured fact.
 */
import { strict as assert } from "assert"

import { isValidDesignMessagePayload } from "../messages"

const overlay = (extra: Record<string, unknown> = {}) => ({
	instruction: "center the clip on the shirt",
	screenshotDataUrl: "data:image/png;base64,AAAA",
	regionBounds: { x: 10, y: 10, width: 200, height: 100 },
	...extra,
})

const element = (extra: Record<string, unknown> = {}) => ({
	caretId: "c42",
	tag: "img",
	rect: { x: 5, y: 5, width: 80, height: 120 },
	...extra,
})

describe("overlay-edit payload validation", () => {
	it("accepts the classic payload with no elements at all", () => {
		assert.ok(isValidDesignMessagePayload("overlay-edit", overlay()))
	})

	it("accepts measured elements and a viewport", () => {
		assert.ok(
			isValidDesignMessagePayload(
				"overlay-edit",
				overlay({
					elements: [element(), element({ caretId: "c17", tag: "div" })],
					viewport: { width: 1440, height: 900 },
				}),
			),
		)
	})

	it("rejects an element whose rect carries a non-finite number", () => {
		assert.ok(
			!isValidDesignMessagePayload(
				"overlay-edit",
				overlay({ elements: [element({ rect: { x: Number.NaN, y: 0, width: 10, height: 10 } })] }),
			),
		)
		assert.ok(
			!isValidDesignMessagePayload(
				"overlay-edit",
				overlay({ elements: [element({ rect: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 } })] }),
			),
		)
	})

	it("rejects an element missing its identity", () => {
		assert.ok(
			!isValidDesignMessagePayload(
				"overlay-edit",
				overlay({ elements: [{ tag: "img", rect: { x: 0, y: 0, width: 1, height: 1 } }] }),
			),
		)
		assert.ok(!isValidDesignMessagePayload("overlay-edit", overlay({ elements: [element({ caretId: "" })] })))
	})

	it("rejects more elements than any painted region can honestly contain", () => {
		const flood = Array.from({ length: 25 }, (_, i) => element({ caretId: `c${i}` }))
		assert.ok(!isValidDesignMessagePayload("overlay-edit", overlay({ elements: flood })))
	})

	it("rejects a malformed viewport but accepts its absence", () => {
		assert.ok(!isValidDesignMessagePayload("overlay-edit", overlay({ viewport: { width: "wide", height: 900 } })))
		assert.ok(!isValidDesignMessagePayload("overlay-edit", overlay({ viewport: { width: Number.NaN, height: 900 } })))
		assert.ok(isValidDesignMessagePayload("overlay-edit", overlay({ viewport: undefined })))
	})

	it("rejects elements that are not an array", () => {
		assert.ok(!isValidDesignMessagePayload("overlay-edit", overlay({ elements: "c42" })))
	})
})
