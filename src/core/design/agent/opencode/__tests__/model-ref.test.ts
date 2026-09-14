/**
 * Effort reaches the server as the model ref's `variant` — or the setting is
 * dead, which it was: the preference existed, the conversation passed it down,
 * and the adapter dropped it on the floor. A 5½-minute reasoning turn ran at
 * the model's default (measured near `high`) while the user's pref said so
 * harmlessly in a JSON file.
 */
import { strict as assert } from "assert"

import { modelRef } from "../index"

describe("modelRef", () => {
	it("splits provider/model and carries no variant when effort is unset", () => {
		assert.deepEqual(modelRef("opencode-go/ox-alpha-free"), {
			model: { providerID: "opencode-go", modelID: "ox-alpha-free" },
		})
	})

	it("rides effort along as the server's TOP-LEVEL variant — inside the model ref it is silently stripped", () => {
		assert.deepEqual(modelRef("opencode-go/ox-alpha-free", "low"), {
			model: { providerID: "opencode-go", modelID: "ox-alpha-free" },
			variant: "low",
		})
	})

	it("keeps the model id's own slashes intact", () => {
		assert.deepEqual(modelRef("openrouter/anthropic/claude-sonnet-5", "high"), {
			model: { providerID: "openrouter", modelID: "anthropic/claude-sonnet-5" },
			variant: "high",
		})
	})

	it("translates minimal to low — the ladders have no minimal, and a miss means default", () => {
		assert.deepEqual(modelRef("openai/gpt-5.4-mini", "minimal"), {
			model: { providerID: "openai", modelID: "gpt-5.4-mini" },
			variant: "low",
		})
	})

	it("returns null without a model, even when effort is set", () => {
		assert.equal(modelRef(undefined, "high"), null)
		assert.equal(modelRef("no-slash", "high"), null)
	})
})
