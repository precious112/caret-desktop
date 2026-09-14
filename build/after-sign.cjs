/**
 * Confirms the macOS bundle really carries a Developer ID signature.
 *
 * This runs after electron-builder's own signing step (platformPackager.js
 * calls signApp, then afterSign), which is the only point where the question
 * can be answered. The check exists because the failure it catches is silent:
 * `mac.identity: null` in electron-builder.yml means "skip signing ALWAYS",
 * even with CSC_LINK set, and build/after-pack.cjs stands aside as soon as it
 * sees a certificate. Together those ship a bundle with no signature at all,
 * and nothing says so until a user's Gatekeeper refuses to open it.
 *
 * Cheap insurance: one codesign call against a build that already took minutes.
 */
const { spawnSync } = require("child_process")

exports.default = async function afterSign(context) {
	if (context.electronPlatformName !== "darwin") return
	if (!process.env.CSC_LINK && !process.env.CSC_NAME) return

	const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`

	// `codesign --display` writes to STDERR, and execFileSync returns only
	// stdout, so it would hand back null. spawnSync exposes both streams.
	const shown = (() => {
		const r = spawnSync("codesign", ["--display", "--verbose=2", appPath], { encoding: "utf8" })
		return `${r.stdout ?? ""}${r.stderr ?? ""}`
	})()

	if (/Signature=adhoc/.test(shown) || !/\bAuthority=/.test(shown)) {
		throw new Error(
			`A signing certificate was configured but ${appPath} carries no Developer ID signature.\n` +
				`codesign reported:\n${shown}\n` +
				`Check that mac.identity is absent from electron-builder.yml (null means skip).`,
		)
	}

	const team = /TeamIdentifier=(\S+)/.exec(shown)
	const authority = /Authority=(.+)/.exec(shown)
	console.log(`  • signature verified  ${authority ? authority[1] : "?"}  team=${team ? team[1] : "?"}`)
}
