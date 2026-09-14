/**
 * The shader authoring loop's pure half: what the model is asked, how its
 * reply is taken apart, and the page a hidden window uses to compile and
 * render what it wrote. Everything here runs under plain node and is
 * testable; the Electron halves (desktop main's BrowserWindow, the gallery
 * probe's spawned child) stay thin.
 *
 * The loop itself is authored-marks with one improvement the SVG lane never
 * had: a shader's failure mode is a COMPILE ERROR, and `getShaderInfoLog` is
 * precise, line-numbered, machine-checked feedback — fed back verbatim, it
 * corrects the model far faster than a picture ever could. The picture rounds
 * then spend their budget on taste, not syntax.
 */
import {
	assembleFragmentSource,
	SHADER_CONTRACT_DOC,
	type ShaderUniform,
	type ShaderUniformValue,
	validateFragmentBody,
	validateUniformManifest,
} from "./preamble"

/** Takes offered per brief, matching the generate-and-pick convention. */
export const SHADER_TAKES = 3
/** Compile-error rounds per take before the take is dropped. */
export const SHADER_COMPILE_RETRIES = 2
/** Frames shown to the model for the taste round. Seconds of u_time. */
export const SHADER_CRITIQUE_TIMES = [0.5, 2.0, 4.0]

export const SHADER_SYSTEM_PROMPT = `You are writing an animated background shader for a real product's UI — a hero section, a section divider, a card surface — inside a design tool.

${SHADER_CONTRACT_DOC}

Reply format, not negotiable — exactly two fenced blocks and nothing else:

\`\`\`glsl
vec4 caretMain(vec2 uv) {
  ...
}
\`\`\`

\`\`\`json
[{ "name": "u_speed", "type": "float", "label": "Speed", "default": 0.4, "min": 0, "max": 2 }]
\`\`\`

The JSON block is your uniform manifest — the knobs a person will tune. Eight at most; every value worth tuning (speed, form scale, relief, grain, and each colour) should be a uniform with a sensible default, min and max, not a constant buried in the code.

Taste rules:
- **The brief wins on hue.** "Embers" glow warm, "evening light" is golden, "aurora" shimmers green-violet — even when the project's palette is blue. The palette you are given is the project's harmony reference and the fallback when the brief implies no hue; every color is a tunable knob, so the person can pull it toward brand later. Declare the hues the BRIEF calls for as your color-uniform defaults.
- **Read the brief's register, and commit to it.** A brief that asks for a statement — bold, vivid, dramatic, sculptural, expensive — wants saturated colour, big confident forms, and a value range that runs from near-black shadow to a bright caught highlight. A brief that asks to sit behind text wants calmer regions where words can land. Both fail the same way: a pale, low-contrast, near-invisible wash. Timid is the one mistake with no excuse.
- **Form, not texture.** Two or three large shapes reading as a lit surface beat a whole frame of busy noise. Reach for the sculpted-surface helpers before you reach for raw fbm.
- Slow. It breathes; it does not play. No strobing, no hard edge sweeping across the frame.
- Banding is the tell of a lazy gradient — a whisper of caretGrain hides it.

You will be shown pictures of what you wrote, rendered at several timestamps, and asked to correct it. Compile errors come back to you verbatim; fix exactly what the log names.`

export function shaderOpeningPrompt(brief: string, paletteWords: string, colors: string[]): string {
	return [
		`Write a shader for: ${brief.trim()}`,
		"",
		`The project's palette, for harmony reference and as the fallback when the brief implies no hue of its own: ${colors.join(", ")}.`,
		paletteWords,
		`If the brief names or implies its own colors — heat, metal, sky, a time of day — serve the brief and declare those hues as your color-uniform defaults; the knobs keep them adjustable toward the palette later.`,
		"",
		"Send the two fenced blocks only.",
	].join("\n")
}

export function shaderCompileFixPrompt(infoLog: string): string {
	return [
		"Your fragment did not compile. The GLSL compiler said, verbatim:",
		"",
		infoLog.trim() || "(the driver returned an empty log — most often an undeclared identifier or a type mismatch)",
		"",
		"Line numbers count from the top of the assembled shader, which places your caretMain after the scaffold and helpers. Fix exactly what the log names and resend both fenced blocks.",
	].join("\n")
}

export function shaderRejectionPrompt(reason: string): string {
	return [`Your reply was rejected before compiling: ${reason}.`, "", "Resend both fenced blocks, corrected."].join("\n")
}

/**
 * The automatic timidity gate. A shader can compile perfectly and still be the
 * one failure the taste rules forbid — a near-invisible wash — and that is
 * measurable: the luminance spread of a rendered frame. Below this, the model
 * is told so and asked again before a person ever sees it. Auto-correct, not
 * detect: the finding goes back into the loop, not into a warning.
 */
export const SHADER_MIN_LUMINANCE_SPREAD = 40

export function shaderFlatPrompt(range: { min: number; max: number }): string {
	return [
		`Your shader compiled, but the rendered frame is nearly flat: its luminance runs only from ${range.min} to ${range.max} of 255.`,
		"That is the near-invisible-wash failure the rules name as the one with no excuse. Compose a real value range — a genuinely dark region and a genuinely bright one in the same frame. The sculpted-surface helpers with a grazing light are the reliable way there.",
		"Resend both fenced blocks, corrected.",
	].join("\n")
}

