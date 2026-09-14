/**
 * Decorative vector assets as **code**, not as a model's output.
 *
 * The argument is not primarily cost, though the lane is free. A model that
 * emits `d="M12.4 88.1c…"` produces something nobody can edit or verify: the
 * agent cannot adjust it, the visual editor cannot address it, the diff is
 * meaningless, and a result that is subtly wrong can only be regenerated, never
 * corrected. A generator call is a **parameter set** — deterministic,
 * re-runnable, diffable, and tunable after the fact, which is the Phase 8
 * parameter model arriving early.
 *
 * It also makes generate-and-pick free. Twelve variants is twelve integers, so
 * the surface that needs a wall of options to be worth using can have one
 * without latency or spend.
 *
 * **Every generator is pure**: the same palette, size, seed and params produce
 * byte-identical SVG on every machine. No `Math.random`, no `Date`, no float
 * printed at full precision. That is what makes a committed asset reviewable and
 * a re-run a no-op rather than a diff.
 */
import type { GeneratorPalette } from "./types"

export interface GeneratorInput {
	palette: GeneratorPalette
	width: number
	height: number
	/** Integer. The only source of variation between variants. */
	seed: number
	params: Record<string, number>
}

export interface Generator {
	id: string
	name: string
	/** What it produces, in plain language. */
	produces: string
	/**
	 * Every parameter, with a default and a range.
	 *
	 * Published rather than implicit because these are the knobs the tuning
	 * surface will expose, and because a parameter with no declared range is one
	 * nobody can offer a control for.
	 */
	params: Record<string, { label: string; default: number; min: number; max: number; step: number }>
	/** True when the output has no opaque background — layerable over a page. */
	transparent: boolean
	render(input: GeneratorInput): string
}

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

/**
 * mulberry32 — small, fast, and identical everywhere.
 *
 * Written out rather than pulled from a dependency on purpose: an asset
 * committed to the user's repo must be reproducible from the recorded seed years
 * later, and that guarantee cannot depend on a transitive package's version.
 */
function rng(seed: number): () => number {
	let state = (seed >>> 0) + 0x6d2b79f5
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Two decimals, no trailing zeros, no exponent. Keeps the SVG diffable. */
function n(value: number): string {
	return String(Math.round(value * 100) / 100)
}

function pick<T>(random: () => number, items: T[]): T {
	return items[Math.floor(random() * items.length) % items.length]
}

function between(random: () => number, min: number, max: number): number {
	return min + random() * (max - min)
}

/**
 * No `fill="none"` on the root, however tidy it looks.
 *
 * It is the habit from icon sets, and here it is a bug: an element that inherits
 * `fill: none` paints nothing, and **Chromium then skips its filter entirely** —
 * so a `<rect>` whose whole purpose is to carry an `feTurbulence` renders blank.
 * That is exactly how the grain overlay shipped invisible, passing every unit
 * test on the way, because the SVG it emitted was perfectly well-formed. Anything
 * that strokes without filling says so on its own group instead.
 */
function svg(width: number, height: number, body: string): string {
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		body,
		"</svg>",
		"",
	].join("\n")
}

/**
 * A grain filter, reused by everything that needs one.
 *
 * Grain is the single most effective anti-slop treatment available here: a
 * perfectly smooth gradient is the most recognisable "made by a computer just
 * now" surface there is, and a little luminance noise reads as print. It is also
 * why these are SVG rather than PNG — `feTurbulence` costs no bytes.
 */
function grainFilter(id: string, amount: number, frequency: number, frame: { width: number; height: number }): string {
	return [
		// Pinned to the frame in user space rather than to the filtered element's
		// bounding box. Blurred washes overhang the viewport by design, and a
		// box-relative region cuts the filter off at the union of their edges —
		// which paints as a hard vertical seam through the middle of the picture.
		`<filter id="${id}" filterUnits="userSpaceOnUse" x="0" y="0" width="${frame.width}" height="${frame.height}">`,
		`<feTurbulence type="fractalNoise" baseFrequency="${n(frequency)}" numOctaves="3" stitchTiles="stitch" result="noise"/>`,
		`<feColorMatrix in="noise" type="saturate" values="0" result="mono"/>`,
		`<feComponentTransfer in="mono" result="grain"><feFuncA type="linear" slope="${n(amount)}"/></feComponentTransfer>`,
		`<feBlend in="SourceGraphic" in2="grain" mode="multiply"/>`,
		"</filter>",
	].join("")
}

