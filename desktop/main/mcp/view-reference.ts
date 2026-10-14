/**
 * `view_reference`: shows the Design pass's designer a reference screenshot.
 *
 * Lazyweb and 21st.dev return screenshots as links, and a link in a tool result
 * never reaches the model as a picture — only an image the tool returns itself
 * does (measured in the prototype). This fetches the image and returns it.
 *
 * The URL comes from a model, so it is treated as untrusted: public https
 * hosts only (Caret's own servers and the OpenCode server listen on loopback,
 * and nothing on the user's network is the designer's business), images only,
 * and a size cap. Large screenshots are scaled down so one reference does not
 * cost a whole context window.
 */
import { nativeImage } from "electron"
import { z } from "zod"

import { fetch } from "../../../src/shared/net"

const MAX_BYTES = 12 * 1024 * 1024
const MAX_WIDTH = 1600

/** Refuses anything but a public https host. Hostname-based: there is no DNS lookup here. */
export function isPublicHttpsUrl(raw: string): boolean {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return false
	}
	if (url.protocol !== "https:" || url.username || url.password) return false
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false
	if (!host.includes(".") && !host.includes(":")) return false
	if (host.includes(":")) return !/^(::1?|fe80:|fc|fd)/.test(host) && host !== "::"
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])]
		if (a === 0 || a === 10 || a === 127 || a >= 224) return false
		if (a === 169 && b === 254) return false
		if (a === 172 && b >= 16 && b <= 31) return false
		if (a === 192 && b === 168) return false
		if (a === 100 && b >= 64 && b <= 127) return false
	}
	return true
}

type ToolResult = {
	content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
	isError?: boolean
}

const failed = (message: string): ToolResult => ({
	content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
	isError: true,
})

export const VIEW_REFERENCE_TOOL = {
	name: "view_reference",
	title: "View a reference screenshot",
	description:
		"Shows you a reference screenshot from a link a design library returned (Lazyweb, 21st.dev, Gummble). Use it when a search result gives an image only as a URL. Public https image links only.",
	inputSchema: { url: z.string().describe("The screenshot's https URL, exactly as the library returned it") },
	async handler(_ctx: unknown, args: { url: string }): Promise<ToolResult> {
		if (!isPublicHttpsUrl(args.url)) return failed("Only public https image links can be viewed.")
		let response: Response
		try {
			response = await fetch(args.url, { redirect: "follow" })
		} catch (err) {
			return failed(`Could not fetch the image: ${err instanceof Error ? err.message : String(err)}`)
		}
		if (!response.ok) return failed(`The image link answered ${response.status}.`)
		// A redirect may not land somewhere the original check would have refused.
		if (response.url && !isPublicHttpsUrl(response.url)) return failed("The link redirected somewhere that cannot be viewed.")
		const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
		if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(type))
			return failed(`That link is not an image (${type || "unknown type"}).`)
		const declared = Number(response.headers.get("content-length") ?? 0)
		if (declared > MAX_BYTES) return failed("The image is too large to view.")
		const bytes = Buffer.from(await response.arrayBuffer())
		if (bytes.length > MAX_BYTES) return failed("The image is too large to view.")

		let image = nativeImage.createFromBuffer(bytes)
		if (!image.isEmpty()) {
			if (image.getSize().width > MAX_WIDTH) image = image.resize({ width: MAX_WIDTH, quality: "good" })
			return {
				content: [
					{ type: "text", text: "The reference screenshot:" },
					{ type: "image", data: image.toJPEG(82).toString("base64"), mimeType: "image/jpeg" },
				],
			}
		}
		// A format Electron cannot decode (webp on some systems) goes as it came.
		return {
			content: [
				{ type: "text", text: "The reference screenshot:" },
				{ type: "image", data: bytes.toString("base64"), mimeType: type === "image/jpg" ? "image/jpeg" : type },
			],
		}
	},
}