export function shaderCritiquePrompt(brief: string): string {
	return [
		`These are frames of your shader at u_time = ${SHADER_CRITIQUE_TIMES.join("s, ")}s.`,
		"",
		"Look at them and answer honestly: what is wrong?",
		"- Is anything actually HAPPENING? A near-blank wash or a flat single colour is the most common failure — would someone screenshot this and call it designed, or does it look like an empty page?",
		`- Are the hues the brief's hues (${brief.trim()}), or did they collapse toward a timid monochrome?`,
		"- Is there real form — shapes you could point at, light falling across them — or is it an even fog? Does the frame run from a genuinely dark shadow to a genuinely bright highlight?",
		"- Is the motion a slow breathing drift between frames, or is it jumping?",
		"- Is there banding a touch of caretGrain would hide?",
		"",
		"Then resend both fenced blocks, corrected. If nothing needs correcting, resend them unchanged.",
	].join("\n")
}

export interface ExtractedShader {
	body: string
	uniforms: ShaderUniform[]
}

/**
 * Takes a reply apart and validates both halves. Tolerant of prose around the
 * fences (refusing a good shader over "Here you go:" is pedantry), strict
 * about what it extracts — the failure reason is worded for the model, since
 * it goes straight back as the thing to fix.
 */
export function extractShaderReply(reply: string): { ok: true; shader: ExtractedShader } | { ok: false; reason: string } {
	const glsl = /```(?:glsl|c)?\s*\n([\s\S]*?)```/.exec(reply)
	const body = glsl?.[1]?.trim() ?? ""
	if (!body || !body.includes("caretMain")) return { ok: false, reason: "no ```glsl block with caretMain in it" }

	const bodyCheck = validateFragmentBody(body)
	if (!bodyCheck.ok) return { ok: false, reason: bodyCheck.reason }

	const json = /```json\s*\n([\s\S]*?)```/.exec(reply)
	if (!json) return { ok: false, reason: "no ```json manifest block" }
	let parsed: unknown
	try {
		parsed = JSON.parse(json[1])
	} catch {
		return { ok: false, reason: "the manifest block is not valid JSON" }
	}
	const manifest = validateUniformManifest(parsed)
	if (!manifest.ok) return { ok: false, reason: manifest.reason }

	// Every uniform the body reads must be declared, or the compile fails with
	// an error the model finds harder to read than this sentence.
	for (const match of body.matchAll(/\bu_[a-z][a-zA-Z0-9_]*/g)) {
		const name = match[0]
		if (name === "u_time" || name === "u_resolution") continue
		if (!manifest.uniforms.some((u) => u.name === name)) {
			return { ok: false, reason: `the body reads ${name} but the manifest does not declare it` }
		}
	}

	return { ok: true, shader: { body, uniforms: manifest.uniforms } }
}

/** Prop values from manifest defaults — what the instance file will carry. */
export function defaultsFromManifest(uniforms: ShaderUniform[]): Record<string, ShaderUniformValue> {
	const values: Record<string, ShaderUniformValue> = {}
	for (const uniform of uniforms) values[uniform.name] = uniform.default
	return values
}

/**
 * The page a hidden window loads to compile and render an authored shader.
 *
 * Deterministic by construction: `__caretDrawAt(t)` sets u_time explicitly, so
 * "the frame at 2.0s" is the same pixels on every machine and every run —
 * wall-clock never touches the loop. The window's own JS runs (a shader IS a
 * program), but the page is built by Caret, the GLSL is compiled by the GL
 * driver rather than evaluated, and the body was validated before it got here.
 */
export function buildShaderRenderHtml(body: string, uniforms: ShaderUniform[], size: { width: number; height: number }): string {
	const values = defaultsFromManifest(uniforms)
	const source = assembleFragmentSource(body, values)
	const vertex =
		"#version 300 es\nvoid main(){vec2 p=vec2[](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.))[gl_VertexID];gl_Position=vec4(p,0.,1.);}"

	return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:${size.width}px;height:${size.height}px;overflow:hidden}canvas{display:block}</style>
<canvas id="c" width="${size.width}" height="${size.height}"></canvas>
<script>
const RESULT = { ready: false, error: null }
window.__caretShader = RESULT
const gl = document.getElementById("c").getContext("webgl2", { preserveDrawingBuffer: true })
if (!gl) {
	RESULT.error = "webgl2 unavailable"
} else {
	const compile = (type, src) => {
		const s = gl.createShader(type)
		gl.shaderSource(s, src)
		gl.compileShader(s)
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(s) || "compile failed with an empty log"
			gl.deleteShader(s)
			throw new Error(log)
		}
		return s
	}
	try {
		const program = gl.createProgram()
		gl.attachShader(program, compile(gl.VERTEX_SHADER, ${JSON.stringify(vertex)}))
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, ${JSON.stringify(source)}))
		gl.linkProgram(program)
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "link failed")
		gl.useProgram(program)
		const values = ${JSON.stringify(values)}
		for (const [name, value] of Object.entries(values)) {
			const location = gl.getUniformLocation(program, name)
			if (!location) continue
			if (typeof value === "number") gl.uniform1f(location, value)
			else if (typeof value === "string") {
				const hex = value.slice(1)
				gl.uniform3f(location, parseInt(hex.slice(0,2),16)/255, parseInt(hex.slice(2,4),16)/255, parseInt(hex.slice(4,6),16)/255)
			} else gl.uniform3fv(location, value)
		}
		const uTime = gl.getUniformLocation(program, "u_time")
		gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), ${size.width}, ${size.height})
		window.__caretDrawAt = (t) => {
			gl.uniform1f(uTime, t)
			gl.viewport(0, 0, ${size.width}, ${size.height})
			gl.drawArrays(gl.TRIANGLES, 0, 3)
			return true
		}
		RESULT.ready = true
	} catch (err) {
		RESULT.error = String((err && err.message) || err)
	}
}
</script>`
}
