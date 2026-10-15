/**
 * A stand-in library for the real-app tests, in development builds only.
 *
 * `CARET_TEST_LIBRARY` names a small MCP server script (see
 * `test-fixtures/libraries/fake-library.cjs`). Caret then lists one more
 * library, "Test library", run by Caret's own binary, so a test can check the
 * whole road (Caret connects, passes the tools on, a coding tool calls one)
 * against known answers, with no network. A packaged Caret never reads it.
 */
import type { LibraryConnection, LibraryDefinition } from "../../../src/core/design/libraries/catalog"

export const TEST_LIBRARY: LibraryDefinition = {
	id: "testlib",
	name: "Test library",
	gives: "Known answers for Caret's own tests",
	kind: "components",
	access: "none",
	// The fixture also offers `delete_everything`, which must never be passed on.
	allowedTools: ["search_components", "union_tool"],
}

export function testLibraryFromEnv(
	env: NodeJS.ProcessEnv,
	packaged: boolean,
	execPath: string,
): { definition: LibraryDefinition; connection: LibraryConnection } | null {
	const script = env.CARET_TEST_LIBRARY
	if (packaged || !script) return null
	return {
		definition: TEST_LIBRARY,
		connection: { kind: "stdio", command: execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: "1" } },
	}
}
