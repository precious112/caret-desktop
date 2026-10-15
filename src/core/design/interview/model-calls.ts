/**
 * Every model call the interview makes, and nothing else.
 *
 * Caret runs the interview: it picks the topic, its order and how it is shown
 * (areas.ts). The model only writes words and proposes values:
 *
 * - opening:  "here's what I took from your description" (or found in your code)
 * - area:     the question about one topic, with 2 to 4 options and a recommendation
 * - fill:     a value for every remaining topic, when "Just finish it" is pressed
 * - prose:    the finish's summary, colour rule and one reason per topic
 *
 * Each call gets short instructions for that one job. Every reply is checked
 * by code; an unusable reply is sent back with the reason, at most 3 times.
 * A provider refusal is never retried: asking again gets the same refusal.
 *
 * The instructions must not depend on anything but their inputs (no times,
 * no absolute paths): recorded answers are matched to them for testing.
 */

import {
	BackendError,
	type CodingBackend,
	ProviderRefusalError,
	type ReasoningEffort,
	type StructuredRequest,
} from "../agent/backend"
import { closeMatch, parseHex } from "../design-pass/colour"
import type { UserChoices } from "../design-pass/foundation-check"
import type { AreaOption, AreaQuestion } from "./answers"
import {
	AREA_ORDER,
	AREAS,
	type AreaId,
	type AreaValue,
	describeValue,
	isAreaId,
	isAreaValue,
	normalizeHex,
	RANGES,
	sameValue,
} from "./areas"
import { avoidListFor, flaggedOptions, userChoicesFrom } from "./defaults"
import { deriveState, type InterviewRecord, type OpeningStatement, openingMaySettle } from "./state"

export const MAX_ATTEMPTS = 3

/** Which step of the interview a call belongs to; the error screen and "Try again" use it. */
export type Stage = AreaId | "opening" | "fill" | "prose"

/** A call that failed for good. `message` is shown to the user. */
export class InterviewTurnError extends Error {
	constructor(
		readonly stage: Stage,
		message: string,
		/** The provider refused (a usage limit, billing): asking again won't help until that changes. */
		readonly refusal = false,
	) {
		super(message)
		this.name = "InterviewTurnError"
	}
}

/** A reply that can't be used; the reason goes back to the model. */
class ReplyProblem extends Error {}

export interface CallContext {
	backend: CodingBackend
	/** The project folder: the model reads it only when starting from an app. */
	workingDirectory: string
	model?: string
	effort?: ReasoningEffort
	signal?: AbortSignal
	onAttempt?: (attempt: number, max: number) => void
	/** Spells a font family the way Google Fonts does, when it knows it. */
	resolveFamily?: (name: string) => Promise<string>
	/** One line per rejected reply, for the app's log. */
	log?: (line: string) => void
}

// ── shared wording ──────────────────────────────────────────────────────────

const PLAIN_WORDS = `- Write for someone who builds software but has no design vocabulary. Short sentences. Say what a choice does and how it will look. A design term is fine only next to its plain meaning.`

const INPUT_WORDS: Record<string, string> = {
	cards: "shown as option cards with a live preview. They can also Skip, and then your recommendation stands.",
	color: "shown as colour swatches with a preview. They can also pick or type their own colour, or Skip.",
	font: "shown as type specimens. They can also search all of Google Fonts, or Skip.",
	slider: "shown as a slider from quiet to bold, with a live preview. They can also type their own size and step, or Skip.",
	status: "shown as cards of four swatches. They can also type their own four colours, or Skip.",
}

