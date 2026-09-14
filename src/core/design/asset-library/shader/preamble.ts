/**
 * The fixed half of every authored shader.
 *
 * The model writes one function — `vec4 caretMain(vec2 uv)` — and everything
 * else is Caret's: the GLSL version line, the precision, the standard
 * uniforms, and a small curated helper set (hash, noise, fbm, palette). The
 * split is the same one the asset generator already lives by: the user (via
 * the model) says what the thing IS; the scaffold owns how a shader is built,
 * so a generated fragment can never disagree with the runner about its own
 * contract.
 *
 * This module is imported by BOTH the runner template and the authoring
 * prompt. One source of truth: the model reads the exact helper signatures the
 * runner will compile against, and a helper added here reaches both sides in
 * the same commit.
 */

/** A uniform's value as it appears in an instance file's props. */
export type ShaderUniformValue = number | string | [number, number, number]

/** One knob the model declares alongside its fragment body. */
export interface ShaderUniform {
	/** `u_`-prefixed, so it can never collide with a DOM prop or a helper. */
	name: string
	type: "float" | "color"
	label: string
	default: number | string
	min?: number
	max?: number
}

/**
 * Helpers every fragment body can call. Deliberately small and mediump-safe:
 * a curated vocabulary of known-good primitives is what keeps an authored
 * shader looking composed rather than like noise soup, and every function here
 * is textbook GLSL folklore (value noise over a sin hash, standard fbm).
 */
export const SHADER_HELPERS = `float caretHash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float caretNoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(caretHash(i), caretHash(i + vec2(1.0, 0.0)), u.x),
		mix(caretHash(i + vec2(0.0, 1.0)), caretHash(i + vec2(1.0, 1.0)), u.x),
		u.y
	);
}

float caretFbm(vec2 p) {
	float value = 0.0;
	float amplitude = 0.5;
	for (int i = 0; i < 5; i++) {
		value += amplitude * caretNoise(p);
		p = p * 2.02 + vec2(13.7, 7.3);
		amplitude *= 0.5;
	}
	return value;
}

vec3 caretPalette(float t, vec3 a, vec3 b, vec3 c) {
	t = clamp(t, 0.0, 1.0);
	return t < 0.5 ? mix(a, b, smoothstep(0.0, 0.5, t)) : mix(b, c, smoothstep(0.5, 1.0, t));
}

float caretGrain(vec2 uv, float time) {
	return caretHash(uv * 731.7 + fract(time) * 17.0) - 0.5;
}

float caretRelief(vec2 p, float t) {
	// Deliberately LOW frequency everywhere. A normal is a derivative, and
	// differentiating multi-octave fbm turns big folds into tinfoil — measured:
	// the first version of this looked crumpled at every scale. Two slow sine
	// lobes, a gentle domain warp, and one octave of smooth noise is the whole
	// recipe for a form you can point at.
	// Tuned so that p = centred, aspect-corrected uv (roughly -0.5..0.5) with a
	// scale of 1.0 puts ONE big fold across the frame. That calibration is the
	// whole difference between a sculpture and a flat wash: an earlier version
	// needed p multiplied by ~2 before anything was visible, every model
	// sensibly passed scale 1.0, and every result came out flat.
	vec2 q = p;
	q += 0.30 * vec2(caretNoise(q * 1.1 + t * 0.05), caretNoise(q * 1.1 - t * 0.04 + 7.3));
	float h = 0.95 * sin(q.x * 3.4 + t * 0.22);
	h += 0.65 * sin(q.y * 2.6 - t * 0.17 + 1.7);
	h += 0.35 * caretNoise(q * 1.45 + t * 0.03);
	return h;
}

vec3 caretReliefNormal(vec2 p, float t, float strength) {
	// A wide-ish sampling step low-passes the derivative, so the lighting
	// describes the fold rather than the noise riding on it. The 0.3 calibrates
	// strength to human numbers: 1.0 is a natural satin fold, not a cliff.
	float e = 0.006;
	float h = caretRelief(p, t);
	float hx = caretRelief(p + vec2(e, 0.0), t);
	float hy = caretRelief(p + vec2(0.0, e), t);
	vec2 slope = vec2(hx - h, hy - h) / e * strength * 0.3;
	return normalize(vec3(-slope, 1.0));
}

vec2 caretShade(vec3 n, vec3 lightDir, float gloss) {
	vec3 l = normalize(lightDir);
	float diffuse = clamp(dot(n, l), 0.0, 1.0);
	vec3 halfway = normalize(l + vec3(0.0, 0.0, 1.0));
	float specular = pow(clamp(dot(n, halfway), 0.0, 1.0), max(4.0, gloss));
	return vec2(diffuse, specular);
}`

