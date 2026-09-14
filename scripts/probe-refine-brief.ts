/**
 * Does the rebuild stage produce a usable brief from a real model?
 *
 * Runs `refineBrief` for the amateur inputs each lane exists to lift — the
 * exact kind of request the Ember dogfood showed generating badly — on the
 * free model, so the schema plumbing and the playbook prompts are verified
 * against a live server at zero cost.
 *
 *   npx tsx scripts/probe-refine-brief.ts
 */
import * as os from "os"

import { refineBrief } from "../src/core/design"
import { stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { getBackend } from "../src/core/design/agent/registry"

const MODEL = "opencode/mimo-v2.5-free"

const CASES: import("../src/core/design").AssetRequest[] = [
	{ kind: "mark", text: "a logo of an ember", answers: { q1: "for a coffee roastery called Ember" } },
	{ kind: "image", text: "a cozy photo of coffee", answers: { q1: "beans spilling from a bag" } },
	{ kind: "object3d", text: "a cool desk lamp" },
]

async function main(): Promise<void> {
	const backend = getBackend("opencode")
	try {
		for (const request of CASES) {
			const started = Date.now()
			const result = await refineBrief({
				backend,
				workingDirectory: os.tmpdir(),
				request,
				tokens: null,
				model: MODEL,
			})
			const took = ((Date.now() - started) / 1000).toFixed(1)
			console.log(`\n=== ${request.kind} (“${request.text}”) — ${took}s`)
			console.log(result ? result.prompt : "(null — the step skipped itself)")
		}
	} finally {
		// A leaked agent loop polls the provider forever. Always.
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
