/**
 * The pinned-version constant documents the protocol contract; the package.json
 * dependency is what before-pack.cjs actually stages into every build. They
 * drifted once (constant at 1.18.11 while builds shipped 1.18.23), which left
 * every comment reasoning from the constant describing a server twelve patches
 * older than the one running.
 */
import { strict as assert } from "assert"
import * as fs from "fs"
import * as path from "path"

import { PINNED_OPENCODE_VERSION } from "../binary"

describe("PINNED_OPENCODE_VERSION", () => {
	it("matches the opencode-ai dependency the build stages", () => {
		const manifestPath = path.join(__dirname, "..", "..", "..", "..", "..", "..", "package.json")
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
		assert.equal(PINNED_OPENCODE_VERSION, manifest.devDependencies["opencode-ai"])
	})
})
