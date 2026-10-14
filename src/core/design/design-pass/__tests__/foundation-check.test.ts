import { commonValues, commonValuesComplaint } from "../foundation-check"

const none = { words: "", colours: [], fonts: [] }

describe("design pass · foundation suggestions", () => {
	it("finds a cream, a terracotta, Inter and Fraunces among the suggestions", () => {
		const found = commonValues({ colours: ["#F5F0E6", "#D97757", "#1F6FEB"], fonts: ["Fraunces", "Inter", "Manrope"] }, none)
		found.map((f) => f.value).should.eql(["#F5F0E6", "#D97757", "Fraunces", "Inter"])
	})

	it("never counts near-black, grey or white", () => {
		commonValues({ colours: ["#0B0B0B", "#808080", "#FFFFFF"], fonts: [] }, none).should.eql([])
	})

	it("leaves alone whatever the user picked, typed or named in their own words", () => {
		commonValues(
			{ colours: ["#F5F0E6"], fonts: ["Inter"] },
			{ words: "", colours: ["#F5F0E6"], fonts: ["inter"] },
		).should.eql([])
		commonValues(
			{ colours: ["#D97757"], fonts: ["Fraunces"] },
			{ words: "Our packaging uses Fraunces and #d97757.", colours: [], fonts: [] },
		).should.eql([])
	})

	it("names each value and its habit when it complains", () => {
		const text = commonValuesComplaint([{ value: "Inter", habit: "Default sans font" }])
		text.should.containEql("Inter (Default sans font) is among the most common AI design defaults")
	})
})
