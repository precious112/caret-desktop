/**
 * Typeface lookup for the foundation wizard.
 *
 * The full Google Fonts catalogue needs NO key: fonts.google.com/metadata/fonts
 * is the JSON the Google Fonts site itself renders from, and it lists every
 * family with its weights. A configured API key still works (the developer API
 * serves the same catalogue), but it is not the door to full search — before
 * this, a keyless install silently searched a 20-font bundled list while the
 * UI promised "all of Google Fonts", and a real family like Young Serif looked
 * nonexistent. The bundled list is now strictly the no-network fallback, and
 * every result says which source it came from so the UI can stop impersonating
 * a search it didn't run.
 */
import * as fs from "fs/promises"
import * as path from "path"

import { fetch } from "@/shared/net"

const GOOGLE_FONTS_API = "https://www.googleapis.com/webfonts/v1/webfonts"
const CATALOG_URL = "https://fonts.google.com/metadata/fonts"
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_RESULTS = 30

export interface FontOption {
	family: string
	category: string
	variants: string[]
}

export interface FontSearchResult {
	fonts: FontOption[]
	/** "google-fonts" is the full catalogue; "bundled" means offline, 20 fonts. */
	source: "google-fonts" | "bundled"
}

export interface SearchFontsOptions {
	/** The user's own Google Fonts API key, if they have configured one. */
	apiKey?: string
	/** Where to persist the keyless catalogue so offline sessions keep it. */
	cacheFile?: string
}

export async function searchGoogleFonts(query: string, options: SearchFontsOptions = {}): Promise<FontSearchResult> {
	const needle = query.toLowerCase().trim()
	const apiKey = options.apiKey?.trim() || process.env.GOOGLE_FONTS_API_KEY

	if (apiKey) {
		try {
			const response = await fetch(`${GOOGLE_FONTS_API}?key=${apiKey}&sort=popularity`)
			if (response.ok) {
				const data = (await response.json()) as { items?: FontOption[] }
				return { fonts: filterFonts(data.items ?? [], needle), source: "google-fonts" }
			}
		} catch {
			// A rate limit or a bad key falls through to the keyless catalogue,
			// which serves the same families.
		}
	}

	const catalog = await loadCatalog(options.cacheFile)
	if (catalog) return { fonts: filterFonts(catalog, needle), source: "google-fonts" }
	return { fonts: filterFonts(FALLBACK_FONTS, needle), source: "bundled" }
}

function filterFonts(fonts: FontOption[], needle: string): FontOption[] {
	// Prefix matches lead: "young" must put Young Serif above anything that
	// merely contains the letters somewhere.
	const starts = needle ? fonts.filter((f) => f.family.toLowerCase().startsWith(needle)) : fonts
	const contains = needle
		? fonts.filter((f) => !f.family.toLowerCase().startsWith(needle) && f.family.toLowerCase().includes(needle))
		: []
	return [...starts, ...contains].slice(0, MAX_RESULTS).map((f) => ({
		family: f.family,
		category: f.category || "",
		variants: f.variants || [],
	}))
}

/* ── The keyless catalogue ─────────────────────────────────────────────── */

let memoryCatalog: FontOption[] | null = null
let inflight: Promise<FontOption[] | null> | null = null

/** Test-only: forget the cached catalogue so each test controls its source. */
export function resetFontCatalogForTesting(): void {
	memoryCatalog = null
	inflight = null
}

async function loadCatalog(cacheFile?: string): Promise<FontOption[] | null> {
	if (memoryCatalog) return memoryCatalog
	// One download per process even under concurrent searches; a failure clears
	// the slot so a later search can retry rather than caching the outage.
	if (!inflight) {
		inflight = resolveCatalog(cacheFile).finally(() => {
			inflight = null
		})
	}
	return inflight
}

async function resolveCatalog(cacheFile?: string): Promise<FontOption[] | null> {
	const disk = cacheFile ? await readDiskCache(cacheFile) : null
	if (disk && Date.now() - disk.savedAt < CATALOG_TTL_MS) {
		memoryCatalog = disk.fonts
		return disk.fonts
	}

	try {
		const response = await fetch(CATALOG_URL)
		if (!response.ok) throw new Error(`catalog fetch failed: ${response.status}`)
		const text = await response.text()
		// The endpoint historically carried an anti-JSON-hijack prefix.
		const fonts = parseCatalog(JSON.parse(text.replace(/^\)\]\}'/, "")))
		if (fonts.length > 0) {
			memoryCatalog = fonts
			if (cacheFile) await writeDiskCache(cacheFile, fonts)
			return fonts
		}
	} catch {
		// No network. A stale disk catalogue still beats the bundled 20.
	}

	if (disk) {
		memoryCatalog = disk.fonts
		return disk.fonts
	}
	return null
}

