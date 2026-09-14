/**
 * The tools that let an agent put a question to the user and block on the
 * answer — the foundation interview, and past it, mid-conversation choices
 * like which existing asset a plan should use.
 *
 * The division of labour matters. The agent supplies **judgment** — which
 * questions are worth asking given what it already knows, and which few
 * candidates to show. Caret supplies the **space** those choices are made
 * within, and every option in it is one somebody approved.
 *
 * So `present_options` does not accept arbitrary candidates. It takes ids from
 * the curated library, and anything else is refused. An agent that could pass
 * its own hex codes and font names would be right back to averaging its training
 * data, which is the failure this whole phase exists to prevent.
 */
import { z } from "zod"

import {
	assetUrl,
	candidateFontUrl,
	countRecognisedTags,
	findAsset,
	INTERVIEW_QUESTIONS,
	LIBRARY_TAGS,
	narrowCandidates,
	readAssetIndex,
	resolveCandidate,
	withDerivedScales,
	writeFoundationTokens,
} from "../../../src/core/design"
import { recordEdit } from "../../../src/core/design/provenance"
import { Logger } from "../../../src/shared/services/Logger"
import { acceptRequestTake, rasterConfig, requestTakes } from "../generate-assets"
import { askUser, type InterviewPrompt, type PresentedCandidate } from "../interview"
import { getPrefs } from "../prefs"
import { regenerateRulesFiles } from "../rules/generate"
import type { ToolContext, ToolDefinition, ToolResult } from "./tools"

/** How the interview reaches the window. Injected so tests can drive it headless. */
export interface InterviewTransport {
	send(prompt: InterviewPrompt): void
}

function ok(payload: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] }
}

function fail(message: string): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }], isError: true }
}

