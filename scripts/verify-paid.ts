/**
 * The paid image checks, against the real Google service, with a hard cap.
 *
 *   npm run test:paid
 *
 * Reads the Gemini key from ~/.caret-test/gemini-key (never printed, never
 * written anywhere else), and runs the app checks that spend: a photograph
 * made from exact words, used, branched and used again (bi), and a cutout
 * (bm), with the scenarios they depend on. The app is told it may make at
 * most CAP image calls (retries included); past that it refuses to send.
 * At roughly 4 to 7 cents an image, the cap is about $3.
 */
import * as child_process from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const CAP = 45

async function main(): Promise<void> {
	const keyFile = path.join(os.homedir(), ".caret-test", "gemini-key")
	const key = (await fs.readFile(keyFile, "utf8").catch(() => "")).trim()
	if (!key) throw new Error(`No key: put the Gemini API key in ${keyFile}.`)
	const env = {
		...process.env,
		GEMINI_API_KEY: key,
		CARET_IMAGE_CALL_CAP: String(CAP),
		CARET_VERIFY_PAID: "1",
		CARET_VERIFY_MODEL: process.env.CARET_VERIFY_MODEL || "opencode-go/deepseek-v4.1-flash",
	}
	console.log(`Paid run: at most ${CAP} image calls.`)
	const run = child_process.spawnSync("npm", ["run", "verify:app", "--", "--paid", "--only", "a,b,h,m,bh,bi,bm"], {
		env,
		stdio: "inherit",
	})
	process.exitCode = run.status ?? 1
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err)
	process.exitCode = 1
})
