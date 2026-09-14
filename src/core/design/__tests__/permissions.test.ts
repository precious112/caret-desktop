/**
 * The permission rules are the boundary. Everything else about the backend can
 * be re-run; a write that should not have happened cannot.
 *
 * Tested as a pure function, without a running agent, because the failure this
 * guards against is a rule being subtly wrong rather than a wire being unplugged.
 */
import { strict as assert } from "assert"

import { classify, isReadOnlyCommand, type PermissionContext, rulePermission } from "../agent/permissions"

const PROJECT = "/Users/dev/app"

function context(overrides: Partial<PermissionContext> = {}): PermissionContext {
	return { projectPath: PROJECT, mode: "write", appWrites: "ask", ...overrides }
}

describe("classify", () => {
	it("puts .caret/ in the design layer", () => {
		assert.equal(classify(`${PROJECT}/.caret/pages/home/index.tsx`, PROJECT), "design")
	})

	it("puts the rest of the project in the app", () => {
		assert.equal(classify(`${PROJECT}/src/App.tsx`, PROJECT), "app")
	})

	it("puts anything above the project outside it", () => {
		assert.equal(classify("/Users/dev/other/App.tsx", PROJECT), "outside")
		assert.equal(classify("/etc/passwd", PROJECT), "outside")
	})

	it("refuses a traversal dressed up as a project path", () => {
		assert.equal(classify(`${PROJECT}/../secrets/.env`, PROJECT), "outside")
	})

	it("accepts a path whose leading separator the backend stripped", () => {
		// Observed on the real backend: edit permissions arrive as
		// `Users/dev/app/...` with no leading slash.
		assert.equal(classify("Users/dev/app/.caret/pages/home/index.tsx", PROJECT), "design")
	})

	it("accepts a path the backend reported relative to the project", () => {
		// Also observed on the real backend, for the same tool, in the same
		// session — which is why one interpretation is not enough.
		assert.equal(classify(".caret/pages/home/index.tsx", PROJECT), "design")
		assert.equal(classify("src/App.tsx", PROJECT), "app")
	})

	it("still refuses a relative path that climbs out", () => {
		assert.equal(classify("../../etc/passwd", PROJECT), "outside")
	})

	it("treats macOS's /private prefix as the same file", () => {
		// mkdtemp hands out /var/folders/... while the agent reports
		// /private/var/folders/..., and a plain string compare says "outside".
		assert.equal(classify("/private/var/t/proj/.caret/x.tsx", "/var/t/proj"), "design")
		assert.equal(classify("/var/t/proj/src/x.tsx", "/private/var/t/proj"), "app")
	})
})

describe("rulePermission — Caret's own MCP tools", () => {
	// The chat agent can edit a page two ways: the backend's `edit` tool, or
	// Caret's own `caret_write_page` over the bridge. The first was always
	// gated; the second used to run without any permission event at all, so
	// the same write was recorded or silent depending on which tool the model
	// happened to pick. Both routes must land on the same ruling.
	it("auto-allows a caret_ tool with the design-layer note", () => {
		const ruling = rulePermission({ action: "caret_write_page", patterns: ["*"] }, context())
		assert.deepEqual(ruling, { kind: "auto", decision: "allow", reason: "the design layer is Caret's own to write" })
	})

	it("allows it in a plan too — the design layer is not the app", () => {
		const ruling = rulePermission({ action: "caret_update_tokens", patterns: [] }, context({ mode: "read-only" }))
		assert.equal(ruling.kind, "auto")
		assert.equal((ruling as { decision: string }).decision, "allow")
	})

	it("does not let the prefix leak onto other actions", () => {
		// `caretaker` is a made-up backend action, not one of Caret's tools; it
		// must fall through to the unrecognised-action ask.
		const ruling = rulePermission({ action: "caretaker", patterns: [] }, context())
		assert.equal(ruling.kind, "ask")
	})
})

describe("rulePermission — edits", () => {
	it("auto-approves the design layer, in either mode", () => {
		for (const mode of ["read-only", "write"] as const) {
			const ruling = rulePermission(
				{ action: "edit", patterns: [`${PROJECT}/.caret/pages/a/index.tsx`] },
				context({ mode }),
			)
			assert.equal(ruling.kind, "auto")
			assert.equal(ruling.kind === "auto" && ruling.decision, "allow")
		}
	})

	it("denies an app write during a plan, with no prompt", () => {
		const ruling = rulePermission({ action: "edit", patterns: [`${PROJECT}/src/App.tsx`] }, context({ mode: "read-only" }))
		assert.equal(ruling.kind, "auto")
		assert.equal(ruling.kind === "auto" && ruling.decision, "deny")
	})

	it("asks about an app write in a write session", () => {
		const ruling = rulePermission({ action: "edit", patterns: [`${PROJECT}/src/App.tsx`] }, context())
		assert.equal(ruling.kind, "ask")
		assert.ok(ruling.kind === "ask" && ruling.summary.includes("src/App.tsx"))
	})

	it("stops asking once the user says always, for that project", () => {
		const ruling = rulePermission({ action: "edit", patterns: [`${PROJECT}/src/App.tsx`] }, context({ appWrites: "allow" }))
		assert.equal(ruling.kind, "auto")
		assert.equal(ruling.kind === "auto" && ruling.decision, "allow")
	})

	it("never allows a write outside the project, however permissive the settings", () => {
		const ruling = rulePermission({ action: "edit", patterns: ["/Users/dev/other/x.ts"] }, context({ appWrites: "allow" }))
		assert.equal(ruling.kind, "auto")
		assert.equal(ruling.kind === "auto" && ruling.decision, "deny")
	})

	it("takes the strictest answer for a batch that mixes layers", () => {
		// One call touching both is an app edit as far as consent goes, and one
		// touching anything outside is refused outright.
		const mixed = rulePermission(
			{ action: "edit", patterns: [`${PROJECT}/.caret/pages/a/index.tsx`, `${PROJECT}/src/App.tsx`] },
			context(),
		)
		assert.equal(mixed.kind, "ask")

		const escaping = rulePermission(
			{ action: "edit", patterns: [`${PROJECT}/.caret/pages/a/index.tsx`, "/etc/hosts"] },
			context({ appWrites: "allow" }),
		)
		assert.equal(escaping.kind === "auto" && escaping.decision, "deny")
	})
})

