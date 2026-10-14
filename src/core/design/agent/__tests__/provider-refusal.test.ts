import { strict as assert } from "assert"
import { nextWizardTurn } from "../../interview/conductor"
import type { CodingBackend } from "../backend"
import { isProviderRefusal, ProviderRefusalError } from "../backend"

/**
 * A provider that refuses the request itself (a usage limit, a closed free
 * tier, billing) gives the same answer however often it is asked. The
 * interview used to retry five times, each retried again by the server, and
 * a user whose plan had run out watched a loader for over ten minutes.
 */
describe("a provider's refusal is said at once, never retried", () => {
	it("tells a refusal from a passing failure", () => {
		for (const refusal of [
			"The usage limit has been reached",
			"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai",
			"You exceeded your current quota, please check your plan and billing details",
			"401 Unauthorized",
			"Invalid API key provided",
		]) {
			assert.ok(isProviderRefusal(refusal), refusal)
		}
		for (const passing of [
			"Rate limit reached, retry after 20s",
			"Model did not produce structured output",
			"fetch failed",
		]) {
			assert.ok(!isProviderRefusal(passing), passing)
		}
	})

	it("stops the interview at the first refusal, with the provider's own words", async () => {
		let calls = 0
		const backend = {
			async structured() {
				calls += 1
				throw new ProviderRefusalError("The usage limit has been reached")
			},
		} as unknown as CodingBackend
		await assert.rejects(
			nextWizardTurn({ backend, workingDirectory: "/tmp", description: "A product", history: [], mode: "collaborative" }),
			(err: unknown) => err instanceof ProviderRefusalError && /usage limit has been reached/.test(err.message),
		)
		assert.equal(calls, 1, "a refusal was retried")
	})
})
