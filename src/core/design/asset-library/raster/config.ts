/**
 * Where the raster lane's credentials come from.
 *
 * §11's monetization boundary, made concrete: **the local editor is free
 * forever and the API key is the user's own.** Three of the four lanes need no
 * account at all, so the phase is usable before one exists, and this file's job
 * is to answer "can the raster lane run" without ever being the thing that
 * makes the rest of the surface unavailable.
 *
 * Two sources, in priority order:
 *
 * - **An API key**, supplied by the caller — from the OS keychain in the app.
 *   The only user-facing field there will ever be.
 * - **Vertex with ADC**, from the environment. Test-only by design: it exists so
 *   the lane can be exercised against Vertex credits and certified against a
 *   real model, and it is deliberately absent from the UI.
 *
 * **The key is never written into `.caret/`.** That directory is committed and
 * shared; a credential in it is a credential in somebody's public repository.
 * Nothing here reads or writes a project path, which is the structural version
 * of that promise rather than a rule someone has to remember.
 */
import type { GeminiConfig } from "./gemini"

export interface RasterSources {
	/** From the OS keychain. Absent is the normal state, not an error. */
	apiKey?: string
	/** Usually `process.env`; injectable so this stays testable. */
	env?: Record<string, string | undefined>
	/**
	 * Vertex project from prefs, for the test-only backend.
	 *
	 * Read ahead of the environment because a desktop app launched from Finder
	 * has no shell environment to read: env alone made this switch reachable
	 * only from a harness that spawns the process itself.
	 */
	vertexProject?: string
	vertexLocation?: string
}

/**
 * The configuration the raster lane would use, or null if it cannot run.
 *
 * Null rather than a throw: "no key configured" is the *expected* state for
 * most users, and a lane that is unavailable is a normal thing for the picker
 * to report, not an error condition to handle.
 */
export function resolveRasterConfig(sources: RasterSources = {}): GeminiConfig | null {
	const env = sources.env ?? process.env

	const apiKey = sources.apiKey?.trim() || env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim()
	if (apiKey) return { backend: "api-key", apiKey, model: "flash-image" }

	// Prefs first, then `CARET_VERTEX_PROJECT`, so this can be pointed somewhere
	// without disturbing whatever `gcloud` is set to for everything else on the
	// machine.
	const project = sources.vertexProject?.trim() || env.CARET_VERTEX_PROJECT?.trim() || env.GOOGLE_CLOUD_PROJECT?.trim()
	if (project) {
		return {
			backend: "vertex",
			project,
			// `global` rides Dynamic Shared Quota, which is what throttles under
			// load; CARET_VERTEX_LOCATION=us-central1 pins a regional endpoint
			// with its own quota, without touching the machine's gcloud config.
			location:
				sources.vertexLocation?.trim() ||
				env.CARET_VERTEX_LOCATION?.trim() ||
				env.GOOGLE_CLOUD_LOCATION?.trim() ||
				"global",
			model: "flash-image",
		}
	}

	return null
}

/**
 * One line on why the raster lane is unavailable, for the picker to show.
 *
 * It has to say that the rest of the surface still works. "Generation needs a
 * key" reads as *the feature* being locked, when in fact only photographs are —
 * and the free lanes are the ones most projects need most often.
 */
export const NO_RASTER_REASON =
	"Photographs need a Google Gemini API key, which you supply and pay for directly. " +
	"Everything else here — washes, textures, patterns, shapes and dividers — is generated on your machine and needs no account."
