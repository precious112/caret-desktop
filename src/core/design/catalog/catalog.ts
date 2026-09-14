/**
 * The shipped component catalog — the allowlist the user curated (gate
 * resolved 2026-08-12: everything certified fully free; Commons Clause and
 * unlicensed candidates excluded).
 *
 * Two tiers:
 * - **vendored** — MIT source mirrored into Caret's bundle from the pinned
 *   repo SHA (their registries are unreachable or bot-gated from some
 *   networks; the mirror makes the network irrelevant). Installing copies
 *   from the local mirror — zero network at install time.
 * - **registry / npm / cli** — the library's own channel, fetched by Caret's
 *   own proxy-aware fetch (registry) or npm (never a third-party CLI with
 *   write access to the repo; the one `cli` entry is executed with
 *   --no-install-scripts posture and lands plain source).
 *
 * Restraint is part of the data: `signature` marks components that count
 * against the one-signature-move-per-page budget, and `editable` declares the
 * cost the visual editor pays — `full` (plain DOM + Tailwind, inline-editable),
 * `props-only` (canvas/WebGL interior; colours rebind through props), or
 * `opaque`. The rules tell agents to prefer the most editable thing that does
 * the job, and the checker enforces the budget mechanically.
 */

export type CatalogTier = "vendored" | "registry" | "npm" | "cli"
export type EditableGrade = "full" | "props-only" | "opaque"

export interface CatalogComponent {
	/** Kebab-case id, unique within its library. */
	id: string
	/** One line: when to reach for it. This ships in the always-on rules. */
	useWhen: string
	editable: EditableGrade
	/** Counts against the one-signature-move-per-page budget. */
	signature: boolean
	/**
	 * Where the source comes from: vendored → path inside the repo tarball;
	 * registry → the item name in the registry URL template; npm → the named
	 * export to wrap.
	 */
	source: string
	/** Extra npm dependencies beyond the library's base deps. */
	deps?: string[]
}

export interface CatalogLibrary {
	id: string
	name: string
	tier: CatalogTier
	/** SPDX-ish, as verified in the repo. */
	licence: string
	repo?: string
	/** Vendored tier: the exact commit the mirror was taken from. */
	pinnedSha?: string
	/** Registry tier: URL template, `{name}` replaced by the component source. */
	registryTemplate?: string
	/** npm tier: the package to install. */
	npmPackage?: string
	useWhen: string
	/** Deps most of this library's components need. */
	baseDeps?: string[]
	components: CatalogComponent[]
}

