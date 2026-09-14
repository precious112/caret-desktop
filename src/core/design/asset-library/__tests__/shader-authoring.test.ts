/**
 * The authored-shader contract: the scaffold owns the plumbing, the model owns
 * one function, and everything the model sends is validated before it is
 * compiled, embedded, or spent money on.
 */
import { strict as assert } from "assert"

import { defaultsFromManifest, extractShaderReply } from "../shader/authoring"
import { assembleFragmentSource, uniformDeclarations, validateFragmentBody, validateUniformManifest } from "../shader/preamble"

const BODY = `vec4 caretMain(vec2 uv) {
	float n = caretFbm(uv * 3.0 + u_time * u_speed);
	return vec4(caretPalette(n, u_color1, u_color2, u_color1), 1.0);
}`

const MANIFEST = [
	{ name: "u_speed", type: "float", label: "Speed", default: 0.3, min: 0, max: 2 },
	{ name: "u_color1", type: "color", label: "Color A", default: "#2563eb" },
	{ name: "u_color2", type: "color", label: "Color B", default: "#dbeafe" },
]

const reply = (body: string, manifest: unknown) =>
	"Here you go:\n```glsl\n" + body + "\n```\n\n```json\n" + JSON.stringify(manifest) + "\n```\n"

describe("validateFragmentBody", () => {
	it("accepts a well-formed body", () => {
		assert.deepEqual(validateFragmentBody(BODY), { ok: true })
	})

	it("rejects every scaffold-owned construct", () => {
		for (const poison of [
			"#version 300 es",
			"precision highp float;",
			"uniform float u_x;",
			"void main() {}",
			"texture(t, uv)",
		]) {
			const result = validateFragmentBody(`${poison}\nvec4 caretMain(vec2 uv) { return vec4(0.0); }`)
			assert.ok(!result.ok, `a body containing "${poison}" was accepted`)
		}
	})

	it("rejects a body that could escape its template literal", () => {
		assert.ok(!validateFragmentBody("vec4 caretMain(vec2 uv) { return vec4(0.0); } // `").ok)
		assert.ok(!validateFragmentBody("vec4 caretMain(vec2 uv) { return vec4(0.0); } // ${x}").ok)
	})

	it("rejects a body with no caretMain", () => {
		assert.ok(!validateFragmentBody("float f(vec2 p) { return 0.0; }").ok)
	})
})

describe("validateUniformManifest", () => {
	it("accepts a sane manifest", () => {
		const result = validateUniformManifest(MANIFEST)
		assert.ok(result.ok)
		assert.equal(result.uniforms.length, 3)
	})

	it("allows the eight a lit surface needs, and refuses the ninth", () => {
		// Three colours plus speed/scale/relief/grain is seven — a six-knob cap
		// forbade the sculptural look outright.
		const eight = Array.from({ length: 8 }, (_, i) => ({ name: `u_k${i}`, type: "float", label: "K", default: 0 }))
		assert.ok(validateUniformManifest(eight).ok)
		assert.ok(!validateUniformManifest([...eight, { name: "u_k8", type: "float", label: "K", default: 0 }]).ok)
	})

	it("rejects names that are not u_-prefixed, reserved, or duplicated", () => {
		assert.ok(!validateUniformManifest([{ name: "speed", type: "float", label: "S", default: 0 }]).ok)
		assert.ok(!validateUniformManifest([{ name: "u_time", type: "float", label: "T", default: 0 }]).ok)
		assert.ok(!validateUniformManifest([MANIFEST[0], MANIFEST[0]]).ok)
	})

	it("rejects non-finite numbers and malformed colors", () => {
		assert.ok(!validateUniformManifest([{ name: "u_s", type: "float", label: "S", default: Number.NaN }]).ok)
		assert.ok(!validateUniformManifest([{ name: "u_s", type: "float", label: "S", default: 0, min: 1, max: 0 }]).ok)
		assert.ok(!validateUniformManifest([{ name: "u_c", type: "color", label: "C", default: "blue" }]).ok)
	})
})

describe("extractShaderReply", () => {
	it("takes a good reply apart, tolerant of surrounding prose", () => {
		const result = extractShaderReply(reply(BODY, MANIFEST))
		assert.ok(result.ok, !result.ok ? result.reason : "")
		assert.ok(result.shader.body.includes("caretMain"))
		assert.equal(result.shader.uniforms.length, 3)
	})

	it("rejects a body reading a uniform the manifest never declared", () => {
		const result = extractShaderReply(reply(BODY, MANIFEST.slice(0, 2)))
		assert.ok(!result.ok)
		assert.match(result.reason, /u_color2/)
	})

	it("rejects a reply missing either fence, with a reason worded for the model", () => {
		const noManifest = extractShaderReply("```glsl\n" + BODY + "\n```")
		assert.ok(!noManifest.ok)
		assert.match(noManifest.reason, /json manifest/)
		const noGlsl = extractShaderReply("```json\n[]\n```")
		assert.ok(!noGlsl.ok)
	})
})

describe("assembleFragmentSource", () => {
	it("declares uniforms from prop values, floats and colors alike", () => {
		const decls = uniformDeclarations({ u_speed: 0.3, u_color1: "#2563eb", u_tint: [1, 0, 0] })
		assert.match(decls, /uniform float u_speed;/)
		assert.match(decls, /uniform vec3 u_color1;/)
		assert.match(decls, /uniform vec3 u_tint;/)
	})

	it("never lets a prop shadow the scaffold's own uniforms", () => {
		const decls = uniformDeclarations({ u_time: 1, u_resolution: [1, 1, 1], u_ok: 2 })
		assert.doesNotMatch(decls, /u_time|u_resolution/)
	})

	it("assembles scaffold, helpers and body in compile order", () => {
		const manifest = validateUniformManifest(MANIFEST)
		assert.ok(manifest.ok)
		const source = assembleFragmentSource(BODY, defaultsFromManifest(manifest.uniforms))
		const order = ["#version 300 es", "uniform float u_time;", "float caretHash", "vec4 caretMain", "void main()"]
		let last = -1
		for (const marker of order) {
			const at = source.indexOf(marker)
			assert.ok(at > last, `${marker} is missing or out of order`)
			last = at
		}
	})
})
