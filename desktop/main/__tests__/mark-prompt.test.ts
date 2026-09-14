/**
 * The mark prompt's measured lessons, pinned.
 *
 * The failure this suite holds down shipped and was called out by the user: a
 * "lazily hand-drawn blob" of a mark, caused by photograph language pasted
 * into a flat-vector prompt and by three takes rolling one identical prompt.
 * caret-learning/mark-probe holds the A/B images; these tests hold the code.
 */
import { strict as assert } from "assert"
import type { GeneratorPalette } from "../../../src/core/design"
import { MARK_DIRECTIONS, nextDirections, TARGET_AVOID, targetPrompt } from "../mark-prompt"

const PALETTE: GeneratorPalette = {
	surface: "#141210",
	raised: "#24211e",
	ink: "#eeedec",
	brand: "#e97e54",
	brandQuiet: "#c7643d",
	mode: "dark",
}

describe("the mark target prompt", () => {
	const prompt = targetPrompt("a single ember", PALETTE, MARK_DIRECTIONS[0])

	it("frames the brief as an idea a studio reduces, never a picture to draw", () => {
		assert.match(prompt, /The idea behind the mark: a single ember/)
		assert.match(prompt, /never as a picture of the thing/i)
	})

	it("carries no photograph language — the measured cause of the blob", () => {
		// foundationWords() phrases. Any of them reappearing means the photo
		// vocabulary leaked back into the vector prompt.
		for (const leak of ["deep shadows", "soft light source", "frame in shadow", "sand, clay, oatmeal", "Low-key"]) {
			assert.ok(!prompt.includes(leak), `photograph language leaked into the mark prompt: "${leak}"`)
		}
	})

	it("states the colour and background constraints positively", () => {
		assert.match(prompt, /exactly three flat solid colours/)
		assert.ok(prompt.includes(PALETTE.brand) && prompt.includes(PALETTE.ink) && prompt.includes(PALETTE.surface))
		assert.match(prompt, /background that fills every edge of the frame/)
	})

	it("keeps the negative tail short — bans lose to positive language", () => {
		assert.ok(TARGET_AVOID.length <= 3, `the avoid list is growing again (${TARGET_AVOID.length} entries)`)
	})
})

describe("the design directions", () => {
	it("are a real pool: unique ids, unique labels, distinct prompts", () => {
		const ids = new Set(MARK_DIRECTIONS.map((d) => d.id))
		const labels = new Set(MARK_DIRECTIONS.map((d) => d.label))
		const prompts = new Set(MARK_DIRECTIONS.map((d) => d.prompt))
		assert.equal(ids.size, MARK_DIRECTIONS.length)
		assert.equal(labels.size, MARK_DIRECTIONS.length)
		assert.equal(prompts.size, MARK_DIRECTIONS.length)
		assert.ok(MARK_DIRECTIONS.length >= 6, "the pool must cover two rounds of three")
	})

	it("hands every take in a batch a different approach", () => {
		const batch = nextDirections("/tmp/pool-test-a", 3)
		assert.equal(new Set(batch.map((d) => d.id)).size, 3, "a batch repeated an approach — the twins bug")
	})

	it("rotates: fresh options are fresh, not rerolls", () => {
		const first = nextDirections("/tmp/pool-test-b", 3).map((d) => d.id)
		const second = nextDirections("/tmp/pool-test-b", 3).map((d) => d.id)
		assert.deepEqual(
			first.filter((id) => second.includes(id)),
			[],
			"the second round repeated the first round's approaches",
		)
	})

	it("changes the generated prompt, not just the label", () => {
		const a = targetPrompt("a single ember", PALETTE, MARK_DIRECTIONS[0])
		const b = targetPrompt("a single ember", PALETTE, MARK_DIRECTIONS[1])
		assert.notEqual(a, b, "two directions produced one prompt — three takes would be twins again")
	})
})
