import { describe, it } from "mocha"
import "should"

import { applyMention, mentionQueryAt, rankMentions } from "../mentions"

const assets = [
	{ tag: "hero-shot", description: "wide, dark, room top-left" },
	{ tag: "hero-mobile", description: "tall crop" },
	{ tag: "team-photo", description: "a dark workbench" },
]

describe("mention matching", () => {
	it("finds the partial tag under the caret, wherever the caret is", () => {
		mentionQueryAt("Put @her", 8)!.should.deepEqual({ query: "her", start: 4 })
		mentionQueryAt("Put @her behind it", 8)!.should.deepEqual({ query: "her", start: 4 })
		mentionQueryAt("@", 1)!.should.deepEqual({ query: "", start: 0 })
	})

	it("stays shut for text that merely contains an @", () => {
		;(mentionQueryAt("mail bob@example.com", 20) === null).should.be.true()
		;(mentionQueryAt("Put @hero behind it", 19) === null).should.be.true()
	})

	it("leads with prefix matches, then searches descriptions", () => {
		rankMentions(assets, "hero")
			.map((a) => a.tag)
			.should.deepEqual(["hero-shot", "hero-mobile"])
		// "the dark one" is how a person remembers an asset they named months ago.
		rankMentions(assets, "dark")
			.map((a) => a.tag)
			.should.deepEqual(["hero-shot", "team-photo"])
		rankMentions(assets, "").should.have.length(3)
	})

	it("replaces only the partial tag and leaves the rest of the line alone", () => {
		const result = applyMention("Put @her behind it", 8, 4, "hero-shot")
		result.value.should.equal("Put @hero-shot  behind it")
		result.caret.should.equal(15)
	})
})