/* ------------------------------------------------------------------ *
 * The generators
 * ------------------------------------------------------------------ */

/**
 * Soft overlapping washes of colour — the background a hero section sits on.
 *
 * Capped at three colour sources, all from the foundation. The failure mode this
 * cap prevents is the one every mesh-gradient tool ships with: five saturated
 * hues at equal weight, which reads as a screensaver rather than as a surface.
 */
const MESH_GRADIENT: Generator = {
	id: "mesh-gradient",
	name: "Soft colour wash",
	produces: "Overlapping blurred washes of the brand colour on the project's surface.",
	transparent: false,
	params: {
		blobs: { label: "How many washes", default: 4, min: 2, max: 6, step: 1 },
		spread: { label: "How far they spread", default: 0.55, min: 0.25, max: 0.9, step: 0.05 },
		intensity: { label: "How much colour", default: 0.55, min: 0.15, max: 1, step: 0.05 },
		grain: { label: "Grain", default: 0.12, min: 0, max: 0.4, step: 0.02 },
	},
	render({ palette, width, height, seed, params }) {
		const random = rng(seed)
		const count = Math.round(params.blobs)
		const spread = params.spread
		const intensity = params.intensity

		// Three sources, deliberately: the brand, its quiet step, and the raised
		// neutral. The neutral is what stops the result reading as a paint spill.
		const sources = [palette.brand, palette.brandQuiet, palette.raised]

		const stops: string[] = []
		const circles: string[] = []
		for (let i = 0; i < count; i++) {
			const id = `w${i}`
			const colour = sources[i % sources.length]
			const cx = between(random, 0.1, 0.9) * width
			const cy = between(random, 0.1, 0.9) * height
			const r = between(random, spread * 0.5, spread) * Math.max(width, height)
			// Opacity falls off across the set so the first wash leads and the rest
			// support it. Equal weights are what make these look like wallpaper.
			const opacity = intensity * (1 - i / (count + 1))

			stops.push(
				`<radialGradient id="${id}" cx="50%" cy="50%" r="50%">` +
					`<stop offset="0%" stop-color="${colour}" stop-opacity="${n(opacity)}"/>` +
					`<stop offset="100%" stop-color="${colour}" stop-opacity="0"/>` +
					"</radialGradient>",
			)
			circles.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="url(#${id})"/>`)
		}

		const filter = params.grain > 0 ? grainFilter("grain", params.grain, 0.8, { width, height }) : ""
		const group = params.grain > 0 ? `<g filter="url(#grain)">${circles.join("")}</g>` : circles.join("")

		return svg(
			width,
			height,
			`<defs>${stops.join("")}${filter}</defs>` +
				`<rect width="${width}" height="${height}" fill="${palette.surface}"/>` +
				group,
		)
	},
}

/**
 * Two stops and a lot of grain — the "grainy gradient" look, done honestly.
 *
 * The reason this is its own generator rather than a mesh with one blob: the
 * grain is the subject here, not a finish. It runs an order of magnitude
 * stronger and at a finer frequency, which is what separates a printed-looking
 * surface from a smooth one someone added noise to.
 */
const GRAIN_WASH: Generator = {
	id: "grain-wash",
	name: "Grainy fade",
	produces: "A two-colour fade with heavy print-like grain.",
	transparent: false,
	params: {
		angle: { label: "Direction", default: 155, min: 0, max: 360, step: 5 },
		grain: { label: "Grain", default: 0.5, min: 0.1, max: 1, step: 0.05 },
		contrast: { label: "How far the fade travels", default: 0.7, min: 0.2, max: 1, step: 0.05 },
	},
	render({ palette, width, height, seed, params }) {
		const random = rng(seed)
		// The seed only nudges the declared angle. A seed that could rotate the
		// gradient anywhere would make "variant 3" a different decision rather
		// than a different roll of the same one.
		const angle = (params.angle + between(random, -25, 25)) % 360
		const radians = (angle * Math.PI) / 180
		const x2 = n(50 + Math.cos(radians) * 50)
		const y2 = n(50 + Math.sin(radians) * 50)
		const x1 = n(50 - Math.cos(radians) * 50)
		const y1 = n(50 - Math.sin(radians) * 50)

		const far = palette.mode === "dark" ? palette.surface : palette.raised

		return svg(
			width,
			height,
			`<defs>` +
				`<linearGradient id="fade" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">` +
				`<stop offset="0%" stop-color="${palette.brand}" stop-opacity="${n(params.contrast)}"/>` +
				`<stop offset="60%" stop-color="${palette.brandQuiet}" stop-opacity="${n(params.contrast * 0.5)}"/>` +
				`<stop offset="100%" stop-color="${far}" stop-opacity="0"/>` +
				"</linearGradient>" +
				grainFilter("grain", params.grain, 1.4, { width, height }) +
				"</defs>" +
				`<rect width="${width}" height="${height}" fill="${palette.surface}"/>` +
				`<rect width="${width}" height="${height}" fill="url(#fade)" filter="url(#grain)"/>`,
		)
	},
}