const AREA_BRIEFS: Record<AreaId, string> = {
	surface:
		"Light or dark is the background of every page. Offer both, and recommend the one that fits how and where the product is used.",
	"display-type":
		"The heading typeface is used for page titles and section headings. Offer real Google Fonts families that suit this product. Each option's label is the family name exactly as Google Fonts spells it.",
	"body-type":
		"The body typeface is used for paragraphs, labels and long reading. It must stay comfortable at 14 to 16px and sit well next to the heading typeface. Offer real Google Fonts families; each label is the family name exactly as Google Fonts spells it.",
	"type-scale": `Each option is a body text size in px (${RANGES.baseSize.min} to ${RANGES.baseSize.max}) and the step between heading sizes (a ratio from ${RANGES.scaleRatio.min} to ${RANGES.scaleRatio.max}). Offer 3 to 5 options from quiet to bold, in that order. Each label names both numbers, like "Balanced: 16px body, headings ×1.2".`,
	"brand-color":
		"The brand colour goes on primary buttons and links. Offer colours that come from this product and its world. Each label names the colour and its hex.",
	"secondary-color":
		"A supporting colour for secondary buttons, charts and highlights, used less than the brand. It must look clearly different from the brand colour. Caret adds a None option itself, so don't offer one.",
	"accent-color":
		"A small accent colour for rare details, like status dots or badges. It must look clearly different from the brand and supporting colours. Caret adds a None option itself, so don't offer one.",
	neutral:
		"The greys for backgrounds, borders and muted text can lean cool (towards blue), warm (towards brown), stay true grey, or carry a slight tint of the brand.",
	semantics:
		"Four colours for status: success, warning, error and info. Each option is a full set of four that reads clearly on the chosen background.",
	spacing:
		"The base unit all spacing is built from: 4px (tight, for dense screens) or 8px (comfortable, more air). Offer both, and recommend one.",
	radius: "How round corners are on buttons, cards and panels: sharp, soft, round or pill.",
	depth: "How boxes separate from the page: flat (borders only), subtle (a faint shadow) or pronounced (clear floating shadows).",
}

// ── answer formats (JSON Schema) ────────────────────────────────────────────

const HEX_SCHEMA = { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }

/** The shape of one value for a topic, as the model must write it. */
export function valueSchema(area: AreaId): Record<string, unknown> {
	const object = (properties: Record<string, unknown>) => ({
		type: "object",
		properties,
		required: Object.keys(properties),
		additionalProperties: false,
	})
	switch (area) {
		case "surface":
			return object({ surface: { enum: ["light", "dark"] } })
		case "display-type":
		case "body-type":
			return object({ family: { type: "string" } })
		case "type-scale":
			return object({
				baseSize: { type: "integer", minimum: RANGES.baseSize.min, maximum: RANGES.baseSize.max },
				scaleRatio: { type: "number", minimum: RANGES.scaleRatio.min, maximum: RANGES.scaleRatio.max },
			})
		case "brand-color":
		case "secondary-color":
		case "accent-color":
			return object({ hex: HEX_SCHEMA })
		case "neutral":
			return object({ neutral: { enum: ["cool", "true", "warm", "slight-tint"] } })
		case "semantics":
			return object({ success: HEX_SCHEMA, warning: HEX_SCHEMA, error: HEX_SCHEMA, info: HEX_SCHEMA })
		case "spacing":
			return object({ spacingUnit: { enum: [4, 8] } })
		case "radius":
			return object({ radiusCharacter: { enum: ["sharp", "soft", "round", "pill"] } })
		case "depth":
			return object({ elevation: { enum: ["flat", "subtle", "pronounced"] } })
	}
}

export function areaReplySchema(area: AreaId): Record<string, unknown> {
	const [min, max] = AREAS[area].optionCount
	return {
		type: "object",
		properties: {
			question: { type: "string", maxLength: 220 },
			why: { type: "string", maxLength: 300 },
			options: {
				type: "array",
				minItems: min,
				maxItems: max,
				items: {
					type: "object",
					properties: {
						value: valueSchema(area),
						label: { type: "string", maxLength: 80 },
						reason: { type: "string", maxLength: 220 },
					},
					required: ["value", "label", "reason"],
					additionalProperties: false,
				},
			},
			recommended: { type: "integer", minimum: 0, description: "Index of the recommended option." },
		},
		required: ["question", "options", "recommended"],
		additionalProperties: false,
	}
}

function openingAreas(record: InterviewRecord): AreaId[] {
	return AREA_ORDER.filter((area) => openingMaySettle(record.mode, area))
}