export function buildInterviewTools(transport: InterviewTransport): ToolDefinition[] {
	const send = (prompt: InterviewPrompt) => transport.send(prompt)

	return [
		{
			name: "present_question",
			title: "Ask the user a question",
			description:
				"Shows the user a plain-language question with a few choices and waits for them to pick. Use this to run the foundation interview. Ask about the product and how it should feel — never about design terms like type scale, radius or saturation, which the user has no way to answer. Caret's suggested questions are in the caret://interview prompt.",
			inputSchema: {
				question: z.string().describe("Plain language, no design jargon"),
				choices: z.array(z.string()).min(2).max(5).describe("Two to five concrete answers"),
				hint: z.string().optional().describe("One line of reassurance or clarification"),
				step: z.number().optional(),
				total: z.number().optional(),
			},
			async handler(_ctx, args: { question: string; choices: string[]; hint?: string; step?: number; total?: number }) {
				const answer = await askUser(send, {
					kind: "question",
					question: args.question,
					hint: args.hint,
					choices: args.choices,
					step: args.step,
					total: args.total,
				})
				return answer === null
					? ok({ answered: false, note: "The user skipped this question or closed the interview." })
					: ok({ answered: true, answer })
			},
		},

		{
			name: "present_options",
			title: "Show the user foundations to pick from",
			description: `Renders complete foundations as live specimens — real typefaces, palettes applied to sample components — and waits for the user to point at one. Pass the vibe tags you inferred from their answers and Caret narrows its curated library; you cannot pass your own colours or font names, by design. Returns the chosen candidate id for commit_foundation.\n\nTags are matched exactly against a fixed vocabulary, so use words FROM THIS LIST ONLY:\n${LIBRARY_TAGS.join(", ")}\n\nPick the 3-6 that best fit what the user told you. Tags outside this list are rejected rather than silently ignored.`,
			inputSchema: {
				tags: z
					.array(z.string())
					.describe(`Vibe tags from the library vocabulary. Allowed values: ${LIBRARY_TAGS.join(", ")}`),
				count: z.number().min(2).max(4).default(3).describe("How many candidates to show"),
				title: z.string().default("Pick the one you like").describe("Heading above the options"),
				subtitle: z.string().optional(),
			},
			async handler(_ctx, args: { tags: string[]; count?: number; title?: string; subtitle?: string }) {
				const tags = args.tags ?? []

				// Refuse a query that overlaps the vocabulary nowhere. Ranking by a
				// score every candidate ties on is not a narrowing — it silently
				// returns the first few in declaration order, which looks exactly
				// like a real result and is not one.
				if (tags.length > 0 && countRecognisedTags(tags) === 0) {
					return fail(
						`None of [${tags.join(", ")}] are tags this library knows, so nothing can be narrowed. ` +
							`Re-tag using these words only: ${LIBRARY_TAGS.join(", ")}`,
					)
				}

				const candidates = narrowCandidates(tags, args.count ?? 3)
				if (candidates.length === 0) {
					return fail("No candidates matched — pass fewer or broader tags.")
				}

				const chosen = await askUser(send, {
					kind: "options",
					title: args.title ?? "Pick the one you like",
					subtitle: args.subtitle,
					candidates: candidates.map(present),
				})

				if (chosen === null) {
					return ok({ chosen: false, note: "The user closed the interview without picking." })
				}
				return ok({
					chosen: true,
					candidateId: chosen,
					next: "Call commit_foundation with this candidateId to write it.",
				})
			},
		},

		{
			name: "commit_foundation",
			title: "Save the chosen foundation",
			description:
				"Writes the foundation the user picked and regenerates the rules files every agent session reads. Call this immediately after present_options returns a candidateId — an interview that is never committed leaves the project with no foundations at all.",
			inputSchema: {
				candidateId: z.string().describe("The candidateId returned by present_options"),
				tags: z.array(z.string()).default([]).describe("The vibe tags, recorded with the foundation"),
				seed: z
					.string()
					.optional()
					.describe("Overrides the palette's brand colour, if the user asked for a specific one"),
			},
			async handler(ctx: ToolContext, args: { candidateId: string; tags?: string[]; seed?: string }) {
				const candidate = resolveCandidate(args.candidateId, args.tags ?? [])
				if (!candidate) {
					return fail(`"${args.candidateId}" is not a candidate from present_options.`)
				}

				const tokens = args.seed
					? {
							...candidate.tokens,
							// A new seed invalidates the ramp derived from the old one; empty
							// it so the derivation pass regenerates from the override.
							color: { ...candidate.tokens.color, brand: { seed: args.seed, scale: {} } },
						}
					: candidate.tokens

				try {
					const derived = withDerivedScales(tokens)
					derived.meta = {
						committed: true,
						committedAt: new Date().toISOString(),
						source: "agent",
						rule: candidate.palette.rule,
					}
					await writeFoundationTokens(ctx.projectPath, derived)
					await regenerateRulesFiles(ctx.projectPath)
					await recordEdit(ctx.projectPath, {
						actor: "agent",
						action: "write",
						file: "tokens/foundation.json",
						note: `foundation interview → ${candidate.name}`,
					})
				} catch (err) {
					Logger.error("[interview] commit_foundation failed:", err)
					return fail(err instanceof Error ? err.message : String(err))
				}

				return ok({
					ok: true,
					name: candidate.name,
					typeface: candidate.typeface.name,
					palette: candidate.palette.name,
					// The restraint rule is the part that has to survive into every
					// later page, so it is handed straight back to the agent too.
					rule: candidate.palette.rule,
				})
			},
		},
		{
			name: "present_asset_options",
			title: "Offer the user existing assets to pick between",
			description:
				'Shows two to six assets that are ALREADY in this project\'s library as options against one question ("Which hero image?") and waits for the user to pick. It renders in the chat beside the canvas, so use it mid-conversation whenever a plan turns on which existing asset to use — do not make the user open the Assets tab to answer. Tags must name assets that exist; to make a new one, use generate_asset instead. Returns the picked tag, or null when the user dismissed the choice.',
			inputSchema: {
				question: z.string().describe('The choice, in plain words: "Which hero image?"'),
				tags: z.array(z.string()).min(2).max(6).describe("Existing asset tags, with or without the leading @"),
				why: z.string().describe("One line on what the pick decides, shown with the question"),
			},
			async handler(ctx: ToolContext, args: { question: string; tags: string[]; why: string }) {
				const index = await readAssetIndex(ctx.projectPath)
				const wanted = args.tags.map((tag) => tag.replace(/^@/, ""))

				// Every tag has to exist before anything is shown. Offering a mix of
				// real and invented options would let the user pick a picture of
				// nothing, and the agent would carry that tag into a page.
				const missing = wanted.filter((tag) => !findAsset(index, tag))
				if (missing.length > 0) {
					const available = index.assets.map((asset) => `@${asset.tag}`).join(", ")
					return fail(
						`No asset tagged ${missing.map((tag) => `"${tag}"`).join(", ")}. ` +
							`Available: ${available || "none — this project has no assets yet"}.`,
					)
				}

				const picked = await askUser(send, {
					kind: "asset-options",
					question: args.question,
					why: args.why,
					options: wanted.map((tag) => {
						const entry = findAsset(index, tag)!
						return {
							tag: entry.tag,
							url: assetUrl(entry),
							kind: entry.kind,
							// Same route the library uses: posters live inside the assets
							// directory, so the middleware that serves assets serves them.
							posterUrl: entry.poster ? `/caret-assets/.posters/${encodeURIComponent(entry.poster)}` : null,
						}
					}),
				})

				return picked === null
					? ok({ picked: null, note: "The user dismissed the choice without picking. Ask, or carry on without one." })
					: ok({ picked })
			},
		},

		{
			name: "generate_asset",
			title: "Generate an asset the design needs",
			description:
				"Makes an image, texture, logo mark, 3D object or animated background shader and adds it to the project's assets, returning the @tag to reference it. Use this when the design you are discussing needs something the user does not have — say what it is in plain words, the way you would describe it to somebody. Caret asks the user to approve it first (images and 3D cost the user money on their own key), generates, and lets them point at what they want to keep. Everything about how it is lit, framed and coloured comes from the project's foundation, so describe the SUBJECT and not the styling — except a shader, where hues and mood belong in the description.",
			inputSchema: {
				kind: z
					.enum(["image", "texture", "mark", "object3d", "shader"])
					.describe(
						"image: a photograph. texture: grain, a wash, a pattern — free and local. mark: a logo. object3d: a 3D model — one call runs the whole chain: Caret generates the source image, the user picks a take, Tripo rebuilds it in 3D. shader: an animated background gradient, written as a live component with tunable colours.",
					),
				what: z.string().min(2).describe('What it is, in plain words: "a brushed steel paperclip"'),
				why: z.string().describe("One line on what it is for, shown to the user when asking whether to make it"),
				transparent: z.boolean().optional().describe("True when it must sit on any background with no box around it"),
				source: z
					.string()
					.optional()
					.describe(
						"object3d only: the @tag of an image asset to rebuild in 3D — use it when the exact object already exists as an image, so the 3D version matches it. Omit to have Caret generate the source from `what`.",
					),
			},
			async handler(
				ctx: ToolContext,
				args: {
					kind: "image" | "texture" | "mark" | "object3d" | "shader"
					what: string
					why: string
					transparent?: boolean
					source?: string
				},
			) {
				// Generation moved to the Assets tab, deliberately: the agent's
				// one-line briefs made technically-correct, bland assets, while the
				// tab's describe→clarify→iterate loop is where quality happens. The
				// agent's judgment about WHAT the design needs stays valuable — it
				// goes to the user as a suggestion instead of to the generator as a
				// brief. The whole chain below stays built behind the pref.
				if (!getPrefs().chatAssetGeneration) {
					return ok({
						generated: false,
						note:
							"Assets are created by the user in the Assets tab, not from chat. Tell the user, in one short line, exactly what to create there — the subject in plain words " +
							`(for this one: "${args.what}") — and whether it should be transparent. Keep building meanwhile with an existing @tag or a clearly-marked placeholder, ` +
							"and reference the new asset by its @tag once they have made it. Do not retry this tool in this conversation.",
					})
				}

				const request = {
					kind: args.kind,
					text: args.what,
					...(args.transparent ? { transparent: true } : {}),
				}

				// A missing key is known before anyone is asked anything — consenting
				// to a generation that can only end in an authorization error spends
				// the user's attention on Caret's own configuration. Photographs and
				// the mark's render-compare target both ride the image key; a 3D
				// build needs it too unless it starts from an existing asset.
				// Textures and shaders are free and local, so they pass untouched.
				const needsImageKey =
					args.kind === "image" || args.kind === "mark" || (args.kind === "object3d" && !args.source?.trim())
				if (needsImageKey && !rasterConfig()) {
					return ok({
						generated: false,
						note:
							"Image generation needs a Google Gemini API key and none is configured — this lane cannot run at all right now, so do not retry it this conversation. " +
							"Ask the user to add a key in Settings, and keep building meanwhile: textures and animated shaders are free and local, or the page can hold a place for the image.",
					})
				}

				if (args.kind === "object3d") {
					const { tripoAvailable } = await import("../generate-3d")
					if (!tripoAvailable()) {
						return ok({
							generated: false,
							note: "3D generation needs a Tripo API key, and none is configured — ask the user to add one in Settings. A transparent image cutout can stand in on the page meanwhile.",
						})
					}
				}

				// Proposed, never assumed. The image and 3D lanes spend the user's own
				// credits, and an agent deciding to spend them mid-conversation is the
				// one thing this surface must not do.
				//
				// `place: "chat"` on this and every prompt below: generation asked for
				// in a conversation is answered in the conversation. Without it these
				// ride the interview's surface rules — force-switch to Foundation, all
				// navigation vetoed until answered — and four parallel generate calls
				// once pinned a user to a tab they never opened.
				const paid = args.kind === "image" || args.kind === "object3d"
				const consent = await askUser(send, {
					kind: "question",
					place: "chat",
					question: `Generate ${args.what}?`,
					hint:
						args.kind === "object3d"
							? `${args.why} This runs on your image key and your Tripo credits, and takes a few minutes.`
							: paid
								? `${args.why} This one runs on your image key and costs you directly.`
								: args.why,
					choices: ["Generate it", "Not now"],
				})
				if (consent !== "Generate it") {
					return ok({ generated: false, note: "The user declined. Carry on without it, or suggest an alternative." })
				}

				if (args.kind === "object3d") {
					// The whole chain in one call — the shape this lane was asked for:
					// prompt → source image → Tripo → optimized .glb in the library.
					// The agent names the subject once; everything between is Caret's.
					const { acceptModel3d, generateModel3d } = await import("../generate-3d")

					let sourceTag = args.source?.replace(/^@/, "").trim() ?? ""
					if (!sourceTag) {
						// A purpose-made source: the cutout lane's output — one object,
						// even light, no background — is exactly what reconstruction
						// wants, and the kept take is a normal asset in its own right.
						const sourceRequest = { kind: "image" as const, text: args.what, transparent: true }
						const takes = await requestTakes(ctx.projectPath, sourceRequest, "")
						const usable = takes.filter((take) => !take.error)
						if (usable.length === 0) {
							if (takes.some((take) => take.retryable)) {
								return ok({
									generated: false,
									note:
										"The image service is out of quota right now, so the 3D source could not be made — Caret already retried with waits. " +
										"Do NOT retry now and do not stall the page: keep building, and mention that the 3D object can be generated later.",
								})
							}
							const why = takes[0]?.error ?? "nothing came back"
							return ok({ generated: false, note: `The 3D source image could not be made: ${why}` })
						}

						const picked = await askUser(send, {
							kind: "takes",
							place: "chat",
							title: `The source for the 3D ${args.what}`,
							subtitle: `${args.why} Tripo rebuilds exactly what the picture shows — pick the take to build from. The 3D step takes a few minutes.`,
							takes: takes.map((take) => ({ index: take.variant, preview: take.preview, error: take.error })),
							surface: usable[0].surface,
						})
						if (picked === null) {
							return ok({ generated: false, note: "The user did not pick a source take, so nothing was built." })
						}
						const savedSource = await acceptRequestTake(
							ctx.projectPath,
							sourceRequest,
							"",
							Number(picked),
							slugTag(args.what),
						)
						if (!savedSource.ok || !savedSource.tag) {
							return fail(savedSource.error ?? "The chosen source take could not be saved.")
						}
						sourceTag = savedSource.tag
					}

					const outcome = await generateModel3d(ctx.projectPath, sourceTag, (update) =>
						Logger.info(`[3d] ${update.stage}${update.detail ? ` — ${update.detail}` : ""}`),
					)
					if (!outcome.ok) {
						return ok({
							generated: false,
							note: outcome.badSource
								? `${outcome.reason ?? "The source image did not look like a single object."} The source is @${sourceTag}; a different source image is the fix, not a retry of this one.`
								: `3D generation did not produce anything: ${outcome.reason ?? "no reason was given"}`,
						})
					}

					const saved3d = await acceptModel3d(ctx.projectPath, "")
					if (!saved3d.ok || !saved3d.tag) return fail(saved3d.error ?? "The 3D model could not be saved.")
					await regenerateRulesFiles(ctx.projectPath).catch(() => {})
					return ok({
						generated: true,
						tag: saved3d.tag,
						reference: `@${saved3d.tag}`,
						sourceImage: `@${sourceTag}`,
						modelUrl: `/caret-assets/${saved3d.tag}.glb`,
						...(outcome.reason ? { note2: outcome.reason } : {}),
						note:
							`A .glb model built from @${sourceTag} (that source image is in the library too, as a normal image). ` +
							"A .glb is NOT an image — an <img> tag cannot show it. To put it on a page, render it with a 3D viewer " +
							"you add to the page workspace yourself: install a viewer library into the design layer (" +
							"`npm install --prefix .caret @google/model-viewer --ignore-scripts` from the project root, " +
							'then `import "@google/model-viewer"` once and use ' +
							`<model-viewer src="/caret-assets/${saved3d.tag}.glb" auto-rotate camera-controls> sized like an image), ` +
							"or three.js if the scene needs more. Installs in that exact shape run without a prompt.",
					})
				}

				if (args.kind === "mark") {
					// One authored result from the render-compare loop, not three takes —
					// the same shape the shader branch below uses.
					const { authorMark, holdMark, acceptMark } = await import("../authored-marks")
					const { readFoundationTokens } = await import("../../../src/core/design")
					const { taskModel } = await import("../task-models")
					const tokens = await readFoundationTokens(ctx.projectPath).catch(() => null)
					const result = await authorMark({
						projectPath: ctx.projectPath,
						brief: args.what,
						tokens,
						modelOverride: taskModel("mark") || undefined,
					})
					if (!result.ok) return ok({ generated: false, note: `Generation did not produce anything: ${result.reason}` })

					holdMark(ctx.projectPath, { svg: result.svg, subject: args.what, rounds: result.rounds, model: result.model })
					const kept = await askUser(send, {
						kind: "takes",
						place: "chat",
						title: `The mark, after ${result.rounds} round(s)`,
						subtitle: `${args.why} Pick it to keep it.`,
						takes: [{ index: 0, preview: `data:image/png;base64,${result.previewPng.toString("base64")}` }],
						surface: "#ffffff",
					})
					if (kept === null) return ok({ generated: false, note: "The user did not keep it." })

					const saved = await acceptMark(ctx.projectPath, slugTag(args.what))
					if (!saved.ok) return fail(saved.error ?? "The mark could not be saved.")
					await regenerateRulesFiles(ctx.projectPath).catch(() => {})
					return ok({
						generated: true,
						tag: saved.tag,
						reference: `@${saved.tag}`,
						note: "Reference it by that tag in the page you write. It is in the asset index and the rules files now.",
					})
				}

				if (args.kind === "shader") {
					// One authored result, not three takes. The frames shown are three
					// moments of the SAME animation; the pick is a keep, not a choice.
					const { authorShader, holdShader, acceptShader } = await import("../authored-shaders")
					const { readFoundationTokens } = await import("../../../src/core/design")
					const { taskModel } = await import("../task-models")
					const tokens = await readFoundationTokens(ctx.projectPath).catch(() => null)
					const result = await authorShader({
						projectPath: ctx.projectPath,
						request: { kind: "shader", text: args.what },
						tokens,
						modelOverride: taskModel("shader") || undefined,
					})
					if (!result.ok) return ok({ generated: false, note: `Generation did not produce anything: ${result.reason}` })

					holdShader(ctx.projectPath, { outcome: result.shader, subject: args.what })
					const kept = await askUser(send, {
						kind: "takes",
						place: "chat",
						title: `Moments of ${args.what}`,
						subtitle: `${args.why} These are three moments of one animation — pick any to keep it.`,
						takes: result.shader.framePngs.map((frame, index) => ({
							index,
							preview: `data:image/png;base64,${frame.toString("base64")}`,
						})),
						surface: "#0a0a0a",
					})
					if (kept === null) return ok({ generated: false, note: "The user did not keep it." })

					const saved = await acceptShader(ctx.projectPath, slugTag(args.what))
					if (!saved.ok) return fail(saved.error ?? "The shader could not be saved.")
					await regenerateRulesFiles(ctx.projectPath).catch(() => {})
					return ok({
						generated: true,
						tag: saved.tag,
						reference: `@${saved.tag}`,
						component: saved.componentPath,
						note: `The live animated version is the component at ${saved.componentPath} — import and place THAT for motion; the @tag is its poster still. Its colours and motion are tunable props.`,
					})
				}

				const takes = await requestTakes(ctx.projectPath, request, "")
				const usable = takes.filter((take) => !take.error)
				if (usable.length === 0) {
					// Quota exhaustion must not stall the build: the client already
					// queued, spaced and retried with backoff, so this is genuine
					// exhaustion — the agent's move is to continue, not to re-strategize
					// around infrastructure (field: an agent spent turns inventing its
					// own sequential retry policy over raw 429 notes).
					if (takes.some((take) => take.retryable)) {
						return ok({
							generated: false,
							note:
								"The image service is out of quota right now — Caret already retried with waits between attempts. " +
								"Do NOT retry now and do not stall the page on this asset: keep building, and mention to the user " +
								"that this image can be regenerated later from the Assets tab with the same description.",
						})
					}
					const why = takes[0]?.error ?? "nothing came back"
					return ok({ generated: false, note: `Generation did not produce anything: ${why}` })
				}

				const picked = await askUser(send, {
					kind: "takes",
					place: "chat",
					title: `Three takes of ${args.what}`,
					subtitle: args.why,
					takes: takes.map((take) => ({ index: take.variant, preview: take.preview, error: take.error })),
					surface: usable[0].surface,
				})
				if (picked === null) {
					return ok({ generated: false, note: "The user did not pick any of the takes." })
				}

				const tag = slugTag(args.what)
				const saved = await acceptRequestTake(ctx.projectPath, request, "", Number(picked), tag)
				if (!saved.ok) return fail(saved.error ?? "The chosen take could not be saved.")

				await regenerateRulesFiles(ctx.projectPath).catch(() => {})
				return ok({
					generated: true,
					tag: saved.tag ?? tag,
					reference: `@${saved.tag ?? tag}`,
					note: "Reference it by that tag in the page you write. It is in the asset index and the rules files now.",
				})
			},
		},
	]
}

