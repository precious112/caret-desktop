import should from "should"

import type { ModelGroup } from "../../agent/backend"
import { pickHelperModel } from "../helper-model"

const groups: ModelGroup[] = [
	{
		providerId: "opencode-go",
		providerName: "OpenCode Go",
		subscription: true,
		models: [
			{ id: "opencode-go/gpt-5.6-luna", label: "GPT-5.6 Luna" },
			{ id: "opencode-go/gpt-5.6-terra", label: "GPT-5.6 Terra" },
			{ id: "opencode-go/claude-haiku-5-5", label: "Claude Haiku 5.5" },
		],
	},
	{
		providerId: "opencode",
		providerName: "OpenCode Zen",
		models: [{ id: "opencode/mimo-v2.6-flash-free", label: "MiMo Flash (free)", free: true }],
	},
]

describe("design pass · helper model", () => {
	it("picks the fastest connected model, Haiku over Luna, and never a free tier when a paid one exists", () => {
		pickHelperModel(groups, "", "opencode-go/gpt-5.6-terra").should.eql({
			model: "opencode-go/claude-haiku-5-5",
			label: "Claude Haiku 5.5",
		})
	})

	it("keeps the user's pick while it is still connected, and falls back when it is not", () => {
		should(pickHelperModel(groups, "opencode-go/gpt-5.6-luna", undefined).model).equal("opencode-go/gpt-5.6-luna")
		should(pickHelperModel(groups, "anthropic/claude-gone", undefined).model).equal("opencode-go/claude-haiku-5-5")
	})

	it("uses the main model for both jobs when nothing fast is connected", () => {
		const one: ModelGroup[] = [{ providerId: "x", providerName: "X", models: [{ id: "x/big", label: "Big" }] }]
		should(pickHelperModel(one, "", "x/big").model).equal("x/big")
	})

	it("falls back to a free fast model only when it is all there is besides the main model", () => {
		const free: ModelGroup[] = [
			{ providerId: "o", providerName: "O", models: [{ id: "o/flash-free", label: "Flash", free: true }] },
		]
		should(pickHelperModel(free, "", undefined).model).equal("o/flash-free")
		should(pickHelperModel([], "", "a/b")).eql({ model: "a/b", label: null })
	})
})
