import "should"

import { flexWidthEncodingFor } from "../encoding"

describe("encoding policy — read the repo, don't guess", () => {
	it("cold start takes the default worth propagating", () => {
		flexWidthEncodingFor([]).should.equal("basis")
	})
	it("matches an established flex-shorthand convention", () => {
		flexWidthEncodingFor(['<div className="flex-[0_0_240px]">', '<div className="flex-[0_0_120px]">']).should.equal(
			"flex-shorthand",
		)
	})
	it("basis convention (or a tie) stays basis", () => {
		flexWidthEncodingFor(['<div className="basis-[240px] shrink-0">', '<div className="flex-[0_0_120px]">']).should.equal(
			"basis",
		)
	})
})
