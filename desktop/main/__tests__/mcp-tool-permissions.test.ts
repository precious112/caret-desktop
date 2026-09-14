/**
 * Every bridge tool is either gated as a write or deliberately not.
 *
 * The chat agent reaches Caret's tools over MCP, and the backend's permission
 * config gates them **by name** — `caret_write_page: "ask"` — built from
 * `MUTATING_TOOL_NAMES`. A new tool that writes anything and is missing from
 * that list runs without ever raising a permission, which is exactly the hole
 * `verify:app`'s `ee` caught: the file changed and the chat carried no record.
 *
 * So the partition is held down here. Adding a tool makes this test fail until
 * the author says which side it belongs on — a decision, not an accident.
 */
import { strict as assert } from "assert"

import { MUTATING_TOOL_NAMES, TOOLS } from "../mcp/tools"

/**
 * Tools that only read, or that block on the user rather than writing.
 *
 * A permission row per `get_page` would bury the rows that matter, so reads are
 * exempt on purpose. The interview tools (`interview-tools.ts`) are listed as
 * literals because importing their builder drags in Electron-bound modules the
 * test runner does not have.
 */
const READ_ONLY_OR_INTERACTIVE = new Set([
	"get_project",
	"get_page",
	"get_tokens",
	"get_flows",
	"get_screenshot",
	"list_assets",
	"get_asset",
	"get_sync_worklist",
	"get_guide",
	"get_params",
	"get_drift",
	// Runs analysis and stores derived scratch, but authors nothing a user
	// would call a change; its findings surface on the canvas either way.
	"run_design_checks",
	// interview-tools.ts: these block on a person, they do not write.
	"present_question",
	"present_options",
	"present_asset_options",
])

/** interview-tools.ts tools that DO write, named in MUTATING_TOOL_NAMES. */
const INTERVIEW_MUTATORS = ["commit_foundation", "generate_asset"]

describe("the bridge tools' permission partition", () => {
	const mutating = new Set<string>(MUTATING_TOOL_NAMES)

	it("classifies every registered tool exactly once", () => {
		for (const tool of TOOLS) {
			const gated = mutating.has(tool.name)
			const exempt = READ_ONLY_OR_INTERACTIVE.has(tool.name)
			assert.ok(
				gated || exempt,
				`"${tool.name}" is neither gated as a write nor exempted as a read — decide which, in mcp/tools.ts`,
			)
			assert.ok(!(gated && exempt), `"${tool.name}" is on both sides of the partition`)
		}
	})

	it("gates nothing that does not exist", () => {
		const known = new Set([...TOOLS.map((tool) => tool.name), ...INTERVIEW_MUTATORS])
		for (const name of MUTATING_TOOL_NAMES) {
			// A misspelled gate matches no tool and protects nothing — the same
			// silent-glob failure mode the healer's watcher shipped with.
			assert.ok(known.has(name), `"${name}" is gated but no bridge tool has that name`)
		}
	})
})