export function openingReplySchema(record: InterviewRecord): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			question: { type: "string", maxLength: 240 },
			statements: {
				type: "array",
				maxItems: openingAreas(record).length,
				items: {
					type: "object",
					properties: {
						area: { enum: openingAreas(record) },
						value: { type: "object", description: "The exact value, in that topic's shape (see the instructions)." },
						text: { type: "string", maxLength: 200 },
						...(record.mode === "from-app"
							? { source: { type: "string", description: "The file it was read from, relative to the project." } }
							: {}),
					},
					required: record.mode === "from-app" ? ["area", "value", "text", "source"] : ["area", "value", "text"],
					additionalProperties: false,
				},
			},
		},
		required: ["question", "statements"],
		additionalProperties: false,
	}
}

export function fillReplySchema(remaining: AreaId[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {}
	for (const area of remaining) {
		properties[area] = AREAS[area].allowsNone
			? { anyOf: [valueSchema(area), { type: "object", properties: { none: { const: true } }, required: ["none"] }] }
			: valueSchema(area)
	}
	return {
		type: "object",
		properties: {
			values: { type: "object", properties, required: remaining, additionalProperties: false },
		},
		required: ["values"],
		additionalProperties: false,
	}
}

export function proseReplySchema(): Record<string, unknown> {
	const reasons: Record<string, unknown> = {}
	for (const area of AREA_ORDER) reasons[area] = { type: "string", maxLength: 220 }
	return {
		type: "object",
		properties: {
			summary: { type: "string", maxLength: 420 },
			rule: { type: "string", maxLength: 200 },
			reasons: { type: "object", properties: reasons, required: [...AREA_ORDER], additionalProperties: false },
		},
		required: ["summary", "rule", "reasons"],
		additionalProperties: false,
	}
}

/** How each topic's value is written, for instructions that mention several topics. */
function shapeLine(area: AreaId): string {
	const shapes: Record<AreaId, string> = {
		surface: `{"surface": "light" or "dark"}`,
		"display-type": `{"family": "Google Fonts family name"}`,
		"body-type": `{"family": "Google Fonts family name"}`,
		"type-scale": `{"baseSize": ${RANGES.baseSize.min} to ${RANGES.baseSize.max}, "scaleRatio": ${RANGES.scaleRatio.min} to ${RANGES.scaleRatio.max}}`,
		"brand-color": `{"hex": "#rrggbb"}`,
		"secondary-color": `{"hex": "#rrggbb"} or {"none": true}`,
		"accent-color": `{"hex": "#rrggbb"} or {"none": true}`,
		neutral: `{"neutral": "cool", "true", "warm" or "slight-tint"}`,
		semantics: `{"success": "#rrggbb", "warning": "#rrggbb", "error": "#rrggbb", "info": "#rrggbb"}`,
		spacing: `{"spacingUnit": 4 or 8}`,
		radius: `{"radiusCharacter": "sharp", "soft", "round" or "pill"}`,
		depth: `{"elevation": "flat", "subtle" or "pronounced"}`,
	}
	return `- ${area} (${AREAS[area].label}): ${shapes[area]}`
}

// ── instructions ────────────────────────────────────────────────────────────

/** The system instructions for the question about one topic. Fixed for a given mode and topic. */
export function areaSystemPrompt(area: AreaId): string {
	const spec = AREAS[area]
	return [
		`You write one question in a design interview inside Caret, a design tool. Caret runs the interview and decides the topics and their order. Your only job is the question about ${spec.label}.`,
		"",
		`How it is shown: ${INPUT_WORDS[spec.input]}`,
		"",
		"Rules:",
		PLAIN_WORDS,
		"- Every option and its reason must come from what they told you about their product, in their words.",
		"- Options must be real alternatives that look clearly different from each other.",
		"- Put each option's numbers in its label where it has them (hex, px, ratio).",
		"- Recommend exactly one option.",
		"- Never offer anything on the Avoid line.",
		"",
		AREA_BRIEFS[area],
	].join("\n")
}

export function openingSystemPrompt(record: InterviewRecord): string {
	const areas = openingAreas(record)
	const intro =
		record.mode === "from-app"
			? [
					"You start a design interview inside Caret, a design tool, for an app that already exists. Read the app in your working directory and find what its code already decides about these topics. Then state each finding as one line the user can confirm.",
					"",
					"Where to look: Tailwind config or @theme blocks, CSS custom properties, theme objects (MUI, Chakra, styled-components), how fonts are loaded, and the most used values in the styles. Never read node_modules, build output or the .caret folder.",
					"",
					"- One statement per topic the code clearly decides; leave the rest out (Caret asks about them).",
					"- Each statement's value is exactly what the code says, and `source` is the file it came from, relative to the project.",
					"- If a font is not a Google Fonts family, name the closest Google Fonts family and say so in the text.",
				]
			: [
					"You start a design interview inside Caret, a design tool. From the user's description, state what it clearly implies about the topics below, as lines the user can confirm.",
					"",
					"- One statement per topic, and only for topics the description clearly implies. Leave the rest out: Caret asks about them.",
					"- Fonts, colours, sizes and spacing are not on this list: those always get their own question.",
				]
	return [
		...intro,
		'- Each statement is shown already agreed; the user presses "Not quite" on any that is wrong. So every statement must be true on its own, and all must be true together.',
		PLAIN_WORDS,
		'- `question` is one short sentence introducing the screen, like "Before the questions, here\'s what I took from your description."',
		"",
		"Topics and the shape of each value:",
		...areas.map(shapeLine),
	].join("\n")
}

export function fillSystemPrompt(): string {
	return [
		'You help finish a design interview inside Caret, a design tool. The user pressed "Just finish it": choose a value for each remaining topic yourself.',
		"",
		"- Choose what fits their product and agrees with everything already decided.",
		"- Never choose anything on an Avoid line.",
		"- Supporting and accent colours may be none.",
		"",
		"Topics and the shape of each value:",
		...AREA_ORDER.map(shapeLine),
	].join("\n")
}

export function proseSystemPrompt(): string {
	return [
		"You write the summary at the end of a design interview inside Caret, a design tool. Every value is already decided and final.",
		"",
		"- summary: 2 or 3 sentences to the user about how their foundation fits their product.",
		"- rule: one sentence on how colour is used (for example, where the brand colour appears and where it never does).",
		"- reasons: one sentence per topic on why that choice fits, grounded in what they said and chose.",
		PLAIN_WORDS,
		"- Never change, add or suggest a value. Never name a colour or font that is not in the list you are given.",
	].join("\n")
}

/** "- the heading typeface: Red Hat Display (they picked it)", one line per settled topic. */
function decidedLines(record: InterviewRecord): string[] {
	const state = deriveState(record)
	const lines: string[] = []
	for (const area of AREA_ORDER) {
		const status = state.areas[area]
		if (!status.value) continue
		const how =
			status.via === "opening"
				? status.source
					? `read from ${status.source}`
					: "confirmed on the opening screen"
				: status.via === "own"
					? "they typed it"
					: status.via === "skip"
						? "they skipped; your recommendation stands"
						: status.via === "finish-now"
							? "filled in when they pressed Just finish it"
							: "they picked it"
		lines.push(`- ${AREAS[area].label}: ${describeValue(area, status.value)} (${how})`)
	}
	return lines
}

function productBlock(record: InterviewRecord): string {
	return record.mode === "from-app"
		? `Their app is in your working directory. What Caret detected:\n"""\n${record.description}\n"""`
		: `Their product, in their words:\n"""\n${record.description}\n"""`
}

function avoidLine(area: AreaId, user: UserChoices): string | null {
	const avoid = avoidListFor(area, user)
	return avoid.length ? `Avoid (overused AI defaults they did not ask for): ${avoid.join(", ")}` : null
}

/** The request for the question about one topic. */
export function areaUserPrompt(record: InterviewRecord, area: AreaId): string {
	const state = deriveState(record)
	const decided = decidedLines(record)
	const correction = state.areas[area].correction
	const avoid = avoidLine(area, userChoicesFrom(record))
	return [
		productBlock(record),
		"",
		"Decided so far:",
		...(decided.length ? decided : ["Nothing yet."]),
		...(correction
			? [
					"",
					`On the opening screen they said this about ${AREAS[area].label} was not quite right: "${correction}". Take it into account.`,
				]
			: []),
		...(avoid ? ["", avoid] : []),
		"",
		`Write the question about ${AREAS[area].label}.`,
	].join("\n")
}

/** Identifies what a question was written from: Back reuses a question only while this still matches. */
export function contextKeyFor(record: InterviewRecord, area: AreaId): string {
	let hash = 2166136261
	for (const ch of areaUserPrompt(record, area)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619)
	return (hash >>> 0).toString(16)
}

// ── calling, with retries ───────────────────────────────────────────────────

async function call<T>(
	stage: Stage,
	ctx: CallContext,
	build: (complaint: string | undefined) => StructuredRequest,
	check: (raw: unknown) => Promise<T>,
): Promise<T> {
	let complaint: string | undefined
	for (let attempt = 1; ; attempt++) {
		ctx.onAttempt?.(attempt, MAX_ATTEMPTS)
		let raw: unknown
		try {
			raw = (await ctx.backend.structured<unknown>(build(complaint))).value
			return await check(raw)
		} catch (err) {
			if (ctx.signal?.aborted) throw err
			if (err instanceof ProviderRefusalError) throw new InterviewTurnError(stage, err.message, true)
			// A failure that won't fix itself (a recording that doesn't match, a
			// backend that can't run) is not a bad reply: asking again only hides it.
			if (err instanceof BackendError && !err.recoverable) throw new InterviewTurnError(stage, err.message)
			const why = err instanceof Error ? err.message : String(err)
			const shown = raw === undefined ? "(no reply)" : JSON.stringify(raw).slice(0, 600)
			ctx.log?.(`[interview] ${stage} attempt ${attempt}/${MAX_ATTEMPTS} rejected (${why}) reply: ${shown}`)
			if (attempt >= MAX_ATTEMPTS) {
				throw new InterviewTurnError(
					stage,
					err instanceof ReplyProblem
						? `The model couldn't write a usable question (${why}).`
						: `The model stopped responding (${why}).`,
				)
			}
			complaint = `Your previous reply was rejected.\nReply: ${shown}\nWhy: ${why}\nReturn a corrected reply.`
		}
	}
}

function request(
	ctx: CallContext,
	parts: Partial<StructuredRequest> & Pick<StructuredRequest, "prompt" | "schema">,
): StructuredRequest {
	return {
		workingDirectory: ctx.workingDirectory,
		model: ctx.model,
		effort: ctx.effort,
		signal: ctx.signal,
		scratch: true,
		...parts,
	}
}

const withComplaint = (prompt: string, complaint: string | undefined) => (complaint ? `${prompt}\n\n${complaint}` : prompt)

// ── the opening screen ──────────────────────────────────────────────────────

export interface OpeningReply {
	question: string
	statements: OpeningStatement[]
}

export async function askOpening(
	record: InterviewRecord,
	ctx: CallContext,
	sourceExists: (relativePath: string) => Promise<boolean> = async () => true,
): Promise<OpeningReply> {
	const systemPrompt = openingSystemPrompt(record)
	const schema = openingReplySchema(record)
	const prompt = `${productBlock(record)}\n\nWrite the opening screen.`
	return call(
		"opening",
		ctx,
		(complaint) =>
			request(ctx, {
				prompt: withComplaint(prompt, complaint),
				systemPrompt,
				schema,
				trace: { tag: "interview:opening" },
				...(record.mode === "from-app" ? { reads: true, scratch: false } : {}),
			}),
		async (raw) => {
			const reply = raw as { question?: unknown; statements?: unknown }
			if (typeof reply?.question !== "string" || !reply.question.trim())
				throw new ReplyProblem("the question text is empty")
			if (reply.question.length > 240)
				throw new ReplyProblem("the question is longer than 240 characters; put each finding in its own statement")
			if (!Array.isArray(reply.statements)) throw new ReplyProblem("statements must be a list")
			const allowed = new Set(openingAreas(record))
			const statements: OpeningStatement[] = []
			for (const item of reply.statements as Array<Record<string, unknown>>) {
				const area = item?.area
				if (!isAreaId(area) || !allowed.has(area) || statements.some((s) => s.area === area)) continue
				const value = tidyValue(area, item.value)
				if (!value || typeof item.text !== "string" || !item.text.trim()) continue
				const source = typeof item.source === "string" ? item.source.trim() : undefined
				if (record.mode === "from-app" && (!source || !(await sourceExists(source)))) {
					ctx.log?.(
						`[interview] opening statement about ${area} dropped: its source "${source ?? ""}" isn't in the project`,
					)
					continue
				}
				statements.push({ id: `s-${area}`, area, value, text: item.text.trim(), ...(source ? { source } : {}) })
			}
			statements.sort((a, b) => AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area))
			return { question: reply.question.trim(), statements }
		},
	)
}

