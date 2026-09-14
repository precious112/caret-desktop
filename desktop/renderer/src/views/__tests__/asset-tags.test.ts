/**
 * The rules for what lights up as a tag in chat text.
 *
 * The stake is small but sharp: a false positive is a click that opens the
 * viewer onto nothing, and a false negative is a reference the user cannot
 * follow. Both halves of the chat — user bubbles and assistant markdown —
 * run on this one tokenizer, so these rules are the whole contract.
 */
import { strict as assert } from "assert"

import { assetTagHref, remarkAssetTags, splitAssetTags } from "../asset-tags"

const TAGS = new Set(["hero-image", "grain", "logo2"])

describe("splitAssetTags", () => {
	it("finds a known tag and keeps the text around it", () => {
		assert.deepEqual(splitAssetTags("use @grain behind the header", TAGS), [
			{ kind: "text", text: "use " },
			{ kind: "tag", tag: "grain" },
			{ kind: "text", text: " behind the header" },
		])
	})

	it("leaves @words that are not tags as plain text", () => {
		assert.deepEqual(splitAssetTags("ping @sam about @grain", TAGS), [
			{ kind: "text", text: "ping @sam about " },
			{ kind: "tag", tag: "grain" },
		])
	})

	it("stops at punctuation, so a tag ending a clause still matches", () => {
		const segments = splitAssetTags("try @hero-image, or @grain?", TAGS)
		assert.deepEqual(
			segments.filter((segment) => segment.kind === "tag"),
			[
				{ kind: "tag", tag: "hero-image" },
				{ kind: "tag", tag: "grain" },
			],
		)
		assert.deepEqual(segments[1], { kind: "tag", tag: "hero-image" })
		assert.deepEqual(segments[2], { kind: "text", text: ", or " })
	})

	it("does not fire mid-word, so an email address stays an email address", () => {
		assert.deepEqual(splitAssetTags("mail grain@grain.dev", TAGS), [{ kind: "text", text: "mail grain@grain.dev" }])
	})

	it("refuses a longer token that merely begins with a known tag", () => {
		// "@hero-imagery" is a different word, not "hero-image" plus a suffix.
		assert.deepEqual(splitAssetTags("the @hero-imagery here", TAGS), [{ kind: "text", text: "the @hero-imagery here" }])
	})

	it("matches digits in tags", () => {
		assert.deepEqual(splitAssetTags("@logo2", TAGS), [{ kind: "tag", tag: "logo2" }])
	})

	it("returns one plain segment when the library is empty", () => {
		assert.deepEqual(splitAssetTags("use @grain", new Set<string>()), [{ kind: "text", text: "use @grain" }])
	})
})

describe("remarkAssetTags", () => {
	interface Node {
		type: string
		value?: string
		url?: string
		children?: Node[]
	}

	it("rewrites a matching text node into the link the renderer intercepts", () => {
		const paragraph: Node = { type: "paragraph", children: [{ type: "text", value: "put @grain behind it" }] }
		remarkAssetTags(TAGS)({ type: "root", children: [paragraph] })

		assert.equal(paragraph.children?.length, 3)
		const link = paragraph.children?.[1]
		assert.equal(link?.type, "link")
		assert.equal(link?.url, assetTagHref("grain"))
		assert.deepEqual(link?.children, [{ type: "text", value: "@grain" }])
	})

	it("leaves a paragraph with no known tags untouched, same node and all", () => {
		const text: Node = { type: "text", value: "nothing @here" }
		const paragraph: Node = { type: "paragraph", children: [text] }
		remarkAssetTags(TAGS)({ type: "root", children: [paragraph] })
		assert.equal(paragraph.children?.[0], text)
	})

	it("does not rewrite inside an existing link", () => {
		const link: Node = { type: "link", url: "https://example.com", children: [{ type: "text", value: "see @grain" }] }
		const paragraph: Node = { type: "paragraph", children: [link] }
		remarkAssetTags(TAGS)({ type: "root", children: [paragraph] })
		assert.deepEqual(link.children, [{ type: "text", value: "see @grain" }])
	})
})
