/**
 * The cutout model's worker: plain CJS, run by SYSTEM NODE, written to
 * userData at boot like the MCP bridge.
 *
 * It exists because inference CANNOT run in any Electron process: ORT's
 * aligned allocations go through Electron's PartitionAlloc shim, which
 * SIGTRAPs and kills the process — first the whole app (one crash per keyed
 * variant, 2026-08-31 05:06), then the ELECTRON_RUN_AS_NODE worker, whose
 * first inference survives and whose second dies the same death (05:15,
 * 05:17 — with the arena on AND off, so it is the shim, not the arena). The
 * shim is compiled into the binary; no mode escapes it. System node runs
 * three consecutive inferences clean (measured: 21s, 14s, 13s), and system
 * node is not a new dependency — the design shell already spawns `npm
 * install` and the vite binary for every project.
 *
 * The division of labour keeps this file dependency-free except the ORT
 * runtime itself, which arrives as an absolute path in the job (resolved by
 * the main process, so cwd never matters): the worker only runs the network
 * — float32 tensor file in, float32 mask file out. Every tested piece of
 * the cutout (tensor prep, mask application, unmixing, honesty gates) stays
 * in the bundle where its unit tests live.
 *
 * Jobs arrive one JSON per stdin line; one JSON reply per stdout line,
 * matched by id. The session opens once and is reused — that is the whole
 * point of the worker being resident. When stdin closes (the app died or
 * quit), the worker SIGKILLs itself: ORT's global teardown crashes with a
 * mutex error on this platform, and a worker with no work left has nothing
 * to flush that matters.
 */
export const MATTE_WORKER_SOURCE = `"use strict"
const fs = require("fs")
const readline = require("readline")

let ort = null
let session = null
let sessionModel = ""

const rl = readline.createInterface({ input: process.stdin })
let chain = Promise.resolve()
rl.on("line", (line) => {
	chain = chain.then(() => handle(line)).catch(() => {})
})
rl.on("close", () => {
	// Skip ORT's global teardown, which aborts with "mutex lock failed" on
	// this platform. Nothing here has state worth flushing.
	process.kill(process.pid, "SIGKILL")
})

async function handle(line) {
	let job = null
	try {
		job = JSON.parse(line)
	} catch {
		return
	}
	const reply = { id: job.id, ok: false, stage: "require", reason: "" }
	try {
		if (!ort) ort = require(job.ortPath)
		reply.stage = "open"
		if (!session || sessionModel !== job.modelPath) {
			// "basic" is load-bearing: this export's broken external-tensor
			// metadata fails shape inference under "all" AND "disabled". The
			// arena stays off — the measured configuration, and a few hundred
			// MB lower resident footprint for a worker that lingers.
			session = await ort.InferenceSession.create(job.modelPath, {
				graphOptimizationLevel: "basic",
				enableCpuMemArena: false,
			})
			sessionModel = job.modelPath
		}
		reply.stage = "run"
		const raw = fs.readFileSync(job.tensorFile)
		const aligned = raw.byteOffset % 4 === 0 ? raw : Buffer.from(raw)
		const tensor = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4)
		const feeds = {}
		feeds[session.inputNames[0]] = new ort.Tensor("float32", tensor, [1, 3, job.side, job.side])
		const results = await session.run(feeds)
		const mask = results[session.outputNames[0]].data
		fs.writeFileSync(job.maskFile, Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength))
		reply.ok = true
		reply.length = mask.length
	} catch (error) {
		reply.reason = error && error.message ? error.message : String(error)
	}
	process.stdout.write(JSON.stringify(reply) + "\\n")
}
`
