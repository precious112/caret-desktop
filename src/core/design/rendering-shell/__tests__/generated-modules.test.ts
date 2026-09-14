import { transformSync } from "esbuild"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import "should"

import { generateCanvasFiles } from "../canvas-template"

/**
 * The canvas ships as GENERATED source inside template literals, which `tsc`
 * never looks at: a raw backtick in a comment, or a duplicated `const`, is a
 * syntax error nobody sees until a browser fails to load the module — and it
 * surfaces as a dozen unrelated scenario failures eleven minutes into a suite.
 * Both of those have now happened. This parses every generated module in about
 * a second.
 */
describe("generated canvas modules parse", () => {
	it("every emitted file is syntactically valid", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "generated-modules-"))
		try {
			await generateCanvasFiles(dir)

			const walk = async (from: string): Promise<string[]> => {
				const out: string[] = []
				for (const entry of await fs.readdir(from, { withFileTypes: true })) {
					const full = path.join(from, entry.name)
					if (entry.isDirectory()) out.push(...(await walk(full)))
					else if (/\.tsx?$/.test(entry.name)) out.push(full)
				}
				return out
			}

			const files = await walk(dir)
			files.length.should.be.greaterThan(5)
			// The shader runner must be part of the boot set: .caret/lib is cleared
			// at every project open, so anything written there only at accept time
			// dies on the next launch — measured live, first shader accept ever.
			files.some((file) => file.endsWith("CaretShader.tsx")).should.equal(true)
			const failures: string[] = []
			for (const file of files) {
				try {
					transformSync(await fs.readFile(file, "utf-8"), { loader: file.endsWith(".tsx") ? "tsx" : "ts" })
				} catch (err) {
					failures.push(`${path.relative(dir, file)}: ${err instanceof Error ? err.message.split("\n")[0] : err}`)
				}
			}
			failures.should.eql([])
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