/**
 * Transparent noise, for layering over something that already exists.
 *
 * The one generator whose output is meant to sit on top of a photograph or a
 * flat block rather than be the thing itself, which is why it is the only one
 * with no surface rectangle.
 */
const GRAIN_OVERLAY: Generator = {
	id: "grain-overlay",
	name: "Grain overlay",
	produces: "Transparent film grain to lay over an image or a flat colour.",
	transparent: true,
	params: {
		amount: { label: "Strength", default: 0.5, min: 0.05, max: 1, step: 0.05 },
		fineness: { label: "How fine", default: 0.9, min: 0.3, max: 2, step: 0.1 },
	},
	render({ width, height, seed, params }) {
		const random = rng(seed)
		const frequency = params.fineness * between(random, 0.85, 1.15)
		return svg(
			width,
			height,
			`<defs>` +
				`<filter id="noise" filterUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">` +
				`<feTurbulence type="fractalNoise" baseFrequency="${n(frequency)}" numOctaves="4" stitchTiles="stitch" seed="${Math.round(seed)}" result="noise"/>` +
				`<feColorMatrix in="noise" type="saturate" values="0" result="mono"/>` +
				// Pushed to pure black or pure white per pixel, rather than left as
				// the mid-grey the saturate step produces. Grey speckle at any
				// opacity is a *haze*: laid over a dark block it visibly lightens
				// the whole area, which is what the first version did and what made
				// it read as fog rather than film. Salt-and-pepper lightens and
				// darkens in equal measure, so the average is unchanged and only
				// the texture survives.
				`<feComponentTransfer in="mono">` +
				`<feFuncR type="discrete" tableValues="0 1"/>` +
				`<feFuncG type="discrete" tableValues="0 1"/>` +
				`<feFuncB type="discrete" tableValues="0 1"/>` +
				`<feFuncA type="linear" slope="${n(params.amount)}"/>` +
				`</feComponentTransfer>` +
				`</filter>` +
				"</defs>" +
				`<rect width="${width}" height="${height}" filter="url(#noise)"/>`,
		)
	},
}

/**
 * A dot field that thins out across the frame.
 *
 * Halftone is the treatment that most reliably makes a flat colour block look
 * deliberate, and it is trivially parametric — which is exactly the case for
 * code over a model.
 */
const HALFTONE: Generator = {
	id: "halftone",
	name: "Halftone fade",
	produces: "A field of dots that thins across the frame.",
	transparent: true,
	params: {
		spacing: { label: "Dot spacing", default: 18, min: 6, max: 48, step: 2 },
		maxRadius: { label: "Largest dot", default: 0.42, min: 0.1, max: 0.5, step: 0.02 },
		angle: { label: "Fade direction", default: 135, min: 0, max: 360, step: 15 },
	},
	render({ palette, width, height, seed, params }) {
		const random = rng(seed)
		const spacing = Math.max(6, Math.round(params.spacing))
		const radians = ((params.angle + between(random, -20, 20)) * Math.PI) / 180
		const dx = Math.cos(radians)
		const dy = Math.sin(radians)

		// Normalised against the frame's own corners rather than a hand-rolled
		// offset. The first version added `width` when dx was negative, which is
		// only correct at the axes — at every angle in between the fade started
		// outside the frame, so two of every four variants came back blank or
		// nearly so. Projecting the four corners is exact at any angle and any
		// aspect ratio.
		const corners = [0 * dx + 0 * dy, width * dx + 0 * dy, 0 * dx + height * dy, width * dx + height * dy]
		const low = Math.min(...corners)
		const span = Math.max(...corners) - low || 1

		const dots: string[] = []
		for (let y = spacing / 2; y < height; y += spacing) {
			for (let x = spacing / 2; x < width; x += spacing) {
				const t = 1 - Math.min(1, Math.max(0, (x * dx + y * dy - low) / span))
				if (t <= 0.02) continue
				const r = t * t * params.maxRadius * spacing
				if (r < 0.35) continue
				dots.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}"/>`)
			}
		}

		return svg(width, height, `<g fill="${palette.ink}" opacity="0.85">${dots.join("")}</g>`)
	},
}

