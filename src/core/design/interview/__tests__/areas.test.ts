/**
 * The 12 topics and their allowed values: the rules the screen, the engine
 * and the saving step all share.
 */
import { strict as assert } from "assert"
import * as fs from "fs"
import * as path from "path"

import { AREA_ORDER, AREAS, describeValue, isAreaValue, RANGES, radiusPx, SHADOW_PREVIEW, specOf } from "../areas"
import { finalizeProposal } from "../finalize"

describe("interview topics", () => {
	it("keeps the topic ids saved in existing foundations", () => {
		// These ids are written into every committed foundation's decisions, and
		// the design system view reads them back. Renaming one orphans old files.
		assert.deepEqual([...AREA_ORDER].sort(), [
			"accent-color",
			"body-type",
			"brand-color",
			"depth",
			"display-type",
			"neutral",
			"radius",
			"secondary-color",
			"semantics",
			"spacing",
			"surface",
			"type-scale",
		])
	})

	it("asks the topics in the agreed order", () => {
		assert.deepEqual(
			[...AREA_ORDER],
			[
				"surface",
				"display-type",
				"body-type",
				"type-scale",
				"brand-color",
				"secondary-color",
				"accent-color",
				"neutral",
				"semantics",
				"spacing",
				"radius",
				"depth",
			],
		)
	})

	it("the size limits are the limits saving uses: an edge value is saved unchanged, never clamped", () => {
		for (const baseSize of [RANGES.baseSize.min, RANGES.baseSize.max]) {
			for (const scaleRatio of [RANGES.scaleRatio.min, RANGES.scaleRatio.max]) {
				assert.ok(isAreaValue("type-scale", { baseSize, scaleRatio }))
				const { tokens } = finalizeProposal(
					{
						displayFamily: "A",
						bodyFamily: "B",
						scaleRatio,
						baseSize,
						brand: "#1d7ec4",
						neutral: "cool",
						surface: "dark",
						spacingUnit: 8,
						radiusCharacter: "soft",
						rule: "r",
						summary: "s",
					},
					"",
				)
				assert.equal(tokens.typography.baseSize, baseSize)
				assert.equal(tokens.typography.scaleRatio, scaleRatio)
			}
		}
		for (const baseSize of [RANGES.baseSize.min - 1, RANGES.baseSize.max + 1, 16.5]) {
			assert.equal(isAreaValue("type-scale", { baseSize, scaleRatio: 1.2 }), false, `${baseSize}px was allowed`)
		}
	})

	it("spacing allows only what the design system can store: 4px or 8px", () => {
		assert.ok(isAreaValue("spacing", { spacingUnit: 4 }))
		assert.ok(isAreaValue("spacing", { spacingUnit: 8 }))
		for (const unit of [2, 6, 12]) assert.equal(isAreaValue("spacing", { spacingUnit: unit }), false)
	})

	it("colours must be tidy #rrggbb; only supporting and accent allow None", () => {
		assert.ok(isAreaValue("brand-color", { hex: "#28a4f0" }))
		assert.equal(isAreaValue("brand-color", { hex: "#28A4F0" }), false, "an untidy hex reached a saved answer")
		assert.equal(isAreaValue("brand-color", { none: true }), false)
		assert.ok(isAreaValue("secondary-color", { none: true }))
		assert.ok(isAreaValue("accent-color", { none: true }))
	})

	it("the preview's corners and shadows show what each choice saves", () => {
		for (const character of ["sharp", "soft", "round", "pill"] as const) {
			const { tokens } = finalizeProposal(
				{
					displayFamily: "A",
					bodyFamily: "B",
					scaleRatio: 1.2,
					baseSize: 16,
					brand: "#1d7ec4",
					neutral: "cool",
					surface: "dark",
					spacingUnit: 8,
					radiusCharacter: character,
					rule: "r",
					summary: "s",
				},
				"",
			)
			assert.ok(
				tokens.radius.scale.includes(radiusPx(character)),
				`${character}: the preview's ${radiusPx(character)}px is not a saved step`,
			)
			assert.equal(specOf("radius", { radiusCharacter: character }).radius, radiusPx(character))
		}
		assert.equal(new Set(Object.values(SHADOW_PREVIEW)).size, 3, "two depths preview identically")
	})

	it("every topic describes every allowed value in plain words", () => {
		for (const area of AREA_ORDER) {
			for (const value of AREAS[area].fixedValues ?? []) {
				assert.ok(describeValue(area, value).length > 1, `${area} has no words for ${JSON.stringify(value)}`)
			}
		}
	})

	it("the files the screen shares import nothing the screen can't load", () => {
		// The screen can't load Node modules, the engine's "@/" paths, or zod.
		// A forbidden import here breaks the app's build, so it is caught early.
		const allowed = new Set(["./areas", "./state", "./widgets", "../foundation-library/presets"])
		for (const file of ["areas.ts", "state.ts", "answers.ts"]) {
			const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
			for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
				assert.ok(allowed.has(match[1]), `${file} imports "${match[1]}", which the screen may not load`)
			}
		}
	})
})
