/**
 * Does the refinement stage help, model by model?
 *
 * Runs the SHIPPED `refineBrief` prompt against several backend models and
 * scores each output with deterministic checks aimed at the measured failure
 * modes: information deletion, page-facts painted into the picture, subject
 * swaps, and missing craft additions on vague input. No Electron, no image
 * spend — text calls only, on the configured backend.
 *
 *   npx tsx scripts/eval-refine-brief.ts [modelFilter ...]
 */

import type { AssetRequest } from "../src/core/design"
import { refineBrief } from "../src/core/design"
import { stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { getBackend } from "../src/core/design/agent/registry"

const WANTED = process.argv.slice(2).length
	? process.argv.slice(2)
	: ["glm-5.3-flash", "deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.6-luna"]

interface Check {
	name: string
	pass(brief: string): boolean
}

interface Case {
	name: string
	request: AssetRequest
	checks: Check[]
}

const has = (brief: string, ...alternatives: RegExp[]) => alternatives.some((pattern) => pattern.test(brief))

/**
 * The cases mirror the run's real inputs: a complete pro brief whose
 * constraints must survive, a vague amateur brief that must gain craft, and
 * page-placement answers that must become composition, not content.
 */
const CASES: Case[] = [
	{
		name: "complete 3D brief keeps its exclusions",
		request: {
			kind: "object3d",
			text:
				"A sculptural cantilevered chair pressed from a single continuous sheet of matte red-orange aluminium, " +
				"seen in three-quarter view: the sheet rises from the floor, folds into the seat, and folds again into " +
				"the backrest, one unbroken surface with crisp radiused bends. No cushions, no legs, no hardware, no " +
				"text anywhere on it. A real industrial-design object, museum quality, on a plain seamless background.",
			answers: { "How should the chair be proportioned?": "Low lounge - seat close to the floor, backrest tilted back" },
		},
		checks: [
			{ name: "keeps no-hardware", pass: (b) => has(b, /hardware|fastener|screw|bolt|rivet/i) },
			{
				name: "keeps no-text",
				pass: (b) =>
					has(
						b,
						/no (visible )?(text|lettering|logos?|words|branding|print)/i,
						/free of (text|lettering)/i,
						/without (any )?(text|lettering)/i,
					),
			},
			{ name: "keeps material", pass: (b) => has(b, /aluminium|aluminum/i) && has(b, /matte/i) },
			{ name: "keeps one-sheet story", pass: (b) => has(b, /single|one|continuous|unbroken/i) && has(b, /sheet|surface/i) },
			{ name: "folds in the answer", pass: (b) => has(b, /low|close to the (floor|ground)/i) },
			{ name: "keeps subject", pass: (b) => has(b, /chair/i) },
		],
	},
	{
		name: "vague amateur brief gains craft",
		request: {
			kind: "image",
			text: "a cozy photo of coffee",
			answers: { "What exactly should be in the picture?": "beans spilling from a bag" },
		},
		checks: [
			{ name: "keeps subject", pass: (b) => has(b, /coffee/i) },
			{ name: "keeps the answer", pass: (b) => has(b, /bean/i) && has(b, /bag|sack/i) },
			{ name: "adds a light", pass: (b) => has(b, /light|lamp|lit|glow|shadow|sun/i) },
			{
				name: "adds camera or material",
				pass: (b) => has(b, /macro|lens|\d{2,3}\s?mm|close-up|wood|ceramic|linen|burlap|kraft|slate/i),
			},
			{ name: "sharpens cozy physically", pass: (b) => has(b, /warm/i) },
		],
	},
	{
		name: "page placement becomes composition, not content",
		request: {
			kind: "image",
			text:
				"Extreme macro close-up of a matte-black metal card tilted diagonally across the frame, a single thin " +
				"engraved line catching the light as a warm glint.",
			answers: {
				"Where will this image sit in the design?":
					"Full-bleed hero background, a short headline will sit over its darkest area",
			},
		},
		checks: [
			{
				name: "reserves empty space",
				pass: (b) => has(b, /empty|quiet|clear|calm|negative space|unbroken|dark(est)? (area|region|corner|third)/i),
			},
			{
				name: "puts no text in the picture",
				// The brief may MENTION the headline only to exclude it or to reserve
				// space for it; it must never direct text into the image.
				pass: (b) =>
					!has(
						b,
						/card (reads|reading|displays|shows|says)/i,
						/with the (headline|words?|text) ["'']/i,
						/lettering (reads|across)/i,
					) &&
					has(
						b,
						/no (text|lettering|words)/i,
						/nothing in it/i,
						/free of (text|lettering)/i,
						/without (any )?(text|lettering|words)/i,
					),
			},
			{ name: "keeps the subject", pass: (b) => has(b, /card/i) && has(b, /engraved|line/i) },
			{ name: "keeps the framing", pass: (b) => has(b, /diagonal/i) },
		],
	},
	{
		name: "grammar is fixed without losing meaning",
		request: {
			kind: "mark",
			text: "a logo of a ember thats look like a mountain peak with fire inside it",
		},
		checks: [
			{ name: "keeps both ideas", pass: (b) => has(b, /mountain|peak|triangle/i) && has(b, /ember|fire|flame|heat/i) },
			{ name: "reduces to construction", pass: (b) => has(b, /circle|arc|triangle|bar|wedge|shape|cut|stroke|line|form/i) },
			{ name: "no broken grammar carried", pass: (b) => !has(b, /thats look/i) },
			{ name: "mechanical, not organic", pass: (b) => !has(b, /wobbly|hand-drawn|rough edges|irregular contour/i) },
		],
	},
	{
		name: "already-professional brief survives nearly untouched",
		request: {
			kind: "image",
			text:
				"Shot on a 100mm macro lens at f/4, one hard cool light raking low from the left, the background a flat " +
				"near-black void, no fill light. Corner detail of a matte-black anodised metal payment card on dark " +
				"slate, so close the frame holds only the corner's radius and two milled edges, one warm glint tracing " +
				"the chamfer. The photograph contains no text anywhere.",
		},
		checks: [
			{ name: "keeps the lens", pass: (b) => has(b, /100\s?mm|macro/i) },
			{ name: "keeps the light", pass: (b) => has(b, /raking|low|hard/i) && has(b, /left/i) },
			{ name: "keeps no-fill", pass: (b) => has(b, /no fill|single (light|source)|one (light|source)|only light/i) },
			{ name: "keeps no-text", pass: (b) => has(b, /no (text|lettering|words)/i, /without (any )?text/i, /free of text/i) },
			{ name: "keeps the surface", pass: (b) => has(b, /slate/i) },
			{ name: "keeps the glint", pass: (b) => has(b, /glint|chamfer/i) },
		],
	},
]

async function main(): Promise<void> {
	const backend = getBackend("opencode")
	try {
		const groups = (await backend.listModels?.()) ?? []
		const all = groups.flatMap((group) => group.models.map((model) => model.id))
		const models = WANTED.map((want) => {
			const hit = all.find((id) => id.toLowerCase().includes(want.toLowerCase()))
			if (!hit) console.log(`NOT AVAILABLE: ${want}`)
			return hit
		}).filter((id): id is string => Boolean(id))

		console.log(
			`\nEvaluating ${models.length} model(s), ${CASES.length} cases, ${CASES.reduce((n, c) => n + c.checks.length, 0)} checks each\n`,
		)

		for (const model of models) {
			let passed = 0
			let total = 0
			const failures: string[] = []
			for (const testCase of CASES) {
				const result = await refineBrief({
					backend,
					workingDirectory: process.cwd(),
					request: testCase.request,
					tokens: null,
					model,
				})
				if (!result) {
					total += testCase.checks.length
					failures.push(`${testCase.name}: NO OUTPUT`)
					continue
				}
				for (const check of testCase.checks) {
					total++
					if (check.pass(result.prompt)) passed++
					else failures.push(`${testCase.name} :: ${check.name}\n      "${result.prompt.slice(0, 220)}..."`)
				}
			}
			const score = Math.round((passed / total) * 100)
			console.log(`${model}  ${score}%  (${passed}/${total})${score >= 80 ? "  PASS" : "  BELOW BAR"}`)
			for (const failure of failures) console.log(`   ✗ ${failure}`)
			console.log("")
		}
	} finally {
		await stopOpencodeServer().catch(() => {})
	}
}

void main().then(
	() => process.exit(0),
	(err) => {
		console.error(err)
		process.exit(1)
	},
)
