/**
 * The overlay verify loop's pure half: what gets injected, when two rounds
 * count as "nothing moved", and what the model is told between rounds.
 */
import { strict as assert } from "assert"

import {
	buildOverlayMeasureScript,
	formatVerifyPrompt,
	geometryStable,
	type OverlayMeasurement,
	readOverlayVerifyContext,
} from "../verify-script"

const m = (caretId: string, x: number, y: number, width = 80, height = 120): OverlayMeasurement => ({
	caretId,
	found: true,
	tag: "img",
	rect: { x, y, width, height },
})

describe("geometryStable", () => {
	it("treats sub-tolerance drift as stable — hidden renders jitter a pixel or two", () => {
		assert.ok(geometryStable([m("c1", 100, 50)], [m("c1", 101, 49)]))
	})

	it("sees a real move", () => {
		assert.ok(!geometryStable([m("c1", 100, 50)], [m("c1", 130, 50)]))
	})

	it("sees a resize with no move", () => {
		assert.ok(!geometryStable([m("c1", 100, 50, 80, 120)], [m("c1", 100, 50, 120, 120)]))
	})

	it("treats an element that vanished as a change", () => {
		assert.ok(!geometryStable([m("c1", 100, 50)], [{ caretId: "c1", found: false }]))
	})

	it("treats an element with no previous round as a change", () => {
		assert.ok(!geometryStable([m("c1", 100, 50)], [m("c1", 100, 50), m("c2", 0, 0)]))
	})
})

describe("buildOverlayMeasureScript", () => {
	it("embeds caret-ids as JSON, never interpolated raw", () => {
		const script = buildOverlayMeasureScript(['x"] , alert(1) //', "c2"])
		assert.ok(script.includes(JSON.stringify(['x"] , alert(1) //', "c2"])), "ids are not JSON-embedded")
		assert.match(script, /CSS\.escape/, "ids reach querySelector without escaping")
	})
})

describe("readOverlayVerifyContext", () => {
	it("reads what handleOverlayEdit stows", () => {
		const ctx = readOverlayVerifyContext({
			overlayVerify: {
				filePath: "/p/.caret/pages/home/index.tsx",
				caretIds: ["c1", "c2"],
				instruction: "center it",
				viewport: { width: 1280, height: 800 },
			},
		})
		assert.deepEqual(ctx?.caretIds, ["c1", "c2"])
		assert.equal(ctx?.viewport.width, 1280)
	})

	it("returns null for turns that carry no overlay context", () => {
		assert.equal(readOverlayVerifyContext(undefined), null)
		assert.equal(readOverlayVerifyContext({}), null)
		assert.equal(readOverlayVerifyContext({ overlayVerify: { filePath: "x", instruction: "y", caretIds: [] } }), null)
	})

	it("falls back to a sane viewport rather than trusting a hostile one", () => {
		const ctx = readOverlayVerifyContext({
			overlayVerify: {
				filePath: "x",
				instruction: "y",
				caretIds: ["c1"],
				viewport: { width: Number.NaN, height: 900 },
			},
		})
		assert.deepEqual(ctx?.viewport, { width: 1440, height: 900 })
	})
})

describe("formatVerifyPrompt", () => {
	const base = {
		round: 1,
		maxRounds: 2,
		instruction: "center the clip on the shirt",
		assets: [],
		imageAttached: false,
	}

	it("states the numbers, the instruction, and the way out of the loop", () => {
		const prompt = formatVerifyPrompt({ ...base, measurements: [m("c42", 120, 40), m("c17", 0, 0, 480, 520)] })
		assert.match(prompt, /verification 1 of 2/)
		assert.match(prompt, /data-caret-id="c42".*center \(160,100\)/)
		assert.match(prompt, /center the clip on the shirt/)
		assert.match(prompt, /reply DONE and change nothing/i, "the model is given no way to end the loop")
	})

	it("names elements the render no longer contains", () => {
		const prompt = formatVerifyPrompt({ ...base, measurements: [m("c42", 120, 40), { caretId: "gone", found: false }] })
		assert.match(prompt, /Not found in the render: data-caret-id="gone"/)
	})

	it("mentions the screenshot only when one is actually attached", () => {
		const withImage = formatVerifyPrompt({ ...base, imageAttached: true, measurements: [m("c42", 120, 40)] })
		const withoutImage = formatVerifyPrompt({ ...base, measurements: [m("c42", 120, 40)] })
		assert.match(withImage, /matching the attached screenshot/i)
		assert.doesNotMatch(withoutImage, /screenshot/i, "a blind backend is promised pixels it will not get")
	})
})
