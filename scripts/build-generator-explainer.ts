/**
 * Builds the generator-lane explainer.
 *
 *   npx tsx scripts/build-generator-explainer.ts [--out <file.html>]
 *
 * The page bundles the real generators rather than describing them, so every
 * claim it makes is a thing the reader can drag a slider and check. That is the
 * whole point of this lane and it is not something a screenshot can show.
 */
import { build } from "esbuild"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const outIndex = process.argv.indexOf("--out")
const out = path.resolve(
	outIndex > -1 ? process.argv[outIndex + 1] : path.join(os.homedir(), "dev/self-learning/caret-learning/generator-lane.html"),
)

async function bundle(): Promise<string> {
	const result = await build({
		entryPoints: [path.resolve("scripts/generator-explainer-entry.ts")],
		bundle: true,
		format: "iife",
		platform: "browser",
		target: "es2022",
		write: false,
		minify: false,
		// The page is opened from the filesystem, so everything has to be inline —
		// except the auth library, which only the raster lane touches and only
		// through a dynamic import that this page never reaches. Bundling it would
		// drag `child_process` and `stream` into a browser build for nothing.
		external: ["google-auth-library"],
	})
	return result.outputFiles[0].text
}

function page(script: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Caret — why a generator instead of a model</title>
<style>
  :root { --bg:#0b0d12; --panel:#11141b; --border:#1e232e; --text:#e6e9ef; --muted:#8b93a7; --accent:#0b7aff; }
  * { box-sizing: border-box; }
  html, body { margin:0; background:var(--bg); color:var(--text); }
  body { font:14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         -webkit-font-smoothing:antialiased; padding:48px 40px 120px; }
  h1 { font-size:19px; font-weight:500; margin:0 0 6px; letter-spacing:-0.01em; }
  h2 { font-size:13px; font-weight:500; margin:0; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); }
  h3 { font-size:14px; font-weight:500; margin:0 0 4px; }
  p { margin:0 0 12px; }
  a { color:var(--accent); }
  code { font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .lede { color:var(--muted); max-width:66ch; margin-bottom:8px; }
  .wrap { max-width:1180px; margin:0 auto; }
  section { margin-top:60px; }
  .head { display:flex; align-items:baseline; gap:14px; padding-bottom:12px; border-bottom:1px solid var(--border); margin-bottom:24px; }
  .head span { color:var(--muted); font-size:12.5px; }
  .note { color:var(--muted); max-width:66ch; }
  .note strong { color:var(--text); font-weight:500; }

  .split { display:grid; grid-template-columns:1fr 1fr; gap:24px; align-items:start; }
  .card { border:1px solid var(--border); border-radius:10px; background:var(--panel); padding:16px; }
  .card h3 { display:flex; align-items:baseline; gap:8px; }
  .tag { font-size:10.5px; letter-spacing:0.06em; text-transform:uppercase; border-radius:999px; padding:1px 8px; }
  .bad { color:#f5a; border:1px solid #f5a4; }
  .good { color:var(--accent); border:1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
  /* The path dump is one enormous unbroken token. Without wrapping it forces the
     grid wider than the viewport and pushes the card it is being compared against
     off the screen — which loses the entire comparison. */
  pre { margin:10px 0 0; padding:12px; background:#080a0e; border:1px solid var(--border); border-radius:8px;
        overflow:auto; max-height:220px; font:11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color:#aeb6c7;
        white-space:pre-wrap; word-break:break-all; }
  .split { min-width:0; }
  .split > .card { min-width:0; }

  .controls { display:flex; flex-wrap:wrap; gap:20px; align-items:center; padding:14px 16px; border:1px solid var(--border);
              border-radius:10px; background:var(--panel); margin-bottom:22px; }
  .controls label { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--muted); }
  .controls input[type=color] { width:28px; height:22px; padding:0; border:1px solid var(--border); border-radius:5px; background:none; }
  .controls select, .controls input[type=number] { background:#080a0e; color:var(--text); border:1px solid var(--border);
              border-radius:6px; padding:4px 7px; font:inherit; font-size:12.5px; }

  .grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; align-items:start; }
  .cell { border:1px solid var(--border); border-radius:8px; overflow:hidden; }
  .cell img { display:block; width:100%; }
  .cellcap { padding:7px 9px; font-size:11.5px; color:var(--muted); border-top:1px solid var(--border); }

  .tuner { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:24px; align-items:start; }
  .tuner .stage { border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  .tuner .stage img { display:block; width:100%; }
  .knobs { border:1px solid var(--border); border-radius:10px; background:var(--panel); padding:14px 16px; }
  .knob { margin-bottom:14px; }
  .knob .k { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-bottom:5px; }
  .knob .k b { color:var(--text); font-weight:500; font:12px ui-monospace, Menlo, monospace; }
  .knob input[type=range] { width:100%; accent-color:var(--accent); }
  .stat { display:flex; gap:18px; font-size:12px; color:var(--muted); margin-top:10px; }
  .stat b { color:var(--text); font-weight:500; }
</style>
</head>
<body>
<div class="wrap">

<h1>Why the decorative lane is code, not a model</h1>
<p class="lede">
  Phase 6.7 has four lanes. This page is about lane two — grainy gradients, grain overlays, halftones,
  patterns, shapes, section edges. Everything here runs the <em>actual</em> generators from
  <code>src/core/design/asset-library/generators.ts</code>, bundled into this file. Nothing is a screenshot,
  so every claim below is something you can drag a control and check.
</p>

<section>
  <div class="head"><h2>1. The alternative</h2><span>what a model hands you for the same request</span></div>
  <p class="note" style="margin-bottom:20px">
    Ask a model for a decorative SVG and you get path data. It renders. It is also
    <strong>the end of the conversation</strong> — the agent cannot adjust it, the visual editor cannot address
    any part of it, the git diff is meaningless, and a result that is <em>nearly</em> right can only be
    regenerated, never corrected. That last one is the whole problem: this project exists to stop corrections
    evaporating.
  </p>
  <div class="split">
    <div class="card">
      <h3>A model's output <span class="tag bad">not correctable</span></h3>
      <p class="note" style="font-size:13px">What you can change: nothing, without redrawing it by hand.</p>
      <pre id="pathdump"></pre>
    </div>
    <div class="card">
      <h3>A generator call <span class="tag good">a parameter set</span></h3>
      <p class="note" style="font-size:13px">What you can change: every line below, and the picture follows.</p>
      <pre id="paramdump"></pre>
    </div>
  </div>
</section>

<section>
  <div class="head"><h2>2. Tunable after the fact</h2><span>drag anything — this is Phase 8's parameter model arriving early</span></div>
  <p class="note" style="margin-bottom:20px">
    This is the argument. A parameter set can be <strong>corrected</strong>: nudged, re-run, diffed, and
    promoted into a rule. A path string can only be thrown away. Pick a generator and move the sliders.
  </p>
  <div class="tuner">
    <div>
      <div class="stage" id="stage"></div>
      <div class="stat">
        <span>bytes <b id="bytes">—</b></span>
        <span>seed <b id="seedout">—</b></span>
        <span>re-run with the same seed <b id="determ">—</b></span>
      </div>
    </div>
    <div class="knobs">
      <div class="knob">
        <div class="k"><span>Generator</span></div>
        <select id="gen" style="width:100%;background:#080a0e;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font:inherit;font-size:12.5px"></select>
      </div>
      <div id="knobs"></div>
      <div class="knob">
        <div class="k"><span>Seed</span><b id="seedlabel">1</b></div>
        <input type="range" id="seed" min="0" max="60" step="1" value="1">
      </div>
    </div>
  </div>
</section>

<section>
  <div class="head"><h2>3. It reads your foundation</h2><span>change the project, every recipe follows — with no API call</span></div>
  <p class="note" style="margin-bottom:18px">
    Each picture below is a curated recipe rendered against the foundation in the bar. Change the surface or the
    brand colour and <strong>all of them re-render instantly</strong>. This is the first point in the codebase where
    <code>foundation.json</code> <em>produces</em> something rather than describing it. Doing the same with a model
    means one paid call per asset per change.
  </p>
  <div class="controls">
    <label>Surface
      <select id="surface"><option value="light">light</option><option value="dark">dark</option></select>
    </label>
    <label>Brand <input type="color" id="brand" value="#2563eb"></label>
    <label>Neutrals
      <select id="neutral">
        <option value="cool">cool</option><option value="warm">warm</option>
        <option value="true">true</option><option value="slight-tint">slight-tint</option>
      </select>
    </label>
    <label>Variant <input type="number" id="variant" min="0" max="11" value="0" style="width:60px"></label>
    <span class="note" style="font-size:12px" id="rendertime"></span>
  </div>
  <div class="grid" id="recipes"></div>
</section>

<section>
  <div class="head"><h2>4. Why free matters here</h2><span>generate-and-pick stops being a cost decision</span></div>
  <p class="note">
    Twelve variants is twelve integers. Below is one recipe at twelve seeds, rendered in the time it took this
    page to lay out. On the paid lane the same screen is twelve API calls, about three minutes, and real money —
    which is why that lane shows four and this one can show as many as are useful.
    <strong>The point is not that it is cheap. The point is that a surface which needs a wall of options to work
    can have one.</strong>
  </p>
  <div class="grid" id="twelve" style="grid-template-columns:repeat(6,1fr);margin-top:20px"></div>
</section>

<section>
  <div class="head"><h2>5. What it is not for</h2><span>the honest limits</span></div>
  <p class="note">
    This lane makes <strong>decoration</strong>: things that sit behind or beside content. It does not make
    photographs (lane 1, Gemini, paid), icon sets (lane 3, curated open sets, installed as source) or logos
    (lane 4, a model authoring SVG inside a render-and-look-again loop). Asking it for any of those would be the
    same mistake in the opposite direction — it has no subject matter, only parameters.
  </p>
</section>

</div>
<script>${script}</script>
<script>
(() => {
  const { GENERATORS, runGenerator, derivePalette, ASSET_RECIPES, foundation, composeVariants } = window.CARET

  const url = (svg) => "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)))
  const el = (id) => document.getElementById(id)

  /* ---- current foundation ------------------------------------------- */
  const tokensNow = () => foundation({
    brand: el("brand").value,
    neutral: el("neutral").value,
    surface: el("surface").value,
  })

  /* ---- 1. the comparison -------------------------------------------- */
  // A real path string from a real generator, so the comparison is not a straw man.
  const blob = runGenerator("organic-shape", {
    palette: derivePalette(tokensNow()), width: 1200, height: 1200, seed: 9, params: {},
  })
  const d = (blob.match(/ d="([^"]+)"/) || [])[1] || ""
  el("pathdump").textContent = 'd="' + d + '"'
  el("paramdump").textContent = JSON.stringify(
    { generatorId: "organic-shape", params: { points: 7, wobble: 0.24, opacity: 0.9 }, seed: 9 }, null, 2)

  /* ---- 2. the tuner -------------------------------------------------- */
  const genSelect = el("gen")
  for (const g of GENERATORS) {
    const option = document.createElement("option")
    option.value = g.id
    option.textContent = g.name + " — " + g.produces
    genSelect.appendChild(option)
  }

  let current = GENERATORS[0]
  const params = {}

  function buildKnobs() {
    el("knobs").innerHTML = ""
    for (const [key, spec] of Object.entries(current.params)) {
      params[key] = params[key] ?? spec.default
      const wrap = document.createElement("div")
      wrap.className = "knob"
      wrap.innerHTML =
        '<div class="k"><span>' + spec.label + '</span><b data-v="' + key + '"></b></div>' +
        '<input type="range" min="' + spec.min + '" max="' + spec.max + '" step="' + spec.step + '" value="' + params[key] + '">'
      const input = wrap.querySelector("input")
      input.addEventListener("input", () => { params[key] = Number(input.value); paint() })
      el("knobs").appendChild(wrap)
    }
  }

  function paint() {
    const seed = Number(el("seed").value)
    const palette = derivePalette(tokensNow())
    const svg = runGenerator(current.id, { palette, width: 1200, height: 675, seed, params })
    const again = runGenerator(current.id, { palette, width: 1200, height: 675, seed, params })

    el("stage").style.background = palette.surface
    el("stage").innerHTML = '<img alt="" src="' + url(svg) + '">'
    el("bytes").textContent = new Blob([svg]).size.toLocaleString()
    el("seedout").textContent = String(seed)
    el("determ").textContent = svg === again ? "byte-identical" : "DIFFERENT — bug"
    el("seedlabel").textContent = String(seed)
    for (const [key, value] of Object.entries(params)) {
      const out = document.querySelector('[data-v="' + key + '"]')
      if (out) out.textContent = String(Math.round(value * 100) / 100)
    }
  }

  genSelect.addEventListener("change", () => {
    current = GENERATORS.find((g) => g.id === genSelect.value)
    for (const key of Object.keys(params)) delete params[key]
    buildKnobs(); paint()
  })
  el("seed").addEventListener("input", paint)

  /* ---- 3. the recipe wall -------------------------------------------- */
  function paintRecipes() {
    const started = performance.now()
    const tokens = tokensNow()
    const variant = Number(el("variant").value)
    const container = el("recipes")
    container.innerHTML = ""

    for (const recipe of ASSET_RECIPES) {
      const [v] = composeVariants({ recipe, tokens, count: variant + 1 }).slice(variant)
      if (!v || !v.svg) continue
      const cell = document.createElement("div")
      cell.className = "cell"
      cell.innerHTML =
        '<div style="background:' + derivePalette(tokens).surface + '"><img alt="" src="' + url(v.svg) + '"></div>' +
        '<div class="cellcap">' + recipe.name + '</div>'
      container.appendChild(cell)
    }
    el("rendertime").textContent =
      ASSET_RECIPES.length + " recipes re-rendered in " + Math.round(performance.now() - started) + "ms, offline"
  }

  /* ---- 4. twelve seeds ----------------------------------------------- */
  function paintTwelve() {
    const tokens = tokensNow()
    const palette = derivePalette(tokens)
    const container = el("twelve")
    container.innerHTML = ""
    for (let seed = 0; seed < 12; seed++) {
      const svg = runGenerator("mesh-gradient", { palette, width: 800, height: 500, seed: seed * 7 + 3, params: {} })
      const cell = document.createElement("div")
      cell.className = "cell"
      cell.innerHTML = '<img alt="" src="' + url(svg) + '">'
      container.appendChild(cell)
    }
  }

  for (const id of ["surface", "brand", "neutral", "variant"]) {
    el(id).addEventListener("input", () => { paintRecipes(); paintTwelve(); paint() })
  }

  buildKnobs(); paint(); paintRecipes(); paintTwelve()
})()
</script>
</body>
</html>
`
}

async function main(): Promise<void> {
	const script = await bundle()
	await fs.mkdir(path.dirname(out), { recursive: true })
	await fs.writeFile(out, page(script), "utf-8")
	console.log(`wrote ${out} (${Math.round((await fs.stat(out)).size / 1024)}KB)`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
