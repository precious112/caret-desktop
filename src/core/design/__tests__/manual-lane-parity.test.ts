/**
 * The manual lane must be able to say everything the token model can hold.
 *
 * Found in the field, during the first real manual-lane run: the wizard's tag
 * picker offered 8 of the library's 51 recognised tags, its weight picker
 * allowed one display weight, its radius step was four presets with no
 * numbers, and its spacing step was a 4-or-8 binary. The person who chose
 * "handle everything yourself" — the one user with exact opinions — could
 * express LESS than the interview. These tests pin the parity that fixed it.
 */
import { strict as assert } from "assert"
import * as fs from "fs"
import * as path from "path"
import { LIBRARY_TAGS } from "../foundation-library"

// Read as text: the renderer tree is outside this tsconfig project, and a
// drift pin needs the literal list the picker renders, not a re-export.
function wizardVibeTags(): string[] {
	const file = path.join(__dirname, "../../../../desktop/renderer/src/components/design-wizard/data-steps.ts")
	const source = fs.readFileSync(file, "utf-8")
	const match = source.match(/export const VIBE_TAGS = \[([\s\S]*?)\] as const/)
	assert.ok(match, "VIBE_TAGS not found in data-steps.ts — the pin needs updating, not deleting")
	return [...match[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1])
}

describe("the manual lane's vocabulary", () => {
	it("offers every tag the foundation library recognises", () => {
		const offered = new Set(wizardVibeTags())
		const missing = LIBRARY_TAGS.filter((tag) => !offered.has(tag))
		assert.deepEqual(missing, [], "the wizard's tag picker drifted behind the library's vocabulary")
	})

	it("offers no tag the library would silently ignore", () => {
		const known = new Set(LIBRARY_TAGS)
		const dead = wizardVibeTags().filter((tag) => !known.has(tag))
		assert.deepEqual(dead, [], "a tag the library does not recognise narrows nothing — offering it is a lie")
	})
})
