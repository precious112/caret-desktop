/**
 * Running the cutout model on a bitmap — in a worker, never in this process.
 *
 * The download half lives in `matte.ts`; this is the inference half. It was
 * first written in-process and crashed the whole app on the first real
 * cutout, then rewritten on ELECTRON_RUN_AS_NODE and crashed on the second:
 * ORT's aligned allocations trip Electron's PartitionAlloc shim (SIGTRAP),
 * and the shim is compiled into the binary — no mode escapes it (three crash
 * reports, arena on and off; see matte-worker-source.ts). So the network
 * runs under SYSTEM NODE, which the app already requires — the design shell
 * spawns `npm install` and the vite binary for every project. Everything
 * deterministic (tensor prep, mask application, unmixing, honesty gates)
 * stays in this bundle where its unit tests live. Pixels cross as temp
 * files, replies as one JSON line per job.
 *
 * The worker is spawned lazily and kept: the session inside it opens once
 * (~3s) and every later cutout pays only the inference. A worker that dies
 * fails its in-flight jobs honestly and is respawned by the next call.
 */
import { type ChildProcess, spawn } from "child_process"
import { randomUUID } from "crypto"
import { app } from "electron"
import * as fs from "fs/promises"
import { createRequire } from "module"
import * as os from "os"
import * as path from "path"

import type { KeyableImage, KeyOutResult } from "../../src/core/design"
import { applyMatte, MATTE_MODEL, matteInputTensor, progressOf } from "../../src/core/design"
import { systemSpawnEnv } from "../../src/core/design/spawn-env"
import { Logger } from "../../src/shared/services/Logger"
import { ensureMatteModel, matteState, modelPath } from "./matte"
import { MATTE_WORKER_SOURCE } from "./matte-worker-source"

// The main bundle is ESM ("type": "module"), where no `require` exists — this
// is how the ORT package's entry file is resolved to the absolute path the
// worker loads it by, so the worker's own cwd never matters.
const requireNative = createRequire(import.meta.url)

/** A network run should never take this long; past it the worker is presumed hung. */
const JOB_TIMEOUT_MS = 3 * 60_000

interface WorkerReply {
	id: string
	ok: boolean
	stage: "require" | "open" | "run"
	reason: string
	length?: number
}

let worker: ChildProcess | null = null
let workerStarting: Promise<ChildProcess> | null = null
const pending = new Map<string, (reply: WorkerReply) => void>()

async function startWorker(): Promise<ChildProcess> {
	const workerPath = path.join(app.getPath("userData"), "matte-worker.cjs")
	await fs.writeFile(workerPath, MATTE_WORKER_SOURCE, "utf-8")

	// System node from PATH, the same resolution `npm install` already relies
	// on. Never process.execPath: that is the Electron binary, whose allocator
	// shim SIGTRAPs on ORT's aligned allocations in every mode. The augmented
	// PATH covers Finder launches, which lack Homebrew's bin directories.
	const child = spawn("node", [workerPath], {
		stdio: ["pipe", "pipe", "pipe"],
		env: systemSpawnEnv(),
	})
	child.on("error", (error) => {
		// Node missing from PATH — the design shell could not have booted
		// either, but this failure must still name itself rather than hang.
		Logger.warn(`[matte] could not spawn system node: ${error.message}`)
		if (worker === child) worker = null
		for (const resolve of pending.values()) {
			resolve({
				id: "",
				ok: false,
				stage: "run",
				reason: `system Node could not be started (${error.message}) — the cutout model needs the same Node.js the design preview uses`,
			})
		}
		pending.clear()
	})
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString().trim()
		if (text) Logger.warn(`[matte-worker] ${text}`)
	})

	let buffered = ""
	child.stdout?.on("data", (chunk: Buffer) => {
		buffered += chunk.toString()
		let cut = buffered.indexOf("\n")
		while (cut >= 0) {
			const line = buffered.slice(0, cut)
			buffered = buffered.slice(cut + 1)
			cut = buffered.indexOf("\n")
			try {
				const reply = JSON.parse(line) as WorkerReply
				pending.get(reply.id)?.(reply)
			} catch {
				// Not a reply line; the worker has nothing else to say on stdout.
			}
		}
	})

	child.on("exit", (code, signal) => {
		// SIGKILL on our own stdin-close shutdown is the worker's normal end;
		// anything else mid-life is a real death and every waiter hears it.
		if (worker === child) worker = null
		for (const resolve of pending.values()) {
			resolve({ id: "", ok: false, stage: "run", reason: `the cutout worker died (${signal ?? code})` })
		}
		pending.clear()
	})

	return child
}

