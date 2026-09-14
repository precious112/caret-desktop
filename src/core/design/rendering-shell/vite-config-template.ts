import * as fs from "fs/promises"
import * as path from "path"

/**
 * The generated `vite.config.ts`, as a string. Exported (not inlined into the
 * writer) so the healer can compare a live config against what Caret would
 * generate and restore it the moment something else rewrites it.
 */
export function viteConfigSource(): string {
	return `import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react-swc"
import { resolve, join, relative, isAbsolute } from "path"
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, utimesSync } from "fs"

// Directory-based routing plugin with page watching
function caretRouterPlugin() {
  const pagesDir = resolve(__dirname, "pages")

  function buildModule() {
    if (!existsSync(pagesDir)) {
      // Still self-accepting: the first page added to an empty project must
      // hot-swap in, and it is the OLD module's accept that permits that.
      return "export const routes = []\\nexport const pageMetas = []\\nif (import.meta.hot) { import.meta.hot.accept() }"
    }
    const allDirs = readdirSync(pagesDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
    // A page dir without index.tsx is broken AI output. Importing it would
    // break this whole module (and with it every page on the canvas), so only
    // import intact pages and mark the rest so the canvas can flag them.
    const pages = allDirs.filter(p => existsSync(join(pagesDir, p, "index.tsx")))
    const broken = allDirs.filter(p => !existsSync(join(pagesDir, p, "index.tsx")))

    // Loaders, never static imports — and never React.lazy either; both wrong
    // answers have now been measured. The existsSync guard above only covers a
    // page whose file is MISSING; a page whose file exists but imports a file
    // that does not (a catalog piece the budget refused) fails at transform,
    // and with static imports that failure was the router's own — HMR
    // re-evaluated this module into the error and every page on the canvas
    // died at once (a certification run lost ce, bq and by to one refused
    // \`pixel-trail\` import). React.lazy fixed that and broke three OTHER
    // scenarios: a lazy component inside Suspense commits an EMPTY frame
    // before the chunk lands, and every probe keyed on "the frame has content"
    // raced that null commit (the next run lost bz, bo and br to it). So the
    // route carries a loader, and the entry AWAITS it before mounting: the
    // router always evaluates, a broken page rejects in the one document that
    // renders it, and first paint is the whole page — exactly the timing the
    // static imports had.
    const routeEntries = pages.map(p => \`  { path: "/\${p}", name: "\${p}", loader: () => import("./pages/\${p}/index.tsx") }\`).join(",\\n")

    const metas = allDirs.map(p => {
      const isBroken = broken.includes(p)
      try {
        const metaPath = join(pagesDir, p, "meta.json")
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"))
        // The directory wins, it does not merely fill in. \`routes[].name\` is the
        // directory, and the canvas decides a card is openable with
        // \`routes.some(r => r.name === page.id)\` — so a meta.json whose id
        // disagreed with its folder produced a page that rendered and
        // thumbnailed perfectly and silently could not be opened. The folder is
        // the real identity anyway: it is the import path and the URL, so an id
        // that differs also breaks \`<a href="/id">\`, flow steps and screenshots.
        return JSON.stringify({ ...meta, id: p, ...(isBroken ? { broken: true } : {}) })
      } catch {
        return JSON.stringify({ id: p, title: p, type: "page", states: [], tags: [], ...(isBroken ? { broken: true } : {}) })
      }
    })
    const metaEntries = metas.map(m => \`  \${m}\`).join(",\\n")

    // Self-accepting, and it announces itself: every (re-)evaluation hands the
    // document the current routes, so the canvas can hold them as live state
    // instead of a frozen import. Without the announcement, HMR re-evaluates
    // the module into the void and the stale array wins anyway.
    const hmrTail = 'if (import.meta.hot) { import.meta.hot.accept() }\\n' +
      'if (typeof window !== "undefined") { window.dispatchEvent(new CustomEvent("caret:routes-updated", { detail: { routes, pageMetas } })) }'

    return \`export const routes = [\\n\${routeEntries}\\n]\\nexport const pageMetas = [\\n\${metaEntries}\\n]\\n\${hmrTail}\`
  }

  return {
    name: "caret-router",
    resolveId(id) {
      if (id === "virtual:caret-router") return "\\0virtual:caret-router"
      return null
    },
    load(id) {
      if (id === "\\0virtual:caret-router") return buildModule()
      return null
    },
    configureServer(server) {
      // \`reloadModule\`, not bare invalidation. Invalidating only marks the
      // module stale for the NEXT importer; the canvas imported \`routes\` once,
      // statically, so nothing ever re-imported it — a page added mid-session
      // rendered its thumbnail (metas refresh over REST) but was unclickable,
      // because \`hasRoute\` consulted the frozen array. reloadModule pushes an
      // HMR update, the self-accepting module re-evaluates, and it announces
      // its fresh routes to the document (see buildModule's tail).
      const reloadRouter = () => {
        const mod = server.moduleGraph.getModuleById("\\0virtual:caret-router")
        if (mod) server.reloadModule(mod).catch(() => {})
        server.ws.send({ type: "custom", event: "caret:pages-changed" })
      }
      server.watcher.on("addDir", (p) => {
        if (p.startsWith(pagesDir) && p !== pagesDir) reloadRouter()
      })
      server.watcher.on("unlinkDir", (p) => {
        if (p.startsWith(pagesDir) && p !== pagesDir) reloadRouter()
      })
      server.watcher.on("change", (p) => {
        if (p.endsWith("meta.json") && p.includes(pagesDir)) {
          server.ws.send({ type: "custom", event: "caret:pages-changed" })
        }
      })
      // index.tsx appearing/disappearing changes which pages are importable —
      // without this, a deleted page file never invalidates the router module.
      const handleIndexFile = (p) => {
        if (p.startsWith(pagesDir) && p.endsWith("index.tsx")) reloadRouter()
      }
      server.watcher.on("add", handleIndexFile)
      server.watcher.on("unlink", handleIndexFile)

      // Every design-source change is announced on the wire. HMR propagation
      // stops at this self-accepting module, so a document stuck on an error
      // card never receives an update — it listens for this event instead and
      // reloads itself (see main.tsx). "add" matters as much as "change": the
      // fix for a broken import is often the created file it was pointing at.
      const sourceRoots = ["pages", "components", "layouts", "lib"].map((d) => resolve(__dirname, d))
      const announceSourceChange = (p) => {
        if (!/\\.(tsx|jsx|ts|css)$/.test(p)) return
        if (!sourceRoots.some((dir) => p.startsWith(dir))) return
        server.ws.send({ type: "custom", event: "caret:source-changed" })
      }
      server.watcher.on("change", announceSourceChange)
      server.watcher.on("add", announceSourceChange)
    },
  }
}

// Tailwind's scan set is built when global.css transforms, and only files it
// has already seen re-trigger that transform. A page CREATED after the server
// started therefore renders with none of its new utility classes — measured
// live: an agent-written page's \`p-8\` and \`left-[190px]\` produced no CSS at
// all until some boot-time file happened to change. Touching the stylesheet
// when a source file appears forces the re-transform, whose re-scan then
// includes the newcomer; edits after that are tracked normally.
function caretTailwindFreshPlugin() {
  const cssPath = resolve(__dirname, "global.css")
  const sourceDirs = ["pages", "components", "layouts", "lib"].map((d) => resolve(__dirname, d))
  const variantsPath = resolve(__dirname, ".variants.json")
  const takeSourcesPath = resolve(__dirname, "caret-take-sources.css")

  // Playground take pages are gitignored (pages/*--v*/), and Tailwind's
  // scanner honours .gitignore even under an explicit @source glob — so a
  // take's classes would silently produce no CSS and every take would render
  // half-styled. A per-FILE @source does bypass the ignore (measured on the
  // pinned version by scripts/probe-take-css.ts), so this keeps one @source
  // line per open take in a stylesheet global.css imports. Writing it is what
  // triggers Tailwind's re-scan, so no extra nudge is needed.
  const syncTakeSources = () => {
    let lines = ""
    try {
      const raw = JSON.parse(readFileSync(variantsPath, "utf-8"))
      const nodes = Array.isArray(raw?.nodes) ? raw.nodes : []
      lines = nodes
        .filter((n) => typeof n?.id === "string" && /^[A-Za-z0-9_-]+$/.test(n.id))
        .map((n) => \`@source "./pages/\${n.id}/index.tsx";\`)
        .join("\\n")
    } catch {}
    const content = "/* Generated: @source lines for open playground takes — see caret-tailwind-fresh. */\\n" + lines + "\\n"
    try {
      if (existsSync(takeSourcesPath) && readFileSync(takeSourcesPath, "utf-8") === content) return
      writeFileSync(takeSourcesPath, content)
    } catch {}
  }

  return {
    name: "caret-tailwind-fresh",
    configureServer(server) {
      // A restart mid-exploration must come back styled: rebuild before the
      // first transform reads global.css.
      syncTakeSources()
      server.watcher.on("add", (p) => {
        if (p === variantsPath) return syncTakeSources()
        if (!p.endsWith(".tsx") && !p.endsWith(".jsx")) return
        if (!sourceDirs.some((dir) => p.startsWith(dir))) return
        try {
          const now = new Date()
          utimesSync(cssPath, now, now)
        } catch {}
      })
      server.watcher.on("change", (p) => {
        if (p === variantsPath) syncTakeSources()
      })
      server.watcher.on("unlink", (p) => {
        if (p === variantsPath) syncTakeSources()
      })
    },
  }
}

// Virtual module for foundation tokens
function caretTokensPlugin() {
  const tokensPath = resolve(__dirname, "tokens/foundation.json")
  return {
    name: "caret-tokens",
    resolveId(id) {
      if (id === "virtual:caret-tokens") return "\\0virtual:caret-tokens"
      return null
    },
    load(id) {
      if (id === "\\0virtual:caret-tokens") {
        try {
          const content = readFileSync(tokensPath, "utf-8")
          return \`export default \${content}\`
        } catch {
          return "export default {}"
        }
      }
      return null
    },
    handleHotUpdate({ file, server }) {
      if (file === tokensPath) {
        const mod = server.moduleGraph.getModuleById("\\0virtual:caret-tokens")
        if (mod) {
          server.moduleGraph.invalidateModule(mod)
          server.ws.send({ type: "full-reload" })
          server.ws.send({ type: "custom", event: "caret:tokens-changed" })
        }
      }
    },
  }
}

// Reads flow files, replacing corrupt/invalid ones with visible placeholder
// entries instead of silently dropping them — a flow vanishing without signal
// reads as data loss, while an "invalid" chip points at the broken file.
function readFlowsForServing(flowsDir) {
  if (!existsSync(flowsDir)) return []
  let files = []
  try { files = readdirSync(flowsDir).filter(f => f.endsWith(".flow.json")) } catch { return [] }
  const isValidFlowShape = (flow) =>
    !!flow && typeof flow === "object" &&
    typeof flow.id === "string" && typeof flow.name === "string" && Array.isArray(flow.steps) &&
    flow.steps.every(s => s && typeof s === "object" && typeof s.page === "string" && Array.isArray(s.next) && (s.onError === undefined || Array.isArray(s.onError)))
  return files.map(f => {
    try {
      const flow = JSON.parse(readFileSync(join(flowsDir, f), "utf-8"))
      if (!isValidFlowShape(flow)) {
        return { id: "invalid:" + f, name: f, steps: [], invalid: true, error: "Invalid flow shape — needs id, name and steps[] with page/next" }
      }
      return flow
    } catch (e) {
      return { id: "invalid:" + f, name: f, steps: [], invalid: true, error: String(e) }
    }
  })
}

// Virtual module for flow definitions
function caretFlowsPlugin() {
  const flowsDir = resolve(__dirname, "flows")

  function buildModule() {
    try {
      return "export default " + JSON.stringify(readFlowsForServing(flowsDir))
    } catch {
      return "export default []"
    }
  }

  return {
    name: "caret-flows",
    resolveId(id) {
      if (id === "virtual:caret-flows") return "\\0virtual:caret-flows"
      return null
    },
    load(id) {
      if (id === "\\0virtual:caret-flows") return buildModule()
      return null
    },
    configureServer(server) {
      if (existsSync(flowsDir)) server.watcher.add(flowsDir)
      const handleFlowChange = (p) => {
        if (p.endsWith(".flow.json")) {
          server.ws.send({ type: "custom", event: "caret:flows-changed" })
        }
      }
      server.watcher.on("change", handleFlowChange)
      server.watcher.on("add", handleFlowChange)
      server.watcher.on("unlink", handleFlowChange)
    },
  }
}

// Screenshot + pages-meta + canvas-layout API middleware
function caretApiPlugin() {
  const thumbnailsDir = resolve(__dirname, "thumbnails")
  const pagesDir = resolve(__dirname, "pages")
  const layoutPath = resolve(__dirname, "canvas-layout.json")

  return {
    name: "caret-api",
    configureServer(server) {
      // The variant set changing (takes finishing, the pick resolving) is
      // pushed rather than polled — the compare surface has to show a take
      // the moment it lands.
      const variantsPath = resolve(__dirname, ".variants.json")
      const checksPath = resolve(__dirname, ".checks-results.json")
      const announceScratch = (p) => {
        if (p === variantsPath) server.ws.send({ type: "custom", event: "caret:variants-changed" })
        if (p === checksPath) server.ws.send({ type: "custom", event: "caret:checks-changed" })
      }
      server.watcher.on("add", announceScratch)
      server.watcher.on("change", announceScratch)
      server.watcher.on("unlink", announceScratch)

      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/__caret/")) return next()

        // Image proxy for cross-origin screenshot capture
        if (req.method === "GET" && req.url.startsWith("/__caret/image-proxy?")) {
          const params = new URL(req.url, "http://localhost").searchParams
          const imageUrl = params.get("url")
          if (!imageUrl) { res.statusCode = 400; res.end("missing url"); return }
          try {
            const resp = await fetch(imageUrl)
            if (!resp.ok) { res.statusCode = resp.status; res.end("fetch failed"); return }
            const buffer = Buffer.from(await resp.arrayBuffer())
            res.setHeader("Content-Type", resp.headers.get("content-type") || "image/png")
            res.setHeader("Cache-Control", "public, max-age=3600")
            res.end(buffer)
          } catch (e) {
            res.statusCode = 502
            res.end(String(e))
          }
          return
        }

        // GET/PUT /__caret/canvas-layout
        if (req.url === "/__caret/canvas-layout") {
          if (req.method === "GET") {
            try {
              const data = existsSync(layoutPath) ? readFileSync(layoutPath, "utf-8") : "{}"
              res.setHeader("Content-Type", "application/json")
              res.end(data)
            } catch {
              res.setHeader("Content-Type", "application/json")
              res.end("{}")
            }
            return
          }
          if (req.method === "PUT") {
            let body = ""
            req.on("data", chunk => { body += chunk })
            req.on("end", () => {
              try {
                // Validate before persisting: a garbage write here would
                // silently reset the layout on the next canvas load.
                const layout = JSON.parse(body)
                const validMode = layout && (layout.mode === "auto" || layout.mode === "manual")
                const positions = layout && layout.positions
                const validPositions = positions && typeof positions === "object" &&
                  Object.values(positions).every(p => p && typeof p === "object" && Number.isFinite(p.x) && Number.isFinite(p.y))
                if (!validMode || !validPositions) {
                  res.statusCode = 400
                  res.end("invalid canvas layout payload")
                  return
                }
                const tmpPath = layoutPath + ".tmp"
                writeFileSync(tmpPath, JSON.stringify(layout, null, 2))
                renameSync(tmpPath, layoutPath)
                res.statusCode = 200
                res.end("ok")
              } catch (e) {
                res.statusCode = 400
                res.end(String(e))
              }
            })
            return
          }
        }

        // GET /__caret/pages-meta
        if (req.method === "GET" && req.url === "/__caret/pages-meta") {
          try {
            const pages = existsSync(pagesDir)
              ? readdirSync(pagesDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
              : []
            const metas = pages.map(p => {
              const isBroken = !existsSync(join(pagesDir, p, "index.tsx"))
              let meta
              try {
                meta = JSON.parse(readFileSync(join(pagesDir, p, "meta.json"), "utf-8"))
                // The directory is the identity — see the router plugin above.
                meta.id = p
              } catch {
                meta = { id: p, title: p, type: "page", states: [], tags: [] }
              }
              if (isBroken) meta.broken = true
              return meta
            })
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify(metas))
          } catch {
            res.statusCode = 500
            res.end("[]")
          }
          return
        }

        // GET /__caret/assets-index
        // What the @ picker autocompletes over. Read fresh on every request
        // rather than cached: an asset added in the library while the canvas is
        // open has to be typeable immediately, and a picker that shows a stale
        // list is worse than none — the user names a tag that resolves to
        // nothing and the agent is told to invent it.
        if (req.method === "GET" && req.url === "/__caret/assets-index") {
          try {
            const raw = readFileSync(resolve(__dirname, "assets", "index.json"), "utf-8")
            const parsed = JSON.parse(raw)
            const assets = Array.isArray(parsed?.assets) ? parsed.assets : []
            res.setHeader("Content-Type", "application/json")
            res.setHeader("Cache-Control", "no-store")
            res.end(JSON.stringify({ version: 1, assets }))
          } catch {
            // No assets yet is the normal state of a new project, not an error.
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify({ version: 1, assets: [] }))
          }
          return
        }

        // GET /__caret/checks — the latest design-check results per page.
        if (req.method === "GET" && req.url === "/__caret/checks") {
          try {
            const raw = readFileSync(resolve(__dirname, ".checks-results.json"), "utf-8")
            res.setHeader("Content-Type", "application/json")
            res.setHeader("Cache-Control", "no-store")
            res.end(raw)
          } catch {
            res.setHeader("Content-Type", "application/json")
            res.setHeader("Cache-Control", "no-store")
            res.end(JSON.stringify({ version: 1, pages: [] }))
          }
          return
        }

        // GET /__caret/variants — the open generate-and-pick set, if any.
        // Read fresh per request: the host rewrites it as takes finish.
        if (req.method === "GET" && req.url === "/__caret/variants") {
          try {
            const raw = readFileSync(resolve(__dirname, ".variants.json"), "utf-8")
            res.setHeader("Content-Type", "application/json")
            res.setHeader("Cache-Control", "no-store")
            res.end(raw)
          } catch {
            res.setHeader("Content-Type", "application/json")
            res.setHeader("Cache-Control", "no-store")
            res.end("null")
          }
          return
        }

        // GET /__caret/flows-meta
        if (req.method === "GET" && req.url === "/__caret/flows-meta") {
          const flowsDir = resolve(__dirname, "flows")
          try {
            res.setHeader("Content-Type", "application/json")
            res.end(JSON.stringify(readFlowsForServing(flowsDir)))
          } catch {
            res.statusCode = 500
            res.end("[]")
          }
          return
        }

        // Screenshot endpoints: /__caret/screenshots/:pageId
        const screenshotMatch = req.url.match(/^\\/__caret\\/screenshots\\/([^?/]+)/)
        if (!screenshotMatch) return next()
        const pageId = decodeURIComponent(screenshotMatch[1])
        const filePath = join(thumbnailsDir, \`\${pageId}.png\`)

        if (req.method === "POST") {
          let body = ""
          req.on("data", chunk => { body += chunk })
          req.on("end", () => {
            try {
              const { dataUrl } = JSON.parse(body)
              const base64 = dataUrl.replace(/^data:image\\/png;base64,/, "")
              mkdirSync(thumbnailsDir, { recursive: true })
              writeFileSync(filePath, Buffer.from(base64, "base64"))
              res.statusCode = 200
              res.end("ok")
            } catch (e) {
              res.statusCode = 500
              res.end(String(e))
            }
          })
          return
        }

        if (req.method === "GET") {
          try {
            if (!existsSync(filePath)) {
              res.statusCode = 404
              res.end("not found")
              return
            }
            const data = readFileSync(filePath)
            res.setHeader("Content-Type", "image/png")
            res.setHeader("Cache-Control", "no-cache")
            res.end(data)
          } catch {
            res.statusCode = 500
            res.end("error")
          }
          return
        }

        next()
      })

      // Watch thumbnails dir for changes
      server.watcher.add(thumbnailsDir)
      server.watcher.on("change", (p) => {
        if (p.startsWith(thumbnailsDir) && p.endsWith(".png")) {
          const pageId = p.slice(thumbnailsDir.length + 1).replace(".png", "")
          server.ws.send({ type: "custom", event: "caret:thumbnail-updated", data: { pageId } })
        }
      })
    },
  }
}

// Captures SWC's __source arg from jsxDEV calls into a global WeakMap.
// SWC passes {fileName, lineNumber, columnNumber} as the 5th arg to jsxDEV.
// React 19 ignores it, but we intercept it for exact source locations.
// Implemented by shimming the react/jsx-dev-runtime MODULE rather than
// regex-rewriting transformed source: text matching silently broke for any
// file whose import also pulled in Fragment (i.e. files using <>...</>),
// which made element->source resolution fall back to drifted stack lines.
function caretSourceCapturePlugin() {
  const SHIM_ID = "\\0caret-jsx-dev-shim"
  return {
    name: "caret-source-capture",
    enforce: "pre" as const,
    resolveId(source: string, importer: string | undefined) {
      if (source !== "react/jsx-dev-runtime") return null
      if (!importer || importer === SHIM_ID) return null
      if (!importer.endsWith(".tsx") && !importer.endsWith(".jsx")) return null
      return SHIM_ID
    },
    load(id: string) {
      if (id !== SHIM_ID) return null
      return [
        'import * as __runtime from "react/jsx-dev-runtime"',
        "export const Fragment = __runtime.Fragment",
        "export const jsxDEV = (t, p, k, s, src, self) => {",
        '  if (src && p && typeof p === "object") (window.__caretSourceMap || (window.__caretSourceMap = new WeakMap())).set(p, src)',
        "  return __runtime.jsxDEV(t, p, k, s, src, self)",
        "}",
      ].join("\\n")
    },
  }
}

// Serves .caret/assets/ at /caret-assets/, so a page can reference an asset by a
// stable path with no build step and no import. Vite's own publicDir is already
// spoken for by the shell, and this keeps assets addressable by the same URL the
// index records — which is what makes an @tag expansion mean one thing to the
// canvas, the agent and the synced app alike.
function caretAssetsPlugin() {
  const PREFIX = "/caret-assets/"
  const MIME: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  }

  return {
    name: "caret-assets",
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        const url = (req.url || "").split("?")[0]
        if (!url.startsWith(PREFIX)) return next()

        // Decoded first, then confined to the assets directory — "%2e%2e%2f" is
        // still traversal after decoding, and the check has to happen after.
        const name = decodeURIComponent(url.slice(PREFIX.length))
        const root = resolve(__dirname, "assets")
        const file = resolve(root, name)
        // relative(), never a string-prefix test: on Windows resolve() returns
        // backslash paths, so a root + "/" prefix check matched nothing and
        // every asset 403'd. An escape shows up as ".." or an absolute path.
        const escape = relative(root, file)
        if (escape.startsWith("..") || isAbsolute(escape)) {
          res.statusCode = 403
          return res.end("forbidden")
        }

        try {
          const body = readFileSync(file)
          const extension = name.slice(name.lastIndexOf(".")).toLowerCase()
          res.setHeader("Content-Type", MIME[extension] || "application/octet-stream")
          // No caching: an asset replaced in place must show the new bytes on the
          // next reload, or the canvas lies about what the project contains.
          res.setHeader("Cache-Control", "no-store")
          return res.end(body)
        } catch {
          res.statusCode = 404
          return res.end("not found")
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [tailwindcss(), react(), caretSourceCapturePlugin(), caretRouterPlugin(), caretTailwindFreshPlugin(), caretTokensPlugin(), caretFlowsPlugin(), caretApiPlugin(), caretAssetsPlugin()],
  server: {
    host: "localhost",
    strictPort: false,
  },
  resolve: {
    alias: {
      "@caret": resolve(__dirname),
    },
  },
})
`
}

export async function generateViteConfig(caretDir: string): Promise<void> {
	await fs.writeFile(path.join(caretDir, "vite.config.ts"), viteConfigSource())
}