/** A model-written value, tidied (hexes normalised, names trimmed), or null when it isn't valid for the topic. */
function tidyValue(area: AreaId, raw: unknown): AreaValue | null {
	if (!raw || typeof raw !== "object") return null
	const v = { ...(raw as Record<string, unknown>) }
	for (const key of ["hex", "success", "warning", "error", "info"]) {
		if (typeof v[key] === "string") v[key] = normalizeHex(v[key] as string) ?? v[key]
	}
	if (typeof v.family === "string") v.family = v.family.trim()
	if (typeof v.scaleRatio === "number") v.scaleRatio = Math.round(v.scaleRatio * 1000) / 1000
	return isAreaValue(area, v) ? (v as AreaValue) : null
}

// ── one topic's question ────────────────────────────────────────────────────

export async function askArea<A extends AreaId>(record: InterviewRecord, area: A, ctx: CallContext): Promise<AreaQuestion<A>> {
	const systemPrompt = areaSystemPrompt(area)
	const schema = areaReplySchema(area)
	const prompt = areaUserPrompt(record, area)
	const contextKey = contextKeyFor(record, area)
	const user = userChoicesFrom(record)
	const brand = deriveState(record).areas["brand-color"].value as { hex?: string } | undefined
	const secondary = deriveState(record).areas["secondary-color"].value as { hex?: string } | undefined
	const spec = AREAS[area]

	return call(
		area,
		ctx,
		(complaint) =>
			request(ctx, {
				prompt: withComplaint(prompt, complaint),
				systemPrompt,
				schema,
				trace: { tag: "interview:area", area },
			}),
		async (raw) => {
			const reply = raw as { question?: unknown; why?: unknown; options?: unknown; recommended?: unknown }
			if (typeof reply?.question !== "string" || !reply.question.trim())
				throw new ReplyProblem("the question text is empty")
			if (!Array.isArray(reply.options)) throw new ReplyProblem("options must be a list")
			const recommendedIndex = typeof reply.recommended === "number" ? reply.recommended : 0
			const kept: Array<{ option: Omit<AreaOption<A>, "id">; wasRecommended: boolean }> = []
			const dropped: string[] = []
			for (const [index, item] of (reply.options as Array<Record<string, unknown>>).entries()) {
				let value = tidyValue(area, item?.value)
				const label = typeof item?.label === "string" ? item.label.trim() : ""
				if (!value || !label) {
					dropped.push(`option ${index + 1} has no valid value or label`)
					continue
				}
				if ("none" in value) {
					// Caret adds None itself; a model's None would appear twice.
					continue
				}
				if (spec.fixedValues && !spec.fixedValues.some((allowed) => sameValue(allowed, value as AreaValue))) {
					dropped.push(`${JSON.stringify(value)} is not one of the allowed values`)
					continue
				}
				if (typeof (value as { family?: string }).family === "string" && ctx.resolveFamily) {
					value = { family: await ctx.resolveFamily((value as { family: string }).family) } as AreaValue
				}
				if (kept.some((k) => sameValue(k.option.value, value as AreaValue))) {
					dropped.push(`${describeValue(area, value)} is offered twice`)
					continue
				}
				const hex = (value as { hex?: string }).hex
				if (hex && (area === "secondary-color" || area === "accent-color")) {
					const near = [brand?.hex, area === "accent-color" ? secondary?.hex : undefined].find((other) => {
						const a = parseHex(hex)
						const b = other ? parseHex(other) : null
						return a && b && closeMatch(a, b) !== null
					})
					if (near) {
						dropped.push(`${hex} looks too close to ${near}, already chosen`)
						continue
					}
				}
				kept.push({
					option: {
						label,
						reason: typeof item.reason === "string" ? item.reason.trim() : undefined,
						value: value as AreaValue<A>,
					},
					wasRecommended: index === recommendedIndex,
				})
			}
			// Overused defaults are dropped, never shown.
			const withIds = kept.map((k, i) => ({ ...k, option: { id: `${area}-${i}`, ...k.option } }))
			const flagged = new Set(
				flaggedOptions(
					area,
					withIds.map((k) => k.option),
					user,
				),
			)
			for (const k of withIds)
				if (flagged.has(k.option.id)) dropped.push(`${describeValue(area, k.option.value)} is an overused AI default`)
			const usable = withIds.filter((k) => !flagged.has(k.option.id)).slice(0, spec.optionCount[1])
			if (usable.length < spec.optionCount[0]) {
				throw new ReplyProblem(
					`only ${usable.length} usable option(s), at least ${spec.optionCount[0]} needed${dropped.length ? `: ${dropped.join("; ")}` : ""}`,
				)
			}
			const options: AreaOption<A>[] = usable.map((k, i) => ({ ...k.option, id: `${area}-${i}` }))
			const recommended = usable.findIndex((k) => k.wasRecommended)
			if (spec.allowsNone) {
				options.push({
					id: `${area}-none`,
					label: "None",
					reason:
						area === "accent-color"
							? "Keep it to the brand and supporting colours."
							: "Keep it to the brand colour and greys.",
					value: { none: true } as AreaValue<A>,
				})
			}
			return {
				id: `${area}-${contextKey}`,
				area,
				input: spec.input,
				question: reply.question.trim(),
				...(typeof reply.why === "string" && reply.why.trim() ? { why: reply.why.trim() } : {}),
				options,
				recommendedId: options[Math.max(0, recommended)].id,
				contextKey,
			}
		},
	)
}