export const CATALOG: CatalogLibrary[] = [
	// ── vendored tier ────────────────────────────────────────────────────────
	{
		id: "magicui",
		name: "Magic UI",
		tier: "vendored",
		licence: "MIT",
		repo: "magicuidesign/magicui",
		pinnedSha: "2d671cc6c0e0f40e28682c9cbddd16694dcfe627",
		useWhen: "Animated primitives and set pieces: marquees, tickers, globes, particles, hero accents.",
		baseDeps: ["motion"],
		components: [
			{
				id: "marquee",
				useWhen: "an endless horizontal stream of logos, quotes or cards",
				editable: "full",
				signature: false,
				source: "apps/www/registry/magicui/marquee.tsx",
			},
			{
				id: "globe",
				useWhen: "a spinning WebGL globe for reach/scale claims",
				editable: "props-only",
				signature: true,
				source: "apps/www/registry/magicui/globe.tsx",
				deps: ["cobe"],
			},
			{
				id: "particles",
				useWhen: "a drifting particle field behind a hero",
				editable: "props-only",
				signature: true,
				source: "apps/www/registry/magicui/particles.tsx",
			},
			{
				id: "meteors",
				useWhen: "occasional streaking meteors across a dark section",
				editable: "props-only",
				signature: true,
				source: "apps/www/registry/magicui/meteors.tsx",
			},
			{
				id: "border-beam",
				useWhen: "a slow light tracing a card's border to mark ONE key card",
				editable: "full",
				signature: false,
				source: "apps/www/registry/magicui/border-beam.tsx",
			},
			{
				id: "number-ticker",
				useWhen: "a metric that counts up when it scrolls into view",
				editable: "full",
				signature: false,
				source: "apps/www/registry/magicui/number-ticker.tsx",
			},
			{
				id: "dock",
				useWhen: "a macOS-style magnifying dock of icons or links",
				editable: "full",
				signature: false,
				source: "apps/www/registry/magicui/dock.tsx",
				deps: ["class-variance-authority"],
			},
			{
				id: "warp-background",
				useWhen: "a perspective warp grid background for one dramatic section",
				editable: "props-only",
				signature: true,
				source: "apps/www/registry/magicui/warp-background.tsx",
			},
			{
				id: "retro-grid",
				useWhen: "a scrolling retro perspective grid backdrop",
				editable: "props-only",
				signature: true,
				source: "apps/www/registry/magicui/retro-grid.tsx",
			},
			{
				id: "hyper-text",
				useWhen: "a heading that scrambles into place on hover/reveal",
				editable: "full",
				signature: false,
				source: "apps/www/registry/magicui/hyper-text.tsx",
			},
			{
				id: "morphing-text",
				useWhen: "one headline morphing between phrases",
				editable: "full",
				signature: false,
				source: "apps/www/registry/magicui/morphing-text.tsx",
			},
			{
				id: "sparkles-text",
				useWhen: "sparse sparkles on one short highlighted phrase",
				editable: "full",
				signature: false,
				source: "apps/www/registry/magicui/sparkles-text.tsx",
			},
			{
				id: "smooth-cursor",
				useWhen: "a smoothed custom cursor for a showcase page",
				editable: "props-only",
				signature: true,
				source: "apps/www/registry/magicui/smooth-cursor.tsx",
			},
			{
				id: "aurora-text",
				useWhen: "an aurora gradient sweeping through one headline",
				editable: "full",
				signature: true,
				source: "apps/www/registry/magicui/aurora-text.tsx",
			},
			{
				id: "light-rays",
				useWhen: "soft volumetric light rays behind a dark hero",
				editable: "props-only",
				signature: true,
				source: "apps/www/registry/magicui/light-rays.tsx",
			},
		],
	},
	{
		id: "fancy",
		name: "Fancy Components",
		tier: "vendored",
		licence: "MIT",
		repo: "danielpetho/fancy",
		pinnedSha: "f9f62c61207b2dd3210476dd98af3c9a5be24094",
		useWhen: "Expressive typography and cursor/image physics — the editorial-motion slice.",
		baseDeps: ["motion"],
		components: [
			{
				id: "text-rotate",
				useWhen: "a word in a headline rotating through alternatives",
				editable: "full",
				signature: false,
				source: "src/fancy/components/text/text-rotate.tsx",
			},
			{
				id: "scramble-hover",
				useWhen: "link or label text scrambling on hover",
				editable: "full",
				signature: false,
				source: "src/fancy/components/text/scramble-hover.tsx",
			},
			{
				id: "vertical-cut-reveal",
				useWhen: "lines of copy revealed with a vertical cut",
				editable: "full",
				signature: false,
				source: "src/fancy/components/text/vertical-cut-reveal.tsx",
			},
			{
				id: "letter-3d-swap",
				useWhen: "letters flipping in 3D between two words",
				editable: "full",
				signature: false,
				source: "src/fancy/components/text/letter-3d-swap.tsx",
			},
			{
				id: "text-along-path",
				useWhen: "type set along a drawn SVG path",
				editable: "full",
				signature: true,
				source: "src/fancy/components/text/text-along-path.tsx",
			},
			{
				id: "text-cursor-proximity",
				useWhen: "letters reacting to how close the cursor is",
				editable: "full",
				signature: true,
				source: "src/fancy/components/text/text-cursor-proximity.tsx",
			},
			{
				id: "image-trail",
				useWhen: "images trailing the cursor across a gallery hero",
				editable: "props-only",
				signature: true,
				source: "src/fancy/components/image/image-trail.tsx",
			},
			{
				id: "parallax-floating",
				useWhen: "images floating at different parallax depths",
				editable: "full",
				signature: true,
				source: "src/fancy/components/image/parallax-floating.tsx",
			},
			{
				id: "pixel-trail",
				useWhen: "a pixel wake following the cursor over a section",
				editable: "props-only",
				signature: true,
				source: "src/fancy/components/background/pixel-trail.tsx",
				deps: ["uuid"],
			},
			{
				id: "box-carousel",
				useWhen: "a 3D box-rotation carousel of images",
				editable: "full",
				signature: true,
				source: "src/fancy/components/carousel/box-carousel.tsx",
			},
			{
				id: "gooey-svg-filter",
				useWhen: "gooey blob merging for menus or chips",
				editable: "full",
				signature: true,
				source: "src/fancy/components/filter/gooey-svg-filter.tsx",
			},
			{
				id: "pixelate-svg-filter",
				useWhen: "a pixelation filter transition on an image",
				editable: "full",
				signature: true,
				source: "src/fancy/components/filter/pixelate-svg-filter.tsx",
			},
		],
	},
	{
		id: "motion-primitives",
		name: "Motion Primitives",
		tier: "vendored",
		licence: "MIT",
		repo: "ibelick/motion-primitives",
		pinnedSha: "92586e62a951eb9b6bfd1cc7c8a4e6e2ab6ba17d",
		useWhen: "Restrained, refined micro-interactions — the subtle end of the catalog.",
		baseDeps: ["motion"],
		components: [
			{
				id: "text-effect",
				useWhen: "copy entering with per-word/char animation presets",
				editable: "full",
				signature: false,
				source: "components/core/text-effect.tsx",
			},
			{
				id: "text-loop",
				useWhen: "a phrase cycling through alternatives in place",
				editable: "full",
				signature: false,
				source: "components/core/text-loop.tsx",
			},
			{
				id: "text-scramble",
				useWhen: "a subtle scramble-in for labels",
				editable: "full",
				signature: false,
				source: "components/core/text-scramble.tsx",
			},
			{
				id: "text-shimmer",
				useWhen: "a shimmer sweep across loading or accent text",
				editable: "full",
				signature: false,
				source: "components/core/text-shimmer.tsx",
			},
			{
				id: "animated-number",
				useWhen: "numbers easing between values (dashboards, prices)",
				editable: "full",
				signature: false,
				source: "components/core/animated-number.tsx",
			},
			{
				id: "border-trail",
				useWhen: "a small light travelling a container's border",
				editable: "full",
				signature: false,
				source: "components/core/border-trail.tsx",
			},
			{
				id: "infinite-slider",
				useWhen: "a seamless auto-scrolling strip (logos, tags)",
				editable: "full",
				signature: false,
				source: "components/core/infinite-slider.tsx",
				deps: ["react-use-measure"],
			},
			{
				id: "carousel",
				useWhen: "a swipeable carousel with indicators",
				editable: "full",
				signature: false,
				source: "components/core/carousel.tsx",
				deps: ["lucide-react"],
			},
			{
				id: "spotlight",
				useWhen: "a soft spotlight following the cursor over a card",
				editable: "full",
				signature: false,
				source: "components/core/spotlight.tsx",
			},
			{
				id: "magnetic",
				useWhen: "buttons that lean toward the cursor slightly",
				editable: "full",
				signature: false,
				source: "components/core/magnetic.tsx",
			},
			{
				id: "cursor",
				useWhen: "a custom cursor swap inside one section",
				editable: "full",
				signature: true,
				source: "components/core/cursor.tsx",
			},
		],
	},
	{
		id: "cult-ui",
		name: "cult/ui",
		tier: "vendored",
		licence: "MIT",
		repo: "nolly-studio/cult-ui",
		pinnedSha: "3b855612fb524cb042cc91b65f0cd575057471cc",
		useWhen: "Textured cards, dithered imagery and tactile buttons — the material slice.",
		baseDeps: ["framer-motion"],
		components: [
			{
				id: "texture-card",
				useWhen: "a card with layered tactile texture edges",
				editable: "full",
				signature: false,
				source: "apps/www/registry/default/ui/texture-card.tsx",
			},
			{
				id: "texture-button",
				useWhen: "a button with the same tactile treatment",
				editable: "full",
				signature: false,
				source: "apps/www/registry/default/ui/texture-button.tsx",
				deps: ["@radix-ui/react-slot", "class-variance-authority"],
			},
			{
				id: "text-animate",
				useWhen: "block copy animating in by words or lines",
				editable: "full",
				signature: false,
				source: "apps/www/registry/default/ui/text-animate.tsx",
				deps: ["motion"],
			},
			{
				id: "canvas-fractal-grid",
				useWhen: "a slow fractal dot grid backdrop",
				editable: "props-only",
				signature: true,
				source: "apps/www/registry/default/ui/canvas-fractal-grid.tsx",
				deps: ["motion"],
			},
			{
				id: "logo-carousel",
				useWhen: "a rotating carousel of customer logos",
				editable: "full",
				signature: false,
				source: "apps/www/registry/default/ui/logo-carousel.tsx",
				deps: ["motion"],
			},
			{
				id: "gradient-heading",
				useWhen: "a heading with a tuned gradient fill",
				editable: "full",
				signature: false,
				source: "apps/www/registry/default/ui/gradient-heading.tsx",
				deps: ["@radix-ui/react-slot", "class-variance-authority"],
			},
		],
	},
	{
		id: "animata",
		name: "Animata",
		tier: "vendored",
		licence: "MIT",
		repo: "codse/animata",
		pinnedSha: "de9aabb0eed14e0db944bb07720961ddc450c672",
		useWhen: "Small, copyable interaction pieces and hero experiments.",
		baseDeps: ["framer-motion"],
		components: [
			{
				id: "text-flip",
				useWhen: "a word flipping vertically through options",
				editable: "full",
				signature: false,
				source: "animata/text/text-flip.tsx",
			},
			{
				id: "hero-section-text-hover",
				useWhen: "a hero headline with hover-reactive imagery",
				editable: "full",
				signature: true,
				source: "animata/hero/hero-section-text-hover.tsx",
				deps: ["lucide-react"],
			},
			{
				id: "shape-shifter",
				useWhen: "a morphing blob shape as a hero focal point",
				editable: "props-only",
				signature: true,
				source: "animata/hero/shape-shifter.tsx",
			},
			{
				id: "blurry-blob",
				useWhen: "soft blurred colour blobs behind content",
				editable: "full",
				signature: true,
				source: "animata/background/blurry-blob.tsx",
			},
			{
				id: "shooting-stars",
				useWhen: "occasional shooting stars over a dark section",
				editable: "props-only",
				signature: true,
				source: "animata/background/shooting-stars.tsx",
			},
			{
				id: "card-stack",
				useWhen: "cards stacked and fanning on interaction",
				editable: "full",
				signature: false,
				source: "animata/card/card-stack.tsx",
				deps: ["motion"],
			},
		],
	},

	// ── registry tier (their own endpoint, fetched by Caret) ─────────────────
	{
		id: "ui-layouts",
		name: "ui-layouts",
		tier: "registry",
		licence: "MIT",
		repo: "ui-layouts/uilayouts",
		registryTemplate: "https://www.ui-layouts.com/r/{name}.json",
		useWhen: "Galleries, carousels and image interactions — the hardest slice to hand-roll.",
		components: [
			{
				id: "globe",
				useWhen: "an interactive dotted globe (cobe)",
				editable: "props-only",
				signature: true,
				source: "globe",
			},
			{
				id: "image-mousetrail",
				useWhen: "images trailing the cursor in a hero",
				editable: "props-only",
				signature: true,
				source: "image-mousetrail",
			},
			{ id: "carousel", useWhen: "a full-featured embla carousel", editable: "full", signature: false, source: "carousel" },
			{
				id: "gallery-modal",
				useWhen: "a grid gallery expanding into a modal viewer",
				editable: "full",
				signature: false,
				source: "gallery-modal",
			},
			{
				id: "image-masking",
				useWhen: "images clipped by shaped masks",
				editable: "full",
				signature: false,
				source: "image-masking",
			},
			{
				id: "text-marquee",
				useWhen: "oversized scrolling text banner",
				editable: "full",
				signature: false,
				source: "text-marquee",
			},
		],
	},
	{
		id: "kokonutui",
		name: "Kokonut UI",
		tier: "registry",
		licence: "MIT",
		repo: "kokonut-labs/kokonutui",
		registryTemplate: "https://kokonutui.com/r/{name}.json",
		useWhen: "Tailwind v4-native animated primitives.",
		components: [
			{
				id: "particle-button",
				useWhen: "a button bursting particles on success",
				editable: "full",
				signature: false,
				source: "particle-button",
			},
			{
				id: "glitch-text",
				useWhen: "a glitching heading for one bold moment",
				editable: "full",
				signature: true,
				source: "glitch-text",
			},
			{
				id: "matrix-text",
				useWhen: "matrix-style character rain text",
				editable: "full",
				signature: true,
				source: "matrix-text",
			},
			{
				id: "sliced-text",
				useWhen: "a heading sliced and offset for emphasis",
				editable: "full",
				signature: false,
				source: "sliced-text",
			},
			{
				id: "beams-background",
				useWhen: "soft moving light beams behind a section",
				editable: "props-only",
				signature: true,
				source: "beams-background",
			},
		],
	},
	{
		id: "smoothui",
		name: "SmoothUI",
		tier: "registry",
		licence: "MIT",
		repo: "educlopez/smoothui",
		registryTemplate: "https://smoothui.dev/r/{name}.json",
		useWhen: "Complete section blocks (FAQ, CTA, features) plus gentle micro-interactions.",
		components: [
			{ id: "faq-1", useWhen: "a complete FAQ section, typed props", editable: "full", signature: false, source: "faq-1" },
			{ id: "cta-1", useWhen: "a call-to-action section block", editable: "full", signature: false, source: "cta-1" },
			{
				id: "features-1",
				useWhen: "a features overview section block",
				editable: "full",
				signature: false,
				source: "features-1",
			},
			{ id: "footer-simple", useWhen: "a clean footer block", editable: "full", signature: false, source: "footer-simple" },
			{
				id: "scramble-hover",
				useWhen: "gentle scramble on nav links",
				editable: "full",
				signature: false,
				source: "scramble-hover",
			},
			{
				id: "photo-stack",
				useWhen: "a casual stack of photos that fans out",
				editable: "full",
				signature: false,
				source: "photo-stack",
			},
		],
	},
	{
		id: "eldoraui",
		name: "Eldora UI",
		tier: "registry",
		licence: "MIT",
		repo: "karthikmudunuri/eldoraui",
		registryTemplate: "https://www.eldoraui.site/r/{name}.json",
		useWhen: "Animated primitives overlapping Magic UI; useful when its registry has the exact piece.",
		components: [
			{
				id: "map",
				useWhen: "an animated dotted map with location markers",
				editable: "props-only",
				signature: true,
				source: "map",
			},
			{
				id: "scrollbasedvelocity",
				useWhen: "text whose scroll speed drives its motion",
				editable: "full",
				signature: false,
				source: "scrollbasedvelocity",
			},
		],
	},

	// ── cli tier ─────────────────────────────────────────────────────────────
	{
		id: "lightswind",
		name: "Lightswind",
		tier: "cli",
		licence: "MIT",
		repo: "codewithMUHILAN/Lightswind-UI-Library",
		useWhen:
			"The showpiece slice: 3D galleries and rings, ASCII waves, sparkle cursors. Young library — prefer others when equivalent.",
		components: [
			{
				id: "ascii-wave",
				useWhen: "an animated ASCII wave band",
				editable: "props-only",
				signature: true,
				source: "ascii-wave",
				deps: ["next-themes", "lightswind"],
			},
			{
				id: "3d-hover-gallery",
				useWhen: "a 3D gallery that tilts with the cursor",
				editable: "props-only",
				signature: true,
				source: "3d-hover-gallery",
				deps: ["lightswind"],
			},
			{
				id: "3d-image-ring",
				useWhen: "images arranged in a rotating 3D ring",
				editable: "props-only",
				signature: true,
				source: "3d-image-ring",
				deps: ["lightswind"],
			},
			{
				id: "sparkle-cursor",
				useWhen: "sparkles following the cursor",
				editable: "props-only",
				signature: true,
				source: "SparkleCursor",
				deps: ["lightswind"],
			},
		],
	},

	// ── npm tier (wrap-only) ─────────────────────────────────────────────────
	{
		id: "ldrs",
		name: "ldrs",
		tier: "npm",
		licence: "MIT",
		repo: "GriffinJohnston/ldrs",
		npmPackage: "ldrs",
		useWhen: "Loaders and spinners — 48 of them, colour/size/speed as props.",
		components: [
			{
				id: "ring",
				useWhen: "a clean ring spinner for loading states",
				editable: "props-only",
				signature: false,
				source: "Ring",
			},
			{
				id: "dot-wave",
				useWhen: "a dot-wave loader for inline waits",
				editable: "props-only",
				signature: false,
				source: "DotWave",
			},
			{
				id: "grid",
				useWhen: "a grid pulse loader for full-panel waits",
				editable: "props-only",
				signature: false,
				source: "Grid",
			},
		],
	},
	{
		id: "paper-shaders",
		name: "Paper Shaders",
		tier: "npm",
		licence: "Apache-2.0",
		repo: "paper-design/shaders",
		npmPackage: "@paper-design/shaders-react",
		useWhen: "Shader surfaces: mesh gradients, dithering, halftone, grain — colours bind to tokens via props.",
		components: [
			{
				id: "mesh-gradient",
				useWhen: "a slow-moving mesh gradient surface",
				editable: "props-only",
				signature: true,
				source: "MeshGradient",
			},
			{
				id: "dithering",
				useWhen: "a dithered texture backdrop",
				editable: "props-only",
				signature: true,
				source: "Dithering",
			},
			{
				id: "halftone-dots",
				useWhen: "a halftone dot treatment",
				editable: "props-only",
				signature: true,
				source: "HalftoneDots",
			},
			{
				id: "god-rays",
				useWhen: "volumetric god rays for one dark hero",
				editable: "props-only",
				signature: true,
				source: "GodRays",
			},
			{
				id: "grain-gradient",
				useWhen: "a grainy gradient wash",
				editable: "props-only",
				signature: true,
				source: "GrainGradient",
			},
		],
	},
	{
		id: "tsparticles",
		name: "tsParticles",
		tier: "npm",
		licence: "MIT",
		repo: "tsparticles/tsparticles",
		npmPackage: "@tsparticles/react",
		useWhen: "Configurable particles/confetti when Magic UI's particles aren't enough.",
		components: [
			{
				id: "particles",
				useWhen: "a fully configurable particle system",
				editable: "props-only",
				signature: true,
				source: "Particles",
				deps: ["@tsparticles/slim"],
			},
		],
	},
]

