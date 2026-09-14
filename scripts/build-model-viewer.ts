/**
 * Builds the 3D-lane viewer for the learning directory.
 *
 *   npx tsx scripts/build-model-viewer.ts
 *
 * One page, two WebGL panels: the draft Tripo produced and the model after the
 * LLM's optimization pass, side by side, orbitable — because "14MB became
 * 528KB" is a number, and whether the object *survived* that is a judgment only
 * looking can make. That is the same argument as every contact sheet in this
 * repo, pointed at a mesh.
 *
 * The glbs are embedded as base64 and handed to `<model-viewer>` through blob
 * URLs, so the file opens from disk with no server and no fetch-from-file://
 * CORS refusals. The renderer itself is Google's model-viewer web component —
 * a hand-rolled three.js scene would be more code to get worse lighting.
 */
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const DIR = path.join(os.homedir(), "dev/self-learning/caret-learning")
const MODELS = path.join(DIR, "models")
const OUT = path.join(DIR, "model-viewer.html")

interface Meta {
	subject: string
	draftBytes: number
	optimizedBytes: number
	decision: { faceLimit: number; textureSize: number; reason: string }
	corrected?: string | null
}

async function main(): Promise<void> {
	const [draft, optimized, source, meta, aggressive] = await Promise.all([
		fs.readFile(path.join(MODELS, "draft.glb")),
		fs.readFile(path.join(MODELS, "optimized.glb")),
		fs.readFile(path.join(MODELS, "source.png")),
		fs.readFile(path.join(MODELS, "meta.json"), "utf-8").then((raw) => JSON.parse(raw) as Meta),
		// The 740KB version the first budget produced — kept as the exhibit that
		// set the band. Optional: a fresh models/ directory has no cautionary tale.
		fs.readFile(path.join(MODELS, "aggressive.glb")).catch(() => null),
	])

	const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString()}KB`
	const ratio = (meta.draftBytes / meta.optimizedBytes).toFixed(1)

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Caret — the 3D lane, looked at</title>
<script type="module" src="https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
<style>
  :root { --bg:#0b0d12; --panel:#11141b; --border:#1e232e; --text:#e6e9ef; --muted:#8b93a7; --accent:#0b7aff; }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--bg); color:var(--text); }
  body { font:14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         -webkit-font-smoothing:antialiased; padding:48px 40px 96px; }
  .wrap { max-width:1180px; margin:0 auto; }
  h1 { font-size:19px; font-weight:500; margin:0 0 6px; letter-spacing:-0.01em; }
  .lede { color:var(--muted); max-width:66ch; margin-bottom:36px; }
  .lede strong { color:var(--text); font-weight:500; }
  .grid { display:grid; grid-template-columns:repeat(var(--panels, 2), 1fr); gap:20px; }
  .panel { border:1px solid var(--border); border-radius:12px; background:var(--panel); overflow:hidden; }
  .panel h2 { font-size:12px; font-weight:500; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted);
              margin:0; padding:12px 16px; display:flex; justify-content:space-between; align-items:baseline; }
  .panel h2 b { color:var(--text); font:500 15px/1 inherit; letter-spacing:0; text-transform:none; }
  model-viewer { width:100%; height:440px; background:#f4f4f6; --poster-color:#f4f4f6; }
  .decision { margin-top:20px; border:1px solid var(--border); border-radius:12px; background:var(--panel); padding:16px 18px;
              display:grid; grid-template-columns:96px 1fr; gap:16px; align-items:start; }
  .decision img { width:96px; height:96px; object-fit:cover; border-radius:8px; border:1px solid var(--border); }
  .decision p { margin:0; color:var(--muted); }
  .decision p strong { color:var(--text); font-weight:500; }
  .decision .params { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--accent); margin-bottom:6px; }
  .foot { margin-top:28px; color:var(--muted); font-size:12.5px; max-width:66ch; }
</style>
</head>
<body>
<div class="wrap">
  <h1>The 3D lane, looked at</h1>
  <p class="lede">
    Every mesh below is real WebGL — drag to orbit, scroll to zoom, and look at the printed labels on the
    earpads. Left: the draft Tripo built from a Nano-Banana object study. ${
		aggressive ? "Middle: what the first budget produced — the melted-label 740KB that set the 3–5MB band. Right:" : "Right:"
	}
    the band-enforced optimization. <strong>${kb(meta.draftBytes)} → ${kb(meta.optimizedBytes)}, ${ratio}× lighter,
    inside the band</strong> — the judgment this page exists for is whether the labels survived this time.
  </p>

  <div class="grid" style="--panels:${aggressive ? 3 : 2}">
    <div class="panel">
      <h2>Draft <b>${kb(meta.draftBytes)}</b></h2>
      <model-viewer id="draft" camera-controls auto-rotate shadow-intensity="1" exposure="0.9" alt="draft model"></model-viewer>
    </div>
    ${
		aggressive
			? `<div class="panel">
      <h2>Over-optimized <b>${kb(aggressive.length)}</b></h2>
      <model-viewer id="aggressive" camera-controls auto-rotate shadow-intensity="1" exposure="0.9" alt="over-optimized model"></model-viewer>
    </div>`
			: ""
	}
    <div class="panel">
      <h2>Band-enforced <b>${kb(meta.optimizedBytes)}</b></h2>
      <model-viewer id="optimized" camera-controls auto-rotate shadow-intensity="1" exposure="0.9" alt="optimized model"></model-viewer>
    </div>
  </div>

  <div class="decision">
    <img alt="the source image" id="source">
    <div>
      <p class="params">${meta.decision.faceLimit.toLocaleString()} faces · ${meta.decision.textureSize}px textures</p>
      <p><strong>The model's own reasoning, recorded in provenance:</strong> ${meta.decision.reason}</p>
      ${meta.corrected ? `<p style="margin-top:6px"><strong>Corrective pass:</strong> ${meta.corrected}</p>` : ""}
    </div>
  </div>

  <p class="foot">
    The source image was generated by the object-study recipe — one object, centered, even light — after the
    verification layer refused a multi-object photograph. The decision above was made inside a bounded schema:
    the model chooses within published limits, Tripo does the work, and the whole chain lands in the asset's
    provenance.
  </p>
</div>

<script>
  // Blob URLs rather than data: URIs: model-viewer fetches its src, and a blob
  // is the one scheme that behaves identically on file:// and http://.
  const load = (id, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    document.getElementById(id).src = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }))
  }
  load("draft", "${draft.toString("base64")}")
  ${aggressive ? `load("aggressive", "${aggressive.toString("base64")}")` : ""}
  load("optimized", "${optimized.toString("base64")}")
  document.getElementById("source").src = "data:image/png;base64,${source.toString("base64")}"
</script>
</body>
</html>
`

	await fs.writeFile(OUT, html, "utf-8")
	const stat = await fs.stat(OUT)
	console.log(`wrote ${OUT} (${Math.round((stat.size / 1024 / 1024) * 10) / 10}MB)`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