describe("isReadOnlyCommand", () => {
	it("allows the commands an agent uses to look around", () => {
		for (const command of [
			"ls -la src",
			"rg TODO src",
			"cat package.json",
			"git status",
			"git diff HEAD~1",
			"find . -name '*.tsx'",
		]) {
			assert.ok(isReadOnlyCommand(command), `expected "${command}" to be read-only`)
		}
	})

	it("tolerates stderr being thrown away", () => {
		// How every agent writes `find`. Refusing it sent the plan phase into a
		// retry loop over a command that only silences noise.
		assert.ok(isReadOnlyCommand("find . -type f 2>/dev/null"))
		assert.ok(isReadOnlyCommand("grep -r TODO . 2>&1"))
		assert.ok(!isReadOnlyCommand("find . -type f > out.txt"))
	})

	it("does not mistake a quoted argument for shell composition", () => {
		// A regex alternation is a pipe the shell never sees. Refusing it makes the
		// plan phase useless for the searches it most wants to run.
		assert.ok(isReadOnlyCommand(`grep -n "route\\|Router\\|path" src/main.tsx`))
		assert.ok(isReadOnlyCommand("find . -name '*.tsx' -o -name '*.ts'"))

		// Double quotes still expand, so a substitution inside them is still caught.
		assert.ok(!isReadOnlyCommand('grep -n "$(rm -rf .)" file'))
		assert.ok(!isReadOnlyCommand('cat "`rm x`"'))
	})

	it("refuses anything that could start a second command", () => {
		// The allowlist is of programs; composition is refused before the name is
		// even looked at, so a harmless first command cannot smuggle a second.
		for (const command of ["ls; rm -rf .", "ls && rm x", "cat a > b", "echo $(rm x)", "ls | xargs rm", "ls `rm x`"]) {
			assert.ok(!isReadOnlyCommand(command), `expected "${command}" to be refused`)
		}
	})

	it("refuses writes wearing a reader's name", () => {
		assert.ok(!isReadOnlyCommand("sed -i s/a/b/ file.ts"))
		assert.ok(!isReadOnlyCommand("git checkout main"))
		assert.ok(!isReadOnlyCommand("git reset --hard"))
		assert.ok(!isReadOnlyCommand("npm install"))
	})
})

describe("rulePermission — everything else", () => {
	it("lets a plan look around, but not act", () => {
		// Denying bash outright was tried: the agent retried it until the turn ran
		// out, and the plan was worse for never having read the app.
		const looking = rulePermission({ action: "bash", patterns: ["git log --oneline -20"] }, context({ mode: "read-only" }))
		assert.equal(looking.kind === "auto" && looking.decision, "allow")

		const acting = rulePermission({ action: "bash", patterns: ["rm -rf build"] }, context({ mode: "read-only" }))
		assert.equal(acting.kind === "auto" && acting.decision, "deny")
	})

	it("asks about any command in a write session, even a harmless one", () => {
		const writing = rulePermission({ action: "bash", patterns: ["npm test"] }, context())
		assert.equal(writing.kind, "ask")
		assert.ok(writing.kind === "ask" && writing.summary.includes("npm test"))

		const reading = rulePermission({ action: "bash", patterns: ["ls"] }, context())
		assert.equal(reading.kind, "ask")
	})

	it("asks about an action it has never heard of rather than allowing it", () => {
		// A backend that grows a new capability must not gain it silently inside
		// Caret just because this file predates it.
		const ruling = rulePermission({ action: "send_email", patterns: [] }, context())
		assert.equal(ruling.kind, "ask")
	})
})

describe("rulePermission — installing into the design layer", () => {
	// The guide tells the agent to install a library into .caret before
	// importing it; the exact prescribed shape must run without an ask, and
	// nothing looser may ride along with it.
	const allowed = (command: string) => {
		const ruling = rulePermission({ action: "bash", patterns: [command] }, context())
		return ruling.kind === "auto" && ruling.decision === "allow"
	}

	it("allows the exact shape the guide prescribes", () => {
		assert.ok(allowed("npm install --prefix .caret gsap --ignore-scripts"))
		assert.ok(allowed("npm i --prefix .caret @google/model-viewer --ignore-scripts"))
		assert.ok(allowed(`npm install --prefix=${PROJECT}/.caret gsap --ignore-scripts`))
	})

	it("asks without --ignore-scripts — install-time code is the line", () => {
		assert.ok(!allowed("npm install --prefix .caret gsap"))
	})

	it("asks when the prefix lands outside the design layer", () => {
		assert.ok(!allowed("npm install --prefix . gsap --ignore-scripts"))
		assert.ok(!allowed("npm install --prefix .caret/../src gsap --ignore-scripts"))
		assert.ok(!allowed("npm install --prefix /tmp/elsewhere gsap --ignore-scripts"))
	})

	it("asks without a prefix, and refuses to look past chaining", () => {
		assert.ok(!allowed("npm install gsap --ignore-scripts"))
		assert.ok(!allowed("npm install --prefix .caret gsap --ignore-scripts && rm -rf ."))
		assert.ok(!allowed("cd .caret && npm install gsap --ignore-scripts"))
	})
})
