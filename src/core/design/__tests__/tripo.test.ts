import { describe, it } from "mocha"
import "should"

import { mockFetchForTesting } from "@/shared/net"
import type { CodingBackend } from "../agent/backend"
import { convertWithinBudget } from "../asset-library/tripo/budget"
import { NO_TRIPO_REASON, resolveTripoConfig, TripoClient } from "../asset-library/tripo/client"
import { decideOptimization, isRecommendedOptimizer, OPTIMIZATION_BOUNDS, WEIGHT_BAND } from "../asset-library/tripo/optimize"

describe("the 3D lane's configuration", () => {
	it("prefers the stored key, falls back to the environment, and null is normal", () => {
		resolveTripoConfig({ apiKey: "tsk_stored", env: { TRIPO_API_KEY: "tsk_env" } })!.apiKey.should.equal("tsk_stored")
		resolveTripoConfig({ env: { TRIPO_API_KEY: "tsk_env" } })!.apiKey.should.equal("tsk_env")
		;(resolveTripoConfig({ env: {} }) === null).should.be.true()
	})

	it("explains the absence without making the whole feature sound locked", () => {
		NO_TRIPO_REASON.should.containEql("works without one")
	})
})

describe("the Tripo wallet", () => {
	const reply = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

	it("reads the balance, for measuring what a run cost", async () => {
		const result = await mockFetchForTesting(
			async (input) => {
				String(input).should.containEql("/user/balance")
				return reply({ code: 0, data: { balance: 135.5, frozen: 0 } })
			},
			async () => new TripoClient({ apiKey: "tsk" }).getBalance(),
		)
		result.ok.should.be.true()
		;(result as { value: number }).value.should.equal(135.5)
	})

	it("treats a shapeless answer as cost-unknown, never as a number", async () => {
		const result = await mockFetchForTesting(
			async () => reply({ code: 0, data: { credits: "lots" } }),
			async () => new TripoClient({ apiKey: "tsk" }).getBalance(),
		)
		result.ok.should.be.false()
		;(result as { reason: string }).reason.should.containEql("no number")
	})
})

describe("recommended optimizer models", () => {
	it("matches the user's named set however a backend spells them", () => {
		// The list is the user's; the spellings are every backend's own.
		isRecommendedOptimizer("anthropic/claude-fable-5").should.be.true()
		isRecommendedOptimizer("openai/gpt-5.6-sol").should.be.true()
		isRecommendedOptimizer("GPT 5.6 Sol").should.be.true()
		isRecommendedOptimizer("moonshotai/kimi-k3-instruct").should.be.true()
		isRecommendedOptimizer("Kimi K3").should.be.true()
		isRecommendedOptimizer("zhipuai/glm-5.2").should.be.true()
		isRecommendedOptimizer("deepseek/deepseek-v4-flash").should.be.true()
	})

	it("does not light up on lookalikes", () => {
		isRecommendedOptimizer("gpt-4o").should.be.false()
		isRecommendedOptimizer("glm-4").should.be.false()
		isRecommendedOptimizer("kimi-k2").should.be.false()
		isRecommendedOptimizer("resolution-tool").should.be.false()
	})
})

describe("the optimization decision", () => {
	const fakeBackend = (value: unknown): CodingBackend =>
		({
			structured: async () => ({ value, emulated: true }),
		}) as unknown as CodingBackend

	it("clamps a face limit outside the published bounds", async () => {
		// Emulated backends parse rather than enforce, so schema-valid is a weaker
		// guarantee and the post-clamp is load-bearing, not belt-and-braces.
		const decision = await decideOptimization({
			backend: fakeBackend({ faceLimit: 500_000, textureSize: 1024, reason: "keep everything" }),
			workingDirectory: "/tmp",
			draftBytes: 4_000_000,
			intendedUse: "a decoration",
		})
		decision.faceLimit.should.equal(OPTIMIZATION_BOUNDS.faceLimit.max)
	})

	it("refuses an answer that is not usable rather than guessing one", async () => {
		await decideOptimization({
			backend: fakeBackend({ faceLimit: "lots", textureSize: 700, reason: 3 }),
			workingDirectory: "/tmp",
			draftBytes: 1_000_000,
			intendedUse: "a decoration",
		}).should.be.rejectedWith(/not usable/)
	})
})

describe("holding the optimizer to the weight band", () => {
	const client = (sizes: number[]): TripoClient => {
		const calls: Array<{ faceLimit: number; textureSize: number }> = []
		const fake = {
			calls,
			convertModel: async (_id: string, options: { faceLimit: number; textureSize: number }) => {
				calls.push(options)
				const bytes = Buffer.alloc(sizes[Math.min(calls.length - 1, sizes.length - 1)])
				return { ok: true as const, value: { bytes, taskId: `t${calls.length}` } }
			},
		}
		return fake as unknown as TripoClient
	}

	const decision = { faceLimit: 8_000, textureSize: 1024 as const, reason: "test" }

	it("keeps an in-band result without a second convert", async () => {
		const fake = client([4 * 1024 * 1024])
		const result = await convertWithinBudget(fake, "draft", decision, () => {})
		result.ok.should.be.true()
		if (!result.ok) return
		;(result.value.corrected === undefined).should.be.true()
		;(fake as unknown as { calls: unknown[] }).calls.should.have.length(1)
	})

	it("escalates textures first when the result comes in melted-small", async () => {
		// The observed damage: 740KB with 1024px textures gave labels a look like
		// plastic melted under heat. The corrective pass exists for exactly this.
		const fake = client([740 * 1024, 4 * 1024 * 1024])
		const result = await convertWithinBudget(fake, "draft", decision, () => {})
		result.ok.should.be.true()
		if (!result.ok) return
		result.value.applied.textureSize.should.equal(2048)
		result.value.applied.faceLimit.should.equal(16_000)
		String(result.value.corrected).should.containEql("below")
		result.value.bytes.length.should.be.aboveOrEqual(WEIGHT_BAND.minBytes)
	})

	it("corrects once, never loops — a second miss is the user's call", async () => {
		const fake = client([500 * 1024, 900 * 1024])
		const result = await convertWithinBudget(fake, "draft", decision, () => {})
		result.ok.should.be.true()
		;(fake as unknown as { calls: unknown[] }).calls.should.have.length(2)
	})

	it("accepts a light result when every knob is already at its top", async () => {
		// A genuinely small object is a fact, not a defect.
		const fake = client([600 * 1024])
		const maxed = { faceLimit: OPTIMIZATION_BOUNDS.faceLimit.max, textureSize: 4096 as const, reason: "max" }
		const result = await convertWithinBudget(fake, "draft", maxed, () => {})
		result.ok.should.be.true()
		;(fake as unknown as { calls: unknown[] }).calls.should.have.length(1)
	})

	it("admits 4096 textures now that labels are the binding constraint", () => {
		OPTIMIZATION_BOUNDS.textureSizes.should.containEql(4096)
	})
})
