/**
 * Fetching, holding and running the cutout model.
 *
 * Lives in the main process because it owns a 214MB file in `userData` and a
 * native runtime, neither of which belongs anywhere near a project directory —
 * the model is a property of the machine, not of the work, and a copy inside
 * `.caret/` would travel with somebody's repository.
 *
 * The download starts once per machine, in the background, the first time any
 * project opens. See `matte-model.ts` for why it is neither bundled nor
 * deferred to first use.
 */

import { app } from "electron"
import * as fs from "fs/promises"
import * as path from "path"

import {
	looksComplete,
	MATTE_MODEL,
	MATTE_MODEL_MB,
	type ModelState,
	progressOf,
} from "../../src/core/design/asset-library/raster/matte-model"
import { fetch } from "../../src/shared/net"
import { Logger } from "../../src/shared/services/Logger"
import { getPrefs } from "./prefs"

let inFlight: Promise<ModelState> | null = null
let state: ModelState = { status: "absent" }
const listeners = new Set<(state: ModelState) => void>()

function modelDirectory(): string {
	return path.join(app.getPath("userData"), "models")
}

export function modelPath(): string {
	return path.join(modelDirectory(), MATTE_MODEL.name)
}

export function matteState(): ModelState {
	return state
}

/** Progress for whoever is watching — the generator surface, mainly. */
export function onMatteState(listener: (state: ModelState) => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

function publish(next: ModelState): void {
	state = next
	for (const listener of listeners) listener(next)
}

/**
 * Ensures the model is on disk, downloading it if it is not.
 *
 * Idempotent and single-flight: several project windows open at once on a cold
 * machine, and without this each would start its own 214MB download into the
 * same path.
 */
export function ensureMatteModel(): Promise<ModelState> {
	if (state.status === "ready") return Promise.resolve(state)
	if (inFlight) return inFlight
	inFlight = download().finally(() => {
		inFlight = null
	})
	return inFlight
}

async function download(): Promise<ModelState> {
	const target = modelPath()

	const existing = await fs.stat(target).catch(() => null)
	if (looksComplete(existing)) {
		publish({ status: "ready", path: target })
		return state
	}

	if (getPrefs().skipCutoutModel) {
		publish({ status: "absent" })
		return state
	}

	await fs.mkdir(modelDirectory(), { recursive: true })
	// Downloaded to a scratch name and moved into place only when whole, so a
	// quit mid-download can never leave a plausible-looking file at the real
	// path. Presence there means completeness because nothing else can create
	// it.
	const scratch = `${target}.partial`

	try {
		// Resume where a previous attempt stopped. The release serves 206s, so a
		// quit or a dropped connection partway through 224MB does not start over.
		const partial = await fs.stat(scratch).catch(() => null)
		const from = partial?.isFile() && partial.size < MATTE_MODEL.bytes ? partial.size : 0
		if (from > 0) Logger.info(`[matte] resuming the cutout model at ${progressOf(from, MATTE_MODEL.bytes).label}`)
		else Logger.info(`[matte] fetching the cutout model (${MATTE_MODEL_MB}MB)`)

		const response = await fetch(MATTE_MODEL.url, from > 0 ? { headers: { Range: `bytes=${from}-` } } : {})
		const resumed = response.status === 206
		if (!response.ok || !response.body) {
			throw new Error(`the download returned ${response.status}`)
		}

		const total = MATTE_MODEL.bytes
		const handle = await fs.open(scratch, resumed ? "a" : "w")
		let received = resumed ? from : 0
		let announced = 0
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				await handle.write(chunk)
				received += chunk.byteLength
				// Every few percent rather than every chunk: this crosses to the
				// renderer, and a progress event per 64KB is thousands of messages.
				if (received - announced > total / 50) {
					announced = received
					publish({ status: "downloading", received, total })
				}
			}
		} finally {
			await handle.close()
		}

		const written = await fs.stat(scratch)
		if (!looksComplete(written)) {
			throw new Error(`the download stopped at ${progressOf(written.size, total).label}`)
		}

		await fs.rename(scratch, target)
		Logger.info(`[matte] cutout model ready at ${target}`)
		publish({ status: "ready", path: target })
		return state
	} catch (error) {
		// The partial survives a failure on purpose — it is what the next attempt
		// resumes from, and deleting it would make the resume above pointless. It
		// is only discarded when it has grown past the real file, which means the
		// bytes are wrong rather than merely incomplete.
		const partial = await fs.stat(scratch).catch(() => null)
		if (partial && partial.size > MATTE_MODEL.bytes) {
			await fs.rm(scratch, { force: true }).catch(() => {})
		}
		const reason = error instanceof Error ? error.message : String(error)
		Logger.warn(`[matte] could not fetch the cutout model: ${reason}`)
		publish({ status: "failed", reason })
		return state
	}
}