/**
 * What the model is told about the contract. Lives beside the helpers so the
 * prompt can never drift from what the runner actually compiles.
 */
export const SHADER_CONTRACT_DOC = `You are writing ONE GLSL ES 3.00 function:

    vec4 caretMain(vec2 uv)

- uv is 0..1 across the canvas; use u_resolution for aspect (u_resolution.x / u_resolution.y).
- u_time is seconds, forever increasing. Animate slowly — background motion, not a screensaver.
- Return straight (non-premultiplied) RGBA.
- Do NOT write: #version, precision, uniform declarations, main(), or texture reads. The scaffold owns those, and a body containing them is rejected before it compiles.
- Your declared uniforms arrive as floats (type "float") or vec3 0..1 RGB (type "color").
- You may define your own helper functions above caretMain.

Helpers available:
- caretHash(vec2) -> float, caretNoise(vec2) -> float, caretFbm(vec2) -> float (5 octaves)
- caretPalette(float t, vec3 a, vec3 b, vec3 c) -> vec3 — a three-stop ramp
- caretGrain(vec2 uv, float time) -> float, signed, roughly -0.5..0.5

**The sculpted-surface set — this is how a gradient stops looking flat.** The best moving gradients are not coloured noise; they are a LIT SURFACE, where big smooth folds catch a light and fall away into shadow. That is what these three do:
- caretRelief(vec2 p, float t) -> float — a slow-rolling height field of big domain-warped folds, roughly -1.5..1.5. Feed it CENTRED, aspect-corrected coordinates (uv - 0.5, x times aspect): at scale 1.0 that is one big fold across the frame, which is usually what you want. Scale up only for a busier surface.
- caretReliefNormal(vec2 p, float t, float strength) -> vec3 — the surface normal of that height field. strength around 0.3-1.5; higher is more dramatic relief.
- caretShade(vec3 n, vec3 lightDir, float gloss) -> vec2 — .x is diffuse 0..1, .y is a specular highlight 0..1. gloss 8 is soft and satin, 60+ is a tight wet-looking hotspot.

**The light direction is the drama knob.** A grazing light — small z, like vec3(-0.7, 0.55, 0.28) — makes whole regions turn away and fall into deep shadow, which is what makes those big folds read as sculpture. A frontal light (z near 1) lights everything evenly and is how a bold brief ends up looking like a flat wash. Relief strength around 1.2-1.8 for a statement piece, 0.3-0.6 for something that has to sit under text.

A typical sculptural body: build centred aspect-corrected p, get n = caretReliefNormal(p * u_scale, t, u_relief), s = caretShade(n, vec3(-0.5, 0.8, 0.6), u_gloss), map pow(s.x, 1.5) through caretPalette for the body colour, add s.y * a highlight colour, then a touch of caretGrain.`

/** Reserved names the manifest may not redeclare. */
const RESERVED_UNIFORMS = new Set(["u_time", "u_resolution"])

const UNIFORM_NAME = /^u_[a-z][a-zA-Z0-9_]{0,30}$/

/**
 * Validates the model's uniform manifest. A refusal names the entry, because
 * the message goes back to the model verbatim as the thing to fix.
 */
