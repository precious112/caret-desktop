/**
 * Which credentials the raster lane picks up, and from where.
 *
 * The Vertex switch is test-only by design, but "test-only" was implemented as
 * "environment-only" — and a macOS app launched from Finder or the dock
 * inherits no shell environment at all. That made the switch reachable by the
 * certification harness, which spawns Electron itself with the variables set,
 * and by nothing else. Someone running the real app had no way to turn it on,
 * so the lane refused for lack of an API key they had deliberately not supplied.
 */
import { strict as assert } from "assert"

import { resolveRasterConfig } from "../raster/config"
import { GeminiImages } from "../raster/gemini"

describe("resolveRasterConfig", () => {
	it("has nothing to run on when neither a key nor a project is configured", () => {
		assert.equal(resolveRasterConfig({ env: {} }), null)
	})

	it("prefers a supplied API key over everything else", () => {
		const config = resolveRasterConfig({
			apiKey: "from-the-keychain",
			vertexProject: "a-project",
			env: { GEMINI_API_KEY: "from-the-environment" },
		})
		assert.equal(config?.backend, "api-key")
		assert.equal((config as { apiKey: string }).apiKey, "from-the-keychain")
	})

	it("reaches Vertex from prefs, with no environment at all", () => {
		// The case that was impossible before: a normally-launched desktop app.
		const config = resolveRasterConfig({ vertexProject: "arcane-argon", env: {} })
		assert.equal(config?.backend, "vertex")
		assert.equal((config as { project: string }).project, "arcane-argon")
		assert.equal((config as { location: string }).location, "global")
	})

	it("lets prefs point somewhere without disturbing the machine's gcloud", () => {
		const config = resolveRasterConfig({
			vertexProject: "from-prefs",
			vertexLocation: "europe-west4",
			env: { GOOGLE_CLOUD_PROJECT: "whatever-gcloud-is-set-to" },
		})
		assert.equal((config as { project: string }).project, "from-prefs")
		assert.equal((config as { location: string }).location, "europe-west4")
	})

	it("still honours the environment, so the harness keeps working", () => {
		const config = resolveRasterConfig({ env: { CARET_VERTEX_PROJECT: "from-the-harness" } })
		assert.equal(config?.backend, "vertex")
		assert.equal((config as { project: string }).project, "from-the-harness")
	})

	it("treats blank prefs as absent rather than as a project named nothing", () => {
		assert.equal(resolveRasterConfig({ vertexProject: "   ", env: {} }), null)
	})
})

describe("the image model in use", () => {
	// The default was gemini-2.5-flash-image for months, and it is where the
	// field's refinement failures came from — asked to make a surface matte and
	// crisp, it added a leather seam. This pins the newer default and the
	// endpoint rule the newer models need.
	it("defaults to nano banana 2, not the legacy model", () => {
		const client = new GeminiImages({ backend: "api-key", apiKey: "k" })
		const { model } = client.resolve({ prompt: "a cube", avoid: [], aspect: "1:1" })
		assert.equal(model, "gemini-3.1-flash-image")
	})

	it("routes the Gemini 3 image models to global even when a region is configured", () => {
		// Measured: us-central1 404s these with "Publisher model not found",
		// which reads exactly like the model does not exist.
		const client = new GeminiImages({ backend: "vertex", project: "p", location: "us-central1" })
		const { url } = client.resolve({ prompt: "a cube", avoid: [], aspect: "1:1" })
		assert.ok(url.includes("/locations/global/"), `expected the global endpoint, got ${url}`)
		assert.ok(!url.includes("us-central1-aiplatform"), "a regional host cannot serve this model")
	})

	it("still honours the configured region for the legacy model", () => {
		const client = new GeminiImages({
			backend: "vertex",
			project: "p",
			location: "us-central1",
			model: "flash-image-legacy",
		})
		const { url } = client.resolve({ prompt: "a cube", avoid: [], aspect: "1:1" })
		assert.ok(url.includes("us-central1-aiplatform"), `expected the regional host, got ${url}`)
	})
})
