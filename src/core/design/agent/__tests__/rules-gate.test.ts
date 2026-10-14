import { strict as assert } from "assert"
import * as path from "path"

import { readsTheRules } from "../conversation"
import { READ_RULES_FIRST, rulePermission } from "../permissions"

const PROJECT = path.resolve("/tmp/caret-gate-project")
const context = (rulesRead?: boolean) => ({ projectPath: PROJECT, mode: "write" as const, appWrites: "ask" as const, rulesRead })

describe("design-layer writes wait for the rules to be read", () => {
	it("refuses an edit in .caret/ until the session has read the rules, with the reason as feedback", () => {
		const ruling = rulePermission(
			{ action: "edit", patterns: [path.join(PROJECT, ".caret/pages/home/index.tsx")] },
			context(false),
		)
		assert.deepEqual(ruling, { kind: "auto", decision: "deny", reason: READ_RULES_FIRST })
	})

	it("allows the same edit once they have been read", () => {
		const ruling = rulePermission(
			{ action: "edit", patterns: [path.join(PROJECT, ".caret/pages/home/index.tsx")] },
			context(true),
		)
		assert.equal(ruling.kind === "auto" && ruling.decision, "allow")
	})

	it("gates Caret's own page-writing tools the same way, and nothing else of Caret's", () => {
		assert.equal(
			(rulePermission({ action: "caret_write_page", patterns: [] }, context(false)) as { decision: string }).decision,
			"deny",
		)
		assert.equal(
			(rulePermission({ action: "caret_update_tokens", patterns: [] }, context(false)) as { decision: string }).decision,
			"allow",
		)
	})

	it("leaves app edits to the app-write policy, read or not", () => {
		const ruling = rulePermission({ action: "edit", patterns: [path.join(PROJECT, "src/App.tsx")] }, context(false))
		assert.equal(ruling.kind, "ask")
	})

	it("does not gate when nothing tracks it (other callers)", () => {
		const ruling = rulePermission(
			{ action: "edit", patterns: [path.join(PROJECT, ".caret/pages/a/index.tsx")] },
			context(undefined),
		)
		assert.equal(ruling.kind === "auto" && ruling.decision, "allow")
	})
})

describe("what counts as reading the rules", () => {
	const end = (readPath?: string, name = "read", ok = true) => ({
		type: "tool-end" as const,
		callId: "c",
		name,
		ok,
		...(readPath ? { readPath } : {}),
	})

	it("reading .caret/AGENTS.md, or any file under .caret/ (OpenCode attaches the folder's AGENTS.md)", () => {
		assert.ok(readsTheRules(end(".caret/AGENTS.md"), PROJECT))
		assert.ok(readsTheRules(end(path.join(PROJECT, ".caret/pages/home/index.tsx")), PROJECT))
	})

	it("calling get_guide", () => {
		assert.ok(readsTheRules(end(undefined, "caret_get_guide"), PROJECT))
	})

	it("matches the real path where the project path is a symlink", () => {
		assert.ok(readsTheRules(end(`/private${PROJECT}/.caret/AGENTS.md`), PROJECT))
	})

	it("not reading an app file, a failed read, or another tool", () => {
		assert.ok(!readsTheRules(end(path.join(PROJECT, "src/App.tsx")), PROJECT))
		assert.ok(!readsTheRules(end(".caret/AGENTS.md", "read", false), PROJECT))
		assert.ok(!readsTheRules(end(undefined, "glob"), PROJECT))
	})
})