export function validateUniformManifest(raw: unknown): { ok: true; uniforms: ShaderUniform[] } | { ok: false; reason: string } {
	if (!Array.isArray(raw)) return { ok: false, reason: "the manifest is not a JSON array" }
	// Eight, not six: a lit surface legitimately wants three colours (shadow,
	// body, highlight) plus speed, form scale, relief and grain. Six forbade the
	// sculptural look outright, which the reference renders found immediately.
	if (raw.length > 8) return { ok: false, reason: `${raw.length} uniforms — eight is the most a person will sit and tune` }

	const uniforms: ShaderUniform[] = []
	const seen = new Set<string>()
	for (const entry of raw) {
		const u = entry as Partial<ShaderUniform>
		if (typeof u?.name !== "string" || !UNIFORM_NAME.test(u.name)) {
			return { ok: false, reason: `uniform name "${String(u?.name)}" — names are u_ + lowercase, like u_speed` }
		}
		if (RESERVED_UNIFORMS.has(u.name))
			return { ok: false, reason: `"${u.name}" is provided by the scaffold — do not redeclare it` }
		if (seen.has(u.name)) return { ok: false, reason: `"${u.name}" is declared twice` }
		seen.add(u.name)
		if (u.type !== "float" && u.type !== "color")
			return { ok: false, reason: `"${u.name}" has type "${String(u.type)}" — only "float" and "color" exist` }
		if (typeof u.label !== "string" || !u.label) return { ok: false, reason: `"${u.name}" has no label` }

		if (u.type === "float") {
			if (typeof u.default !== "number" || !Number.isFinite(u.default)) {
				return { ok: false, reason: `"${u.name}" needs a finite numeric default` }
			}
			for (const bound of ["min", "max"] as const) {
				if (u[bound] !== undefined && (typeof u[bound] !== "number" || !Number.isFinite(u[bound]))) {
					return { ok: false, reason: `"${u.name}" has a non-finite ${bound}` }
				}
			}
			if (u.min !== undefined && u.max !== undefined && u.min >= u.max) {
				return { ok: false, reason: `"${u.name}" has min >= max` }
			}
		} else if (typeof u.default !== "string" || !/^#[0-9a-fA-F]{6}$/.test(u.default)) {
			return { ok: false, reason: `"${u.name}" is a color and needs a "#rrggbb" default` }
		}

		uniforms.push({
			name: u.name,
			type: u.type,
			label: u.label,
			default: u.default,
			...(u.min !== undefined ? { min: u.min } : {}),
			...(u.max !== undefined ? { max: u.max } : {}),
		})
	}
	return { ok: true, uniforms }
}

/**
 * Validates a fragment body before it is embedded or compiled.
 *
 * The scaffold-owned constructs are rejected outright — a body that declares
 * its own uniforms or main() would compile against a different contract than
 * the instance file records. Backticks and `${` are rejected because the body
 * is embedded in a template literal in the generated instance file, and a
 * body that could escape it is a body that could write TypeScript.
 */
export function validateFragmentBody(body: string): { ok: true } | { ok: false; reason: string } {
	if (!body.trim()) return { ok: false, reason: "the fragment body is empty" }
	if (!/vec4\s+caretMain\s*\(\s*vec2\s+\w+\s*\)/.test(body)) {
		return { ok: false, reason: "the body must define vec4 caretMain(vec2 uv)" }
	}
	const forbidden: Array<[RegExp, string]> = [
		[/#\s*version/, "#version — the scaffold owns it"],
		[/precision\s+(lowp|mediump|highp)/, "a precision statement — the scaffold owns it"],
		[/^\s*uniform\s/m, "a uniform declaration — declare uniforms in the manifest instead"],
		[/void\s+main\s*\(/, "main() — the scaffold calls caretMain for you"],
		[/texture\s*\(/, "a texture read — no textures exist in this contract"],
		[/[`]/, "a backtick"],
		[/\$\{/, "a ${ sequence"],
	]
	for (const [pattern, what] of forbidden) {
		if (pattern.test(body)) return { ok: false, reason: `the body contains ${what}` }
	}
	return { ok: true }
}

/** `uniform float u_speed;` lines from prop values, sorted for determinism. */
export function uniformDeclarations(uniforms: Record<string, ShaderUniformValue>): string {
	return Object.keys(uniforms)
		.sort()
		.filter((name) => UNIFORM_NAME.test(name) && !RESERVED_UNIFORMS.has(name))
		.map((name) => `uniform ${typeof uniforms[name] === "number" ? "float" : "vec3"} ${name};`)
		.join("\n")
}

/**
 * The complete fragment shader the runner compiles: scaffold, declared
 * uniforms, helpers, then the authored body.
 */
export function assembleFragmentSource(body: string, uniforms: Record<string, ShaderUniformValue>): string {
	return [
		"#version 300 es",
		"precision highp float;",
		"uniform float u_time;",
		"uniform vec2 u_resolution;",
		uniformDeclarations(uniforms),
		SHADER_HELPERS,
		body,
		"out vec4 caretFragColor;",
		"void main() { caretFragColor = caretMain(gl_FragCoord.xy / u_resolution); }",
	]
		.filter(Boolean)
		.join("\n\n")
}
