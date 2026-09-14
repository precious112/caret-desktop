/**
 * Does a thinking model's reasoning reach the chat WHILE it thinks?
 *
 * A 5½-minute reasoning turn showed "Working…" the whole way: the server sends
 * `message.part.updated` only at a part's creation (empty) and completion (the
 * whole text) — every token in between is a `message.part.delta` append, which
 * the mapper used to drop. A cancelled turn never even gets the completing
 * `updated`, so the trace only appeared after a reload rehydrated it.
 *
 * This drives one real turn through the actual adapter (`startSession` →
 * `send`) on a reasoning model and reports how the thinking arrived: PASS needs
 * several separate `thinking` events spread over the stream, not one lump at
 * the end.
 *
 *   npx tsx scripts/probe-part-delta.ts
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { stopOpencodeServer } from "../src/core/design/agent/opencode/server"
import { getBackend } from "../src/core/design/agent/registry"

// The model from the incident itself: it thought for 5½ minutes on a real
// prompt while the chat said "Working…". Free lane, so the probe costs nothing.
const MODEL = "opencode-go/ox-alpha-free"
const started = Date.now()
const t = () => `+${((Date.now() - started) / 1000).toFixed(2)}s`

async function main(): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "caret-probe-delta-"))
	const backend = getBackend("opencode")
	const session = await backend.startSession({
		workingDirectory: dir,
		mode: "read-only",
		model: MODEL,
		title: "probe: part deltas",
	})

	const arrivals: { kind: string; at: number; chars: number }[] = []
	for await (const event of session.send({
		text: "Plan a five-page personal recipe-journal app: think through the page list, what each page shows, and its empty state, weighing at least two layout options per page — then give me only the final page list, one line per page.",
	})) {
		if (event.type === "thinking" || event.type === "text") {
			arrivals.push({ kind: event.type, at: Date.now() - started, chars: event.text.length })
			continue
		}
		if (event.type === "done") break
	}
	await session.close()

	const thinking = arrivals.filter((a) => a.kind === "thinking")
	const text = arrivals.filter((a) => a.kind === "text")
	const spreadMs = thinking.length > 1 ? thinking[thinking.length - 1].at - thinking[0].at : 0
	console.log(
		`${t()} thinking events: ${thinking.length} (${thinking.reduce((n, a) => n + a.chars, 0)} chars over ${(spreadMs / 1000).toFixed(2)}s)`,
	)
	console.log(`${t()} text events: ${text.length} (${text.reduce((n, a) => n + a.chars, 0)} chars)`)

	const streamed = thinking.length >= 3 && spreadMs > 0
	console.log(streamed ? "PASS — reasoning streamed live, not as one completing lump" : "FAIL — reasoning did not stream")
	if (!streamed) process.exitCode = 1
}

main().finally(async () => {
	await stopOpencodeServer()
})
