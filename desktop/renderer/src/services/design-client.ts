/**
 * The wizard's data layer, over IPC.
 *
 * The token wizard came across from the VS Code webview, where it talked to a
 * generated gRPC client. Rather than rewrite six components, this keeps the same
 * method names and the same JSON-string request/response shapes and swaps what
 * is underneath — the wizard is well-tested UI and its interface was never the
 * problem.
 *
 * One renderer serves one project window, so the project path is module state
 * set once when the window's project is known, rather than threaded through
 * every component.
 */
import { invoke } from "../ipc"

let projectPath = ""

export function setActiveProject(path: string): void {
	projectPath = path
}

function requireProject(): string {
	if (!projectPath) throw new Error("No project is open")
	return projectPath
}

export const DesignServiceClient = {
	async getFoundationTokens(_request: Record<string, never>): Promise<{ tokensJson: string }> {
		const tokens = await invoke("tokens:read", requireProject())
		return { tokensJson: JSON.stringify(tokens) }
	},

	async updateFoundationTokens(request: { tokensJson: string }): Promise<{ ok: boolean }> {
		const result = await invoke("tokens:write", requireProject(), JSON.parse(request.tokensJson))
		// The wizard shows a save error from a thrown message, so a rejected write
		// has to throw rather than resolve with `ok: false`.
		if (!result.ok) throw new Error(result.error ?? "Could not save the foundation tokens")
		return { ok: true }
	},

	async generateTokenScale(request: {
		type: "color" | "typography" | "spacing" | "radius"
		seedValue: string
		optionsJson: string
	}): Promise<{ scaleJson: string }> {
		const options = request.optionsJson ? (JSON.parse(request.optionsJson) as Record<string, unknown>) : {}
		const scale = await invoke("tokens:generateScale", request.type, request.seedValue, options)
		return { scaleJson: JSON.stringify(scale) }
	},

	async searchGoogleFonts(request: {
		value: string
	}): Promise<{ fonts: Array<{ family: string; category: string; variants: string[] }>; source: "google-fonts" | "bundled" }> {
		const result = await invoke("fonts:search", request.value)
		return { fonts: result.fonts, source: result.source }
	},
}