async function workerProcess(): Promise<ChildProcess> {
	if (worker && worker.exitCode === null && !worker.killed) return worker
	if (!workerStarting) {
		workerStarting = startWorker()
			.then((child) => {
				worker = child
				return child
			})
			.finally(() => {
				workerStarting = null
			})
	}
	return workerStarting
}

/** Runs the network in the worker: tensor in, mask out, files in between. */
async function runNetwork(
	tensor: Float32Array,
	side: number,
): Promise<{ ok: true; mask: Float32Array } | { ok: false; stage: string; reason: string }> {
	const child = await workerProcess()
	const id = randomUUID()
	const scratch = os.tmpdir()
	const tensorFile = path.join(scratch, `caret-matte-${id}.in`)
	const maskFile = path.join(scratch, `caret-matte-${id}.out`)

	try {
		await fs.writeFile(tensorFile, Buffer.from(tensor.buffer, tensor.byteOffset, tensor.byteLength))

		const reply = await new Promise<WorkerReply>((resolve) => {
			const timer = setTimeout(() => {
				pending.delete(id)
				// A hung worker blocks every later job behind it; kill it so the
				// next call starts fresh. The exit handler clears other waiters.
				child.kill("SIGKILL")
				resolve({
					id,
					ok: false,
					stage: "run",
					reason: `no reply after ${JOB_TIMEOUT_MS / 60_000} minutes — the worker was restarted`,
				})
			}, JOB_TIMEOUT_MS)
			pending.set(id, (value) => {
				clearTimeout(timer)
				pending.delete(id)
				resolve(value)
			})
			const job = {
				id,
				ortPath: requireNative.resolve("onnxruntime-node"),
				modelPath: modelPath(),
				tensorFile,
				maskFile,
				side,
			}
			child.stdin?.write(`${JSON.stringify(job)}\n`)
		})

		if (!reply.ok) return { ok: false, stage: reply.stage, reason: reply.reason }

		const raw = await fs.readFile(maskFile)
		const aligned = raw.byteOffset % 4 === 0 ? raw : Buffer.from(raw)
		return { ok: true, mask: new Float32Array(aligned.buffer, aligned.byteOffset, aligned.length / 4) }
	} finally {
		await fs.rm(tensorFile, { force: true }).catch(() => {})
		await fs.rm(maskFile, { force: true }).catch(() => {})
	}
}

/**
 * Cuts the subject out of a bitmap in place, or says exactly why it cannot.
 *
 * "Not ready" is a sentence with the download's own numbers in it rather than
 * a silent fall-through to a worse algorithm — a threshold cutout shipped
 * quietly is how the shadow puddles got into a user's git history last time.
 */
export async function matteCutout(image: KeyableImage): Promise<KeyOutResult> {
	if (matteState().status !== "ready") {
		// A complete file that merely has not been stat-ed yet resolves in
		// milliseconds; a genuine download should not block this cutout for
		// minutes — it refuses with its own progress numbers instead.
		await Promise.race([ensureMatteModel(), new Promise((resolve) => setTimeout(resolve, 3000))])
		const current = matteState()
		if (current.status === "downloading") {
			return {
				ok: false,
				reason: `The cutout model is still downloading — ${progressOf(current.received, current.total).label}. Try again in a moment.`,
			}
		}
		if (current.status === "failed") {
			return {
				ok: false,
				reason: `The cutout model could not be fetched (${current.reason}) — it retries on the next launch.`,
			}
		}
		if (current.status !== "ready") {
			return {
				ok: false,
				reason: "The cutout model is not on this machine yet — it downloads in the background at project open.",
			}
		}
	}

	const started = Date.now()
	const side = MATTE_MODEL.input
	const result = await runNetwork(matteInputTensor(image, side), side)
	if (!result.ok) {
		Logger.warn(`[matte] ${result.stage} failed: ${result.reason}`)
		if (result.stage === "open") {
			// The size matched and the runtime still refused it: the bytes are
			// wrong, not incomplete. Delete so the next boot re-fetches. A
			// "require" failure is the runtime missing, not the model broken —
			// deleting for that would re-download 224MB for nothing.
			await fs.rm(modelPath(), { force: true }).catch(() => {})
			return {
				ok: false,
				reason: `The cutout model on disk could not be opened (${result.reason}) — it re-downloads on the next launch.`,
			}
		}
		return { ok: false, reason: `The cutout model failed on this image: ${result.reason}` }
	}

	const applied = applyMatte(image, result.mask, side)
	Logger.info(
		`[matte] ${image.width}×${image.height} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${
			applied.ok ? `cut ${(applied.cut * 100).toFixed(1)}%` : `refused: ${applied.reason}`
		}`,
	)
	return applied
}
