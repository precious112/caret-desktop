import { strict as assert } from "assert"

import { isPublicHttpsUrl } from "../mcp/view-reference"

describe("view_reference only reaches public https hosts", () => {
	it("allows an ordinary https image link", () => {
		assert.ok(isPublicHttpsUrl("https://cdn.lazyweb.com/screens/abc.png"))
		assert.ok(isPublicHttpsUrl("https://8.8.8.8/x.png"))
	})

	it("refuses http, credentials, loopback, private networks and local names", () => {
		for (const url of [
			"http://cdn.example.com/a.png",
			"https://user:pw@example.com/a.png",
			"https://localhost:4096/session",
			"https://127.0.0.1/x",
			"https://10.0.0.5/x",
			"https://172.20.1.1/x",
			"https://192.168.1.10/x",
			"https://169.254.169.254/latest/meta-data",
			"https://100.64.0.1/x",
			"https://[::1]/x",
			"https://[fd00::1]/x",
			"https://printer.local/x",
			"https://intranet/x",
			"file:///etc/passwd",
			"not a url",
		]) {
			assert.equal(isPublicHttpsUrl(url), false, url)
		}
	})
})