/** Directory (relative to `.caret/components/`) catalog installs land in. */
export const CATALOG_INSTALL_DIR = "catalog"

export function findCatalogLibrary(libraryId: string): CatalogLibrary | undefined {
	return CATALOG.find((library) => library.id === libraryId)
}

export function findCatalogComponent(
	libraryId: string,
	componentId: string,
): { library: CatalogLibrary; component: CatalogComponent } | undefined {
	const library = findCatalogLibrary(libraryId)
	const component = library?.components.find((entry) => entry.id === componentId)
	return library && component ? { library, component } : undefined
}

/**
 * The import path a page uses for an installed catalog component — relative
 * from `.caret/pages/<id>/index.tsx`. The rules advertise exactly this shape,
 * and the auto-supply scanner recognises exactly this shape.
 */
export function catalogImportPath(libraryId: string, componentId: string): string {
	return `../../components/${CATALOG_INSTALL_DIR}/${libraryId}/${componentId}`
}

/** Parses a catalog import back to (library, component), or null. */
export function parseCatalogImport(importSource: string): { libraryId: string; componentId: string } | null {
	const match = new RegExp(`components/${CATALOG_INSTALL_DIR}/([\\w-]+)/([\\w-]+)$`).exec(importSource)
	return match ? { libraryId: match[1], componentId: match[2] } : null
}