// ── "Just finish it" ────────────────────────────────────────────────────────

export async function askFill(record: InterviewRecord, ctx: CallContext): Promise<Map<AreaId, AreaValue>> {
	const state = deriveState(record)
	const remaining = AREA_ORDER.filter((area) => state.areas[area].status === "open")
	const user = userChoicesFrom(record)
	const decided = decidedLines(record)
	const avoid = remaining.map((area) => avoidLine(area, user)).filter(Boolean)
	const prompt = [
		productBlock(record),
		"",
		"Decided so far:",
		...(decided.length ? decided : ["Nothing yet."]),
		"",
		`Choose a value for: ${remaining.map((area) => AREAS[area].label).join(", ")}.`,
		...(avoid.length ? ["", ...new Set(avoid)] : []),
	].join("\n")
	const systemPrompt = fillSystemPrompt()
	const schema = fillReplySchema(remaining)
	return call(
		"fill",
		ctx,
		(complaint) =>
			request(ctx, { prompt: withComplaint(prompt, complaint), systemPrompt, schema, trace: { tag: "interview:fill" } }),
		async (raw) => {
			const values = (raw as { values?: Record<string, unknown> })?.values ?? {}
			const out = new Map<AreaId, AreaValue>()
			const problems: string[] = []
			for (const area of remaining) {
				let value = tidyValue(area, values[area])
				if (value && typeof (value as { family?: string }).family === "string" && ctx.resolveFamily) {
					value = { family: await ctx.resolveFamily((value as { family: string }).family) } as AreaValue
				}
				if (!value) {
					problems.push(`${area} has no valid value`)
					continue
				}
				if (flaggedOptions(area, [{ id: "x", label: "x", value }], user).length) {
					problems.push(`${describeValue(area, value)} for ${area} is an overused AI default`)
					continue
				}
				out.set(area, value)
			}
			if (problems.length) throw new ReplyProblem(problems.join("; "))
			return out
		},
	)
}

