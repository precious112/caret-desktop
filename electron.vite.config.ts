import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import { resolve } from "path"

export default defineConfig({
	main: {
		// Node built-ins and real dependencies stay external: bundling `simple-git`
		// or `chokidar` into the main chunk breaks their native/dynamic bits and
		// gains nothing, since main is never shipped over a network.
		plugins: [externalizeDepsPlugin()],
		resolve: {
			alias: {
				"@": resolve("src"),
				"@shared": resolve("src/shared"),
			},
		},
		build: {
			rollupOptions: {
				input: { index: resolve("desktop/main/index.ts") },
			},
		},
	},

	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: {
					index: resolve("desktop/preload/index.ts"),
					canvas: resolve("desktop/preload/canvas.ts"),
				},
			},
		},
	},

	renderer: {
		root: resolve("desktop/renderer"),
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: {
				"@": resolve("desktop/renderer/src"),
			},
		},
		build: {
			rollupOptions: {
				input: { index: resolve("desktop/renderer/index.html") },
			},
		},
	},
})