/**
 * A seeded grid of small marks — hairlines, crosses, arcs.
 *
 * Kept to one ink colour at low opacity. A pattern in two colours stops being a
 * texture and starts being an illustration competing with the content on top.
 */
const LINE_GRID: Generator = {
	id: "line-grid",
	name: "Technical grid",
	produces: "A quiet grid of hairlines and small marks.",
	transparent: true,
	params: {
		cell: { label: "Grid size", default: 64, min: 16, max: 200, step: 8 },
		density: { label: "How many marks", default: 0.35, min: 0.05, max: 1, step: 0.05 },
		opacity: { label: "How visible", default: 0.14, min: 0.03, max: 0.5, step: 0.01 },
	},
	render({ palette, width, height, seed, params }) {
		const random = rng(seed)
		const cell = Math.max(16, Math.round(params.cell))
		const stroke = Math.max(0.75, cell / 64)

		const lines: string[] = []
		for (let x = cell; x < width; x += cell) lines.push(`<path d="M${n(x)} 0V${height}"/>`)
		for (let y = cell; y < height; y += cell) lines.push(`<path d="M0 ${n(y)}H${width}"/>`)

		const marks: string[] = []
		for (let y = cell; y < height; y += cell) {
			for (let x = cell; x < width; x += cell) {
				if (random() > params.density) continue
				const size = cell * 0.16
				const kind = pick(random, ["cross", "dot", "arc"])
				if (kind === "cross") {
					marks.push(`<path d="M${n(x - size)} ${n(y)}H${n(x + size)}M${n(x)} ${n(y - size)}V${n(y + size)}"/>`)
				} else if (kind === "dot") {
					marks.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${n(size * 0.35)}" fill="${palette.ink}" stroke="none"/>`)
				} else {
					marks.push(`<path d="M${n(x - size)} ${n(y)}a${n(size)} ${n(size)} 0 0 1 ${n(size * 2)} 0"/>`)
				}
			}
		}

		return svg(
			width,
			height,
			// `fill="none"` belongs here, on the one group that strokes without
			// filling, rather than on the root where it silently kills filters.
			`<g fill="none" stroke="${palette.ink}" stroke-width="${n(stroke)}" opacity="${n(params.opacity)}">` +
				lines.join("") +
				marks.join("") +
				"</g>",
		)
	},
}

/**
 * One closed organic shape, smoothed.
 *
 * Built from polar points joined with a Catmull-Rom-to-Bezier conversion rather
 * than a polygon, because the tell of a generated blob is visible straight
 * segments where the curve should be continuous.
 */
const ORGANIC_SHAPE: Generator = {
	id: "organic-shape",
	name: "Organic shape",
	produces: "A single soft closed shape in the brand colour.",
	transparent: true,
	params: {
		points: { label: "How irregular", default: 7, min: 4, max: 12, step: 1 },
		wobble: { label: "How uneven", default: 0.24, min: 0.05, max: 0.5, step: 0.02 },
		opacity: { label: "How solid", default: 0.9, min: 0.1, max: 1, step: 0.05 },
	},
	render({ palette, width, height, seed, params }) {
		const random = rng(seed)
		const count = Math.round(params.points)
		const cx = width / 2
		const cy = height / 2
		// Sized so the widest possible wobble still lands inside the frame. A blob
		// clipped by its own edge stops reading as a shape and starts reading as a
		// mistake.
		const baseRadius = (Math.min(width, height) * 0.47) / (1 + params.wobble)
		const rotation = random() * Math.PI * 2

		const points: Array<{ x: number; y: number }> = []
		for (let i = 0; i < count; i++) {
			// Both the angle and the radius are jittered. Radius alone produced
			// shapes that were all recognisably the same circle with a dent — the
			// asymmetry that makes a blob look drawn comes from uneven *spacing*,
			// which evenly divided angles cannot express however much the radius
			// varies.
			const spacing = (Math.PI * 2) / count
			const angle = rotation + i * spacing + between(random, -spacing * 0.32, spacing * 0.32)
			const radius = baseRadius * (1 - params.wobble + random() * params.wobble * 2)
			points.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
		}

		return svg(width, height, `<path d="${closedSpline(points)}" fill="${palette.brand}" opacity="${n(params.opacity)}"/>`)
	},
}

