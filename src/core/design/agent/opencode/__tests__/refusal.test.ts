/**
 * What a user is told when a model will not run.
 *
 * The entitlement probe exists because no catalogue knows whether a plan covers
 * a model — a subscription lists models it will refuse, and without asking, the
 * refusal arrives minutes later inside a turn somebody thought was working. But
 * a refusal is only useful if it is readable: the transport error this path
 * catches is addressed to a developer, and the first version of the picker put
 * `The coding backend refused POST /session/ses_fee93.../message (500). {"name":
 * "UnknownError",...}` in the composer, under a model name, as an explanation.
 */
import { strict as assert } from "assert"

import { sentenceIn } from "../index"

describe("the sentence in a refusal", () => {
	it("digs the provider's own message out of a nested error body", () => {
		const raw =
			'The coding backend refused POST /session/ses_abc/message (500). {"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_b0b0"}}'
		assert.equal(sentenceIn(raw), "Unexpected server error. Check server logs for details.")
	})

	it("takes a top-level message when there is no data envelope", () => {
		assert.equal(
			sentenceIn('refused (404). {"message":"This model is unavailable for free"}'),
			"This model is unavailable for free",
		)
	})

	it("prefers the inner message when both are present, because the outer one is the wrapper", () => {
		const raw = '{"message":"Request failed","data":{"message":"Your plan does not include gpt-5.6-sol"}}'
		assert.equal(sentenceIn(raw), "Your plan does not include gpt-5.6-sol")
	})

	it("admits it does not know rather than quoting machine noise", () => {
		// Nothing quotable: no body at all, a body that is not JSON, and a body
		// whose message is empty. All three used to reach the composer verbatim.
		assert.equal(sentenceIn("socket hang up"), "the provider would not accept this model")
		assert.equal(sentenceIn("refused (500). {not json at all"), "the provider would not accept this model")
		assert.equal(sentenceIn('{"data":{"message":"   "}}'), "the provider would not accept this model")
	})
})
