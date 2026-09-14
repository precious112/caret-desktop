/**
 * The CaretShader runner template is a STRING of TSX — nothing compiles it in
 * this repo's own build, and a syntax slip would only surface as a Vite
 * overlay in the first project that accepts a shader. Transpiling it here
 * keeps that failure in the suite instead. (Full type-checking happens in real
 * projects; syntax is the class of rot a string template actually suffers.)
 */
import { strict as assert } from "assert"

import * as ts from "typescript"

import { runnerVersionOf, SHADER_RUNNER_SOURCE, SHADER_RUNNER_VERSION } from "../authoring/shader-runner"

describe("shader runner template", () => {
	it("is syntactically valid TSX", () => {
		const result = ts.transpileModule(SHADER_RUNNER_SOURCE, {
			compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
			reportDiagnostics: true,
		})
		const errors = (result.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
		assert.deepEqual(errors, [], `the runner template does not parse:\n${errors.join("\n")}`)
		assert.ok(result.outputText.length > 0)
	})

	it("carries the version header the healer compares against", () => {
		assert.equal(runnerVersionOf(SHADER_RUNNER_SOURCE), SHADER_RUNNER_VERSION)
	})

	it("reads as a user file when the header is absent — their edits must win", () => {
		assert.equal(runnerVersionOf("import { useEffect } from 'react'\n"), null)
	})
})