function parseCatalog(data: unknown): FontOption[] {
	const list = (data as { familyMetadataList?: unknown[] })?.familyMetadataList
	if (!Array.isArray(list)) return []
	const mapped: Array<FontOption & { popularity: number }> = []
	for (const entry of list) {
		const f = entry as { family?: string; category?: string; fonts?: Record<string, unknown>; popularity?: number }
		const family = typeof f.family === "string" ? f.family : ""
		// Weight keys look like "400" and "400i"; italics collapse into the weight.
		const variants = [...new Set(Object.keys(f.fonts ?? {}).map((w) => w.replace(/i$/, "")))]
			.filter((w) => /^\d+$/.test(w))
			.sort((a, b) => Number(a) - Number(b))
		if (!family || variants.length === 0) continue
		mapped.push({
			family,
			category: String(f.category ?? "")
				.toLowerCase()
				.replace(/\s+/g, "-"),
			variants,
			popularity: typeof f.popularity === "number" ? f.popularity : Number.MAX_SAFE_INTEGER,
		})
	}
	// The list arrives alphabetical; an empty query should surface popular
	// families, matching the keyed API's sort=popularity behaviour.
	mapped.sort((a, b) => a.popularity - b.popularity)
	return mapped.map(({ popularity: _popularity, ...font }) => font)
}

interface DiskCatalog {
	savedAt: number
	fonts: FontOption[]
}

async function readDiskCache(cacheFile: string): Promise<DiskCatalog | null> {
	try {
		const parsed = JSON.parse(await fs.readFile(cacheFile, "utf-8")) as DiskCatalog
		if (typeof parsed?.savedAt !== "number" || !Array.isArray(parsed?.fonts) || parsed.fonts.length === 0) return null
		return parsed
	} catch {
		return null
	}
}

async function writeDiskCache(cacheFile: string, fonts: FontOption[]): Promise<void> {
	try {
		await fs.mkdir(path.dirname(cacheFile), { recursive: true })
		const payload: DiskCatalog = { savedAt: Date.now(), fonts }
		await fs.writeFile(cacheFile, JSON.stringify(payload))
	} catch {
		// A read-only disk only costs the next session a re-download.
	}
}

/* ── The true offline fallback ─────────────────────────────────────────── */

const FALLBACK_FONTS: FontOption[] = [
	{ family: "Inter", category: "sans-serif", variants: ["400", "500", "600", "700"] },
	{ family: "Roboto", category: "sans-serif", variants: ["300", "400", "500", "700"] },
	{ family: "Open Sans", category: "sans-serif", variants: ["300", "400", "600", "700"] },
	{ family: "Lato", category: "sans-serif", variants: ["300", "400", "700"] },
	{ family: "Montserrat", category: "sans-serif", variants: ["300", "400", "500", "600", "700"] },
	{ family: "Poppins", category: "sans-serif", variants: ["300", "400", "500", "600", "700"] },
	{ family: "Source Sans Pro", category: "sans-serif", variants: ["300", "400", "600", "700"] },
	{ family: "Nunito", category: "sans-serif", variants: ["300", "400", "600", "700"] },
	{ family: "Playfair Display", category: "serif", variants: ["400", "500", "600", "700"] },
	{ family: "Merriweather", category: "serif", variants: ["300", "400", "700"] },
	{ family: "Lora", category: "serif", variants: ["400", "500", "600", "700"] },
	{ family: "PT Serif", category: "serif", variants: ["400", "700"] },
	{ family: "Libre Baskerville", category: "serif", variants: ["400", "700"] },
	{ family: "JetBrains Mono", category: "monospace", variants: ["400", "500", "600", "700"] },
	{ family: "Fira Code", category: "monospace", variants: ["300", "400", "500", "600", "700"] },
	{ family: "Space Mono", category: "monospace", variants: ["400", "700"] },
	{ family: "IBM Plex Mono", category: "monospace", variants: ["300", "400", "500", "600", "700"] },
	{ family: "DM Sans", category: "sans-serif", variants: ["400", "500", "700"] },
	{ family: "Work Sans", category: "sans-serif", variants: ["300", "400", "500", "600", "700"] },
	{ family: "Raleway", category: "sans-serif", variants: ["300", "400", "500", "600", "700"] },
]
