/**
 * Ad-hoc signs the macOS bundle after electron-builder has assembled it.
 *
 * This is not optional on Apple Silicon: an arm64 Mach-O with no valid signature
 * will not execute at all, and the failure surfaces to the user as "Caret is
 * damaged and can't be opened" — which reads as a corrupt download and sends
 * them to re-download a file that was fine.
 *
 * electron-builder's `identity: null` means *skip signing*, not *ad-hoc sign*.
 * Electron's prebuilt binary arrives linker-signed, but injecting the app's own
 * files invalidates that, so the bundle has to be re-signed here. Verified with
 * `codesign --verify --deep --strict`, which is what catches the difference
 * between "a signature is present" and "the signature is valid".
 *
 * When a real Developer ID is available, `CSC_LINK`/`CSC_KEY_PASSWORD` take over
 * through electron-builder's normal path and this hook steps aside — so adding
 * the certificate later is a secrets change, not a pipeline rebuild.
 */
const { execFileSync } = require("child_process")
const fs = require("fs")
const path = require("path")

/** electron-builder's `Arch` enum, which arrives as a number. */
const ARCHES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" }

exports.default = async function afterPack(context) {
	pruneForeignBinaries(context)

	if (context.electronPlatformName !== "darwin") return

	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)

	// electron-builder signs AFTER this hook (macPackager.js calls afterPack,
	// then doSignAfterPack), so a real certificate is handled in
	// build/after-sign.cjs. Nothing to do here but stand aside.
	if (process.env.CSC_LINK || process.env.CSC_NAME) return

	// Deep, force, ad-hoc ("-"). Deep is required because the Electron
	// Framework and the helper apps are nested bundles with their own
	// signatures, all invalidated by the same repack.
	execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" })

	// Fail the build rather than ship something that will not launch.
	execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" })

	console.log(`  • ad-hoc signed and verified  ${appPath}`)
}

/**
 * Drops the OTHER platforms' native binaries from the packed app.
 *
 * `onnxruntime-node` ships every platform/arch runtime in one tarball (~246MB
 * across six combinations), and before-pack.cjs stages the target's `@img/*`
 * sharp packages ALONGSIDE the build machine's rather than replacing them.
 * Both are correct inputs and wrong outputs: without this prune every artifact
 * carries a couple of hundred MB of binaries it can never execute.
 */
function pruneForeignBinaries(context) {
	const platform = context.electronPlatformName
	const arch = ARCHES[context.arch] ?? String(context.arch)
	const appDir =
		platform === "darwin"
			? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources", "app")
			: path.join(context.appOutDir, "resources", "app")
	const modules = path.join(appDir, "node_modules")

	// ORT lays its runtimes out as bin/napi-v6/<platform>/<arch>, with node-style
	// platform names — the same ones electron-builder uses.
	const napi = path.join(modules, "onnxruntime-node", "bin", "napi-v6")
	if (fs.existsSync(napi)) {
		for (const platformDir of fs.readdirSync(napi)) {
			const platformPath = path.join(napi, platformDir)
			if (platformDir !== platform) {
				fs.rmSync(platformPath, { recursive: true, force: true })
				continue
			}
			for (const archDir of fs.readdirSync(platformPath)) {
				if (archDir !== arch) fs.rmSync(path.join(platformPath, archDir), { recursive: true, force: true })
			}
		}
	}

	// sharp's binding packages are named @img/sharp[-libvips]-<platform>-<arch>.
	const keepSuffix = `-${platform}-${arch}`
	const imgDirs = [path.join(modules, "@img"), path.join(modules, "ndarray-pixels", "node_modules", "@img")]
	for (const imgDir of imgDirs) {
		if (!fs.existsSync(imgDir)) continue
		for (const name of fs.readdirSync(imgDir)) {
			if (!name.startsWith("sharp")) continue
			if (name.endsWith(keepSuffix)) continue
			fs.rmSync(path.join(imgDir, name), { recursive: true, force: true })
		}
	}

	console.log(`  • pruned foreign native binaries (kept ${platform}-${arch})`)
}