// ── the finish's words ──────────────────────────────────────────────────────

export interface Prose {
	summary: string
	rule: string
	reasons: Record<AreaId, string>
}

export async function askProse(record: InterviewRecord, ctx: CallContext): Promise<Prose> {
	const state = deriveState(record)
	const allowedHexes = new Set(
		AREA_ORDER.flatMap((area) => {
			const v = (state.areas[area].value ?? {}) as Record<string, unknown>
			return Object.values(v).filter((x): x is string => typeof x === "string" && x.startsWith("#"))
		}),
	)
	const prompt = [
		productBlock(record),
		"",
		"The decided foundation:",
		...AREA_ORDER.map((area) => {
			const status = state.areas[area]
			const answer = record.answers.find((a) => a.area === area)
			return `- ${area} (${AREAS[area].label}): ${describeValue(area, status.value as AreaValue)}${answer?.reason ? `. Shown with the reason: ${answer.reason}` : ""}`
		}),
	].join("\n")
	const systemPrompt = proseSystemPrompt()
	const schema = proseReplySchema()
	try {
		return await call(
			"prose",
			ctx,
			(complaint) =>
				request(ctx, {
					prompt: withComplaint(prompt, complaint),
					systemPrompt,
					schema,
					trace: { tag: "interview:prose" },
				}),
			async (raw) => {
				const reply = raw as { summary?: unknown; rule?: unknown; reasons?: Record<string, unknown> }
				if (typeof reply?.summary !== "string" || !reply.summary.trim()) throw new ReplyProblem("the summary is empty")
				if (typeof reply.rule !== "string" || !reply.rule.trim()) throw new ReplyProblem("the colour rule is empty")
				const reasons = {} as Record<AreaId, string>
				for (const area of AREA_ORDER) {
					const reason = reply.reasons?.[area]
					if (typeof reason !== "string" || !reason.trim()) throw new ReplyProblem(`there is no reason for ${area}`)
					reasons[area] = reason.trim()
				}
				const text = [reply.summary, reply.rule, ...Object.values(reasons)].join(" ")
				const strangers = (text.match(/#[0-9a-fA-F]{6}\b/g) ?? []).filter((hex) => !allowedHexes.has(hex.toLowerCase()))
				if (strangers.length)
					throw new ReplyProblem(`it names colours that weren't chosen: ${[...new Set(strangers)].join(", ")}`)
				return { summary: reply.summary.trim(), rule: reply.rule.trim(), reasons }
			},
		)
	} catch (err) {
		if (err instanceof InterviewTurnError && !err.refusal) {
			// The words are a courtesy; the values are what matters. A model that
			// can't write them never blocks the finish.
			ctx.log?.(`[interview] prose fell back to Caret's own wording: ${err.message}`)
			return fallbackProse(record)
		}
		throw err
	}
}

/** Caret's own words for the finish, from the answers alone. */
export function fallbackProse(record: InterviewRecord): Prose {
	const state = deriveState(record)
	const reasons = {} as Record<AreaId, string>
	for (const area of AREA_ORDER) {
		const answer = record.answers.find((a) => a.area === area)
		const status = state.areas[area]
		reasons[area] =
			answer?.reason ??
			(status.via === "opening"
				? status.source
					? `Read from ${status.source}.`
					: "Confirmed on the opening screen."
				: status.via === "own"
					? "Your own choice."
					: "Chosen for you.")
	}
	return {
		summary: `${describeValue("display-type", state.areas["display-type"].value as AreaValue)} for headings and ${describeValue("body-type", state.areas["body-type"].value as AreaValue)} for text, on a ${describeValue("surface", state.areas.surface.value as AreaValue).toLowerCase()} page.`,
		rule: "The brand colour goes on primary actions and links; everything else stays in the greys.",
		reasons,
	}
}
