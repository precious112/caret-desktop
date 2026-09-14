/**
 * The chrome's live shader preview — a running twin of the project runner.
 *
 * The canonical runner (`src/core/design/authoring/shader-runner.ts`) exists
 * only as a SOURCE STRING written into user projects, so the chrome cannot
 * import the component itself. This is the same machinery compiled for the
 * generate surface: identical fragment scaffold (helpers, u_time,
 * u_resolution, `caretMain(vec2 uv)`), so what the preview shows is what the
 * shipped component renders. Kept in step with SHADER_RUNNER_VERSION — a
 * behavioural change there lands here too, and the shared `SHADER_HELPERS`
 * import is what keeps the GLSL vocabulary from forking.
 */
import { useEffect, useRef } from "react"

import { SHADER_HELPERS } from "../../../../src/core/design/asset-library/shader/preamble"

export type ShaderPreviewUniforms = Record<string, number | string>

const VERTEX_SHADER =
	"#version 300 es\n" +
	"void main() {" +
	"  vec2 p = vec2[](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0))[gl_VertexID];" +
	"  gl_Position = vec4(p, 0.0, 1.0);" +
	"}"

function colorToVec3(value: string): [number, number, number] {
	const hex = /^#([0-9a-fA-F]{6})$/.exec(value)?.[1]
	if (!hex) return [0, 0, 0]
	return [
		Number.parseInt(hex.slice(0, 2), 16) / 255,
		Number.parseInt(hex.slice(2, 4), 16) / 255,
		Number.parseInt(hex.slice(4, 6), 16) / 255,
	]
}

function fragmentSource(fragment: string, uniforms: ShaderPreviewUniforms): string {
	const declarations = Object.keys(uniforms)
		.sort()
		.filter((name) => /^u_[a-z]/.test(name) && name !== "u_time" && name !== "u_resolution")
		.map((name) => `uniform ${typeof uniforms[name] === "number" ? "float" : "vec3"} ${name};`)
		.join("\n")
	return [
		"#version 300 es",
		"precision highp float;",
		"uniform float u_time;",
		"uniform vec2 u_resolution;",
		declarations,
		SHADER_HELPERS,
		fragment,
		"out vec4 caretFragColor;",
		"void main() { caretFragColor = caretMain(gl_FragCoord.xy / u_resolution); }",
	]
		.filter(Boolean)
		.join("\n\n")
}

export function ShaderPreview({
	fragment,
	uniforms = {},
	className,
}: {
	fragment: string
	uniforms?: ShaderPreviewUniforms
	className?: string
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null)
	// Values reach the running loop through a ref, so tuning a knob never
	// recompiles the program — that is what makes the sliders feel live.
	const uniformsRef = useRef(uniforms)
	uniformsRef.current = uniforms

	useEffect(() => {
		const canvas = canvasRef.current
		if (!canvas) return
		const gl = canvas.getContext("webgl2", { premultipliedAlpha: false })
		if (!gl) return

		let program: WebGLProgram | null = null
		let raf = 0
		let disposed = false
		const started = performance.now()

		const compile = (type: number, source: string): WebGLShader | null => {
			const shader = gl.createShader(type)
			if (!shader) return null
			gl.shaderSource(shader, source)
			gl.compileShader(shader)
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				console.error("[shader-preview] " + (gl.getShaderInfoLog(shader) || "compile failed"))
				gl.deleteShader(shader)
				return null
			}
			return shader
		}

		const setup = (): boolean => {
			const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER)
			const frag = compile(gl.FRAGMENT_SHADER, fragmentSource(fragment, uniformsRef.current))
			if (!vertex || !frag) return false
			program = gl.createProgram()
			if (!program) return false
			gl.attachShader(program, vertex)
			gl.attachShader(program, frag)
			gl.linkProgram(program)
			if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
				console.error("[shader-preview] " + (gl.getProgramInfoLog(program) || "link failed"))
				return false
			}
			gl.useProgram(program)
			return true
		}

		const draw = (timeSeconds: number) => {
			if (!program) return
			const ratio = Math.min(window.devicePixelRatio || 1, 2)
			const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
			const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width
				canvas.height = height
			}
			gl.viewport(0, 0, canvas.width, canvas.height)
			gl.uniform1f(gl.getUniformLocation(program, "u_time"), timeSeconds)
			gl.uniform2f(gl.getUniformLocation(program, "u_resolution"), canvas.width, canvas.height)
			for (const [name, value] of Object.entries(uniformsRef.current)) {
				const location = gl.getUniformLocation(program, name)
				if (!location) continue
				if (typeof value === "number") gl.uniform1f(location, value)
				else gl.uniform3fv(location, colorToVec3(value))
			}
			gl.drawArrays(gl.TRIANGLES, 0, 3)
		}

		const loop = () => {
			if (disposed) return
			draw((performance.now() - started) / 1000)
			raf = requestAnimationFrame(loop)
		}

		if (!setup()) return
		raf = requestAnimationFrame(loop)

		return () => {
			disposed = true
			cancelAnimationFrame(raf)
		}
		// Recompile only when the shader itself changes; values flow via refs.
	}, [fragment, Object.keys(uniforms).sort().join(",")])

	return (
		<div className={className} style={{ position: "relative", overflow: "hidden" }}>
			<canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
		</div>
	)
}