/**
 * The edge between two sections — a slant, a wave, or a soft arc.
 *
 * Filled with the surface colour so it reads as the *page* pushing into the
 * section above, which is the only version of this that does not look like a
 * decoration stuck on.
 */
const SECTION_EDGE: Generator = {
	id: "section-edge",
	name: "Section edge",
	produces: "A shaped divider between two bands of a page.",
	transparent: true,
	params: {
		depth: { label: "How deep", default: 0.45, min: 0.1, max: 1, step: 0.05 },
		waves: { label: "How many curves", default: 2, min: 1, max: 5, step: 1 },
		flip: { label: "Which way up", default: 0, min: 0, max: 1, step: 1 },
	},
	render({ palette, width, height, seed, params }) {
		const random = rng(seed)
		const waves = Math.round(params.waves)
		const amplitude = height * params.depth * 0.5
		const mid = height * 0.5

		let path = `M0 ${n(mid + between(random, -amplitude, amplitude) * 0.3)}`
		const segment = width / waves
		for (let i = 0; i < waves; i++) {
			const x0 = segment * i
			const x1 = segment * (i + 1)
			const control = mid + (i % 2 === 0 ? -1 : 1) * amplitude * between(random, 0.7, 1)
			path += `C${n(x0 + segment / 3)} ${n(control)} ${n(x1 - segment / 3)} ${n(control)} ${n(x1)} ${n(mid)}`
		}
		path += params.flip >= 0.5 ? `L${width} 0L0 0Z` : `L${width} ${height}L0 ${height}Z`

		return svg(width, height, `<path d="${path}" fill="${palette.surface}"/>`)
	},
}

/**
 * Catmull-Rom through every point, emitted as cubic Beziers, closed.
 *
 * The wrap-around indexing is what makes the join at the start point as smooth
 * as every other — a spline that closes with a straight `Z` has one visible
 * corner, and it is always the one the eye lands on.
 */
function closedSpline(points: Array<{ x: number; y: number }>): string {
	if (points.length < 3) return ""
	const at = (index: number) => points[(index + points.length) % points.length]

	let d = `M${n(points[0].x)} ${n(points[0].y)}`
	for (let i = 0; i < points.length; i++) {
		const p0 = at(i - 1)
		const p1 = at(i)
		const p2 = at(i + 1)
		const p3 = at(i + 2)
		const c1x = p1.x + (p2.x - p0.x) / 6
		const c1y = p1.y + (p2.y - p0.y) / 6
		const c2x = p2.x - (p3.x - p1.x) / 6
		const c2y = p2.y - (p3.y - p1.y) / 6
		d += `C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(p2.x)} ${n(p2.y)}`
	}
	return `${d}Z`
}

export const GENERATORS: Generator[] = [
	MESH_GRADIENT,
	GRAIN_WASH,
	GRAIN_OVERLAY,
	HALFTONE,
	LINE_GRID,
	ORGANIC_SHAPE,
	SECTION_EDGE,
]

export function findGenerator(id: string): Generator | undefined {
	return GENERATORS.find((generator) => generator.id === id)
}

/**
 * Runs a generator with its declared defaults filled in and every parameter
 * clamped to its declared range.
 *
 * Clamping here rather than in each generator means a recipe (or, later, a
 * tuning control, or an agent) cannot drive one outside the range it was
 * designed for and get a result that is technically valid SVG and visually
 * broken — a 400px dot spacing on a 1200px frame is four dots.
 */
export function runGenerator(id: string, input: GeneratorInput): string {
	const generator = findGenerator(id)
	if (!generator) throw new Error(`No such generator: "${id}". Known: ${GENERATORS.map((g) => g.id).join(", ")}.`)

	const params: Record<string, number> = {}
	for (const [key, spec] of Object.entries(generator.params)) {
		const supplied = input.params[key]
		const value = typeof supplied === "number" && Number.isFinite(supplied) ? supplied : spec.default
		params[key] = Math.min(spec.max, Math.max(spec.min, value))
	}

	return generator.render({ ...input, params })
}
