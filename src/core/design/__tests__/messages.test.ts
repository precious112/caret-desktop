import { describe, it } from "mocha"
import "should"

import { isValidDesignMessagePayload } from "../rendering-shell/messages"

describe("isValidDesignMessagePayload", () => {
	it("accepts well-formed payloads", () => {
		isValidDesignMessagePayload("inline-edit", {
			editType: "text",
			filePath: "pages/home/index.tsx",
			lineNumber: 12,
			oldValue: "Hi",
			newValue: "Hello",
		}).should.be.true()
		isValidDesignMessagePayload("flow-edge-create", { flowId: "billing", fromPage: "a", toPage: "b" }).should.be.true()
		isValidDesignMessagePayload("flow-edge-update", {
			flowId: "billing",
			fromPage: "a",
			oldToPage: "b",
			newToPage: "c",
		}).should.be.true()
		isValidDesignMessagePayload("open-file", { filePath: "pages/home/index.tsx" }).should.be.true()
		isValidDesignMessagePayload("log", { level: "info", message: "x" }).should.be.true()
	})

	it("rejects missing or empty required fields", () => {
		isValidDesignMessagePayload("inline-edit", {}).should.be.false()
		isValidDesignMessagePayload("inline-edit", {
			editType: "text",
			filePath: "",
			lineNumber: 1,
			newValue: "x",
		}).should.be.false()
		isValidDesignMessagePayload("inline-edit", {
			editType: "resize",
			filePath: "a.tsx",
			lineNumber: 1,
			newValue: "x",
		}).should.be.false()
		isValidDesignMessagePayload("flow-edge-create", { flowId: "billing", fromPage: "a" }).should.be.false()
		isValidDesignMessagePayload("flow-edge-update", { flowId: "billing", fromPage: "a", oldToPage: "b" }).should.be.false()
		isValidDesignMessagePayload("open-file", { filePath: 42 }).should.be.false()
	})

	it("rejects non-object payloads", () => {
		isValidDesignMessagePayload("inline-edit", null).should.be.false()
		isValidDesignMessagePayload("inline-edit", "string").should.be.false()
		isValidDesignMessagePayload("flow-edge-delete", undefined).should.be.false()
	})

	it("rejects non-finite line numbers", () => {
		isValidDesignMessagePayload("inline-edit", {
			editType: "text",
			filePath: "a.tsx",
			lineNumber: Number.NaN,
			newValue: "x",
		}).should.be.false()
	})

	it("lets unknown message types through (ignored downstream)", () => {
		isValidDesignMessagePayload("future-type", { whatever: true }).should.be.true()
	})

	it("validates promote-token payloads", () => {
		isValidDesignMessagePayload("promote-token", {
			token: "brand-500",
			hex: "#123456",
			filePath: "pages/home/index.tsx",
			lineNumber: 4,
		}).should.be.true()
		isValidDesignMessagePayload("promote-token", { token: "brand-500", hex: "#123456" }).should.be.false()
		isValidDesignMessagePayload("promote-token", {
			token: "",
			hex: "#123456",
			filePath: "a.tsx",
			lineNumber: 1,
		}).should.be.false()
	})
})