function present(candidate: ReturnType<typeof narrowCandidates>[number]): PresentedCandidate {
	return {
		id: candidate.id,
		name: candidate.name,
		summary: candidate.summary,
		fontUrl: candidateFontUrl(candidate),
		displayFamily: candidate.typeface.display.family,
		displayFallback: candidate.typeface.display.fallback,
		bodyFamily: candidate.typeface.body.family,
		bodyFallback: candidate.typeface.body.fallback,
		surface: candidate.palette.surface,
		brandColor: candidate.tokens.color.brand.seed,
		neutralCharacter: candidate.palette.neutral,
		radius: candidate.shape.radius.scale,
		baseSize: candidate.shape.baseSize,
	}
}

/**
 * The interview script, shipped as an MCP prompt.
 *
 * Written as instructions to the agent rather than as a fixed sequence, because
 * an agent that already knows the product from context should skip questions
 * rather than ask them again — being asked what you are building by something
 * that just read your repo is worse than not being asked at all.
 */
export const INTERVIEW_PROMPT = `You are setting up the visual foundations for this project with the user.

Run a short interview — five questions at most, fewer if you can already answer some
of them from the repository. Ask in plain language about the product and how it should
feel. Never ask about type scales, radius values, saturation or spacing units: the user
is a developer who is not a designer, and those questions get a guess rather than an
answer.

Use \`present_question\` for each question. Suggested questions, which you should adapt
or skip as appropriate:

${INTERVIEW_QUESTIONS.map((q, i) => `${i + 1}. ${q.question}\n   ${q.choices.map((c) => `- ${c.label}`).join("\n   ")}`).join("\n")}

From the answers, infer a set of vibe tags and call \`present_options\` with them. Caret
narrows its curated library and renders complete foundations as live specimens for the
user to point at. You cannot pass your own colours or font names — that is deliberate,
and it is what keeps the floor high.

When the user picks one, call \`commit_foundation\` immediately with the returned
candidateId. Then tell them, in one or two sentences, what they chose and the one
restraint rule that comes with it, so they know what it means for everything you build
next.`

/** A tag from what the agent asked for, so the asset is named after itself. */
function slugTag(what: string): string {
	const slug = what
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.split(/\s+/)
		.filter((word) => word && !["a", "an", "the", "of", "and", "with", "on"].includes(word))
		.slice(0, 3)
		.join("-")
	return slug || "generated"
}
