/**
 * The streaming case.
 *
 * A turn arrives a token at a time, so for most of its life the assistant's
 * markdown is *invalid* — a fence is open and its closing ``` hasn't been typed
 * yet. Parsed as-is that renders literal backticks that then snap into a box
 * when the fence lands, so the code visibly flickers while it streams. The
 * parser is handed a virtually-closed copy instead; the stored text is never
 * touched.
 */
import { strict as assert } from "assert"

import { closeOpenFence } from "../Markdown"

describe("closeOpenFence", () => {
	it("closes a fence the model is still typing", () => {
		const streaming = '```tsx\nexport function Hero() {\n  return <section className="py-24"'
		assert.equal(closeOpenFence(streaming), `${streaming}\n\`\`\``)
	})

	it("leaves a finished fence alone", () => {
		const complete = "```tsx\nconst x = 1\n```"
		assert.equal(closeOpenFence(complete), complete)
	})

	it("leaves prose with no fence at all alone", () => {
		const prose = "Just **bold** text and `inline code`."
		assert.equal(closeOpenFence(prose), prose)
	})

	it("closes only the last of several blocks", () => {
		// Two complete fences and a third still open: four markers would be even
		// and wrongly read as closed, so the count has to be of every fence line.
		const text = "```sh\nnpm test\n```\n\ntext\n\n```sh\nnpm run build\n```\n\n```tsx\nconst x ="
		assert.equal(closeOpenFence(text), `${text}\n\`\`\``)
	})

	it("treats a fence carrying a language as opening, not closing", () => {
		assert.equal(closeOpenFence("```json"), "```json\n```")
	})
})
