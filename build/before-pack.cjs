/**
 * Stages the per-target native pieces electron-builder cannot pick itself:
 * the OpenCode binary and sharp's platform packages.
 *
 * Caret spawns its backend from inside the app bundle, never from `PATH`, so the
 * binary has to be in `extraResources` — and the right one has to be chosen per
 * target, not per build machine.
 *
 * Three things make that non-obvious:
 *
 * - The `opencode-ai` package's own postinstall hardlinks whichever binary suits
 *   the **build machine**, so copying `node_modules/opencode-ai/bin` cross-compiles
 *   the wrong architecture without complaining.
 * - For x64 the choice is a **runtime CPU** property, not a build one: the plain
 *   x64 build needs AVX2 and the `-baseline` build does not. Since a packaged app
 *   cannot know its future CPU, x64 ships baseline, which runs everywhere.
 * - Every platform package declares hard `os`/`cpu` gates, and npm refuses a
 *   directly requested install of a foreign platform's package (EBADPLATFORM)
 *   unless told `--os`/`--cpu` — without those flags a cross-build aborts here.
 *
 * The platform packages are downloaded on demand rather than added as
 * dependencies, so a developer install pulls one 145MB binary instead of twelve.
 *
 * sharp is different: it is a production dep (via @gltf-transform/cli and
 * ndarray-pixels), electron-builder copies node_modules verbatim, and npm only
 * ever installed the build machine's `@img/*` binaries — so without staging,
 * every cross-built app ships darwin-x64 sharp and `require("sharp")` throws on
 * the target. The foreign copies are pruned again in after-pack.cjs.
 */
const child_process = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const VERSION = require("../package.json").devDependencies["opencode-ai"]

const PLATFORMS = { darwin: "darwin", win32: "windows", linux: "linux" }

/** electron-builder's `Arch` enum, which arrives as a number. */
const ARCHES = { 0: "ia32", 1: "x64", 2: "armv7l", 3: "arm64", 4: "universal" }

exports.default = async function beforePack(context) {
	// Node-style name ("win32") for npm's --os flag and @img package names; the
	// mapped name ("windows") exists only because the opencode packages use it.
	const nodePlatform = context.electronPlatformName
	const platform = PLATFORMS[nodePlatform] ?? nodePlatform
	const arch = ARCHES[context.arch] ?? String(context.arch)

	if (arch === "universal") {
		// A universal build would need both binaries merged with `lipo`, which the
		// backend adapter has no way to select between at runtime. Fail loudly
		// rather than shipping an app whose backend silently never starts.
		throw new Error("Caret cannot build a universal macOS bundle: package arm64 and x64 separately.")
	}

	// x64 always takes the baseline build — see the note above.
	const packageName = `opencode-${platform}-${arch}${arch === "x64" ? "-baseline" : ""}`
	const binaryName = platform === "windows" ? "opencode.exe" : "opencode"

	const staging = path.join(__dirname, "opencode")
	fs.rmSync(staging, { recursive: true, force: true })
	fs.mkdirSync(staging, { recursive: true })

	const source = resolveBinary(packageName, binaryName, nodePlatform, arch)
	const target = path.join(staging, binaryName)
	fs.copyFileSync(source, target)
	fs.chmodSync(target, 0o755)

	console.log(`[before-pack] staged ${packageName}@${VERSION} for ${platform}-${arch}`)

	ensureSharpBinaries(nodePlatform)
}

/** Finds the platform package locally, downloading it into a temp tree if absent. */
function resolveBinary(packageName, binaryName, nodePlatform, arch) {
	const local = path.join(__dirname, "..", "node_modules", packageName, "bin", binaryName)
	if (fs.existsSync(local)) return local

	const scratch = installForTarget(`${packageName}@${VERSION}`, nodePlatform, arch)
	const downloaded = path.join(scratch, "node_modules", packageName, "bin", binaryName)
	if (!fs.existsSync(downloaded)) {
		throw new Error(`${packageName}@${VERSION} did not contain bin/${binaryName}`)
	}
	return downloaded
}

/**
 * Ensures each sharp install (the root one and ndarray-pixels' nested copy) has
 * the target platform's `@img/*` binaries sitting next to it — for BOTH arches,
 * not just the one being packed. electron-builder computes its node_modules
 * collection once per invocation, on the FIRST arch pass; a package staged by
 * the second arch's beforePack is invisible to it, which is exactly how a
 * win-arm64 slice shipped with no sharp binding at all while the log said it
 * was staged. Versions come from that sharp's own optionalDependencies — the
 * binding package must match its sharp exactly, and the two sharps in this
 * tree are different versions. after-pack.cjs prunes each slice down to its
 * own arch.
 */
function ensureSharpBinaries(nodePlatform) {
	const roots = [
		path.join(__dirname, "..", "node_modules"),
		path.join(__dirname, "..", "node_modules", "ndarray-pixels", "node_modules"),
	]
	for (const root of roots) {
		const sharpManifest = path.join(root, "sharp", "package.json")
		if (!fs.existsSync(sharpManifest)) continue
		const optional = JSON.parse(fs.readFileSync(sharpManifest, "utf-8")).optionalDependencies ?? {}
		for (const arch of ["x64", "arm64"]) {
			// win32 packages bundle libvips; darwin/linux need the separate package too.
			const wanted = [`@img/sharp-${nodePlatform}-${arch}`, `@img/sharp-libvips-${nodePlatform}-${arch}`].filter(
				(name) => optional[name],
			)
			for (const name of wanted) {
				const destination = path.join(root, ...name.split("/"))
				if (fs.existsSync(destination)) continue
				const scratch = installForTarget(`${name}@${optional[name]}`, nodePlatform, arch)
				fs.cpSync(path.join(scratch, "node_modules", ...name.split("/")), destination, { recursive: true })
				console.log(`[before-pack] staged ${name}@${optional[name]} for ${nodePlatform}-${arch}`)
			}
		}
	}
}

/**
 * Installs one package FOR THE TARGET platform into a scratch tree and returns
 * the tree. `--os`/`--cpu` are what makes npm accept another platform's
 * platform-gated package instead of aborting with EBADPLATFORM.
 */
function installForTarget(spec, nodePlatform, arch) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "caret-stage-"))
	runNpm([
		"install",
		"--no-save",
		"--no-audit",
		"--no-fund",
		"--ignore-scripts",
		`--os=${nodePlatform}`,
		`--cpu=${arch}`,
		"--force",
		"--prefix",
		scratch,
		spec,
	])
	return scratch
}

/**
 * npm on Windows is `npm.cmd`, which only a shell can start — and a shell gets
 * the arguments re-joined unquoted, so anything that may contain a space (the
 * temp-dir prefix) is quoted by hand here.
 */
function runNpm(args) {
	const windows = process.platform === "win32"
	const quoted = windows ? args.map((argument) => (/\s/.test(argument) ? `"${argument}"` : argument)) : args
	child_process.execFileSync(windows ? "npm.cmd" : "npm", quoted, { stdio: "inherit", shell: windows })
}
