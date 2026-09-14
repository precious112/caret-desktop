/**
 * A mark floats; a background rect ships as a coloured box on every surface
 * but the one it was drawn against. The Smolder logo is the field case: a
 * `<rect width="512" height="512" fill="#121212"/>` invisible on the dark
 * landing page and a solid square anywhere else.
 */
import { strict as assert } from "assert"

import { stripBackgroundRect } from "../svg-mark"

describe("stripBackgroundRect", () => {
	it("strips the Smolder case: a full-canvas rect at the origin", () => {
		const svg =
			'<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">\n' +
			'  <rect width="512" height="512" fill="#121212"/>\n' +
			'  <path fill="#e76f56" d="M256 107 L200 200 Z"/>\n' +
			"</svg>"
		const stripped = stripBackgroundRect(svg)
		assert.ok(!stripped.includes("<rect"), "the background square survived")
		assert.ok(stripped.includes('<path fill="#e76f56"'), "the mark itself was harmed")
	})

	it("keeps a rect that is part of the mark", () => {
		const svg =
			'<svg viewBox="0 0 512 512">' +
			'<rect x="180" y="180" width="152" height="152" fill="#e76f56"/>' +
			'<circle cx="256" cy="256" r="40" fill="#fff"/>' +
			"</svg>"
		assert.equal(stripBackgroundRect(svg), svg)
	})

	it("keeps a rounded full-bleed square — that can be a deliberate badge shape", () => {
		const svg = '<svg viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#121212"/></svg>'
		assert.equal(stripBackgroundRect(svg), svg)
	})

	it("leaves an svg without a parseable viewBox alone", () => {
		const svg = '<svg width="512" height="512"><rect width="512" height="512" fill="#000"/></svg>'
		assert.equal(stripBackgroundRect(svg), svg)
	})
})
