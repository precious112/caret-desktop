export const WIZARD_STEPS = [
	{
		id: "vibe",
		title: "Vibe",
		description: "Describe the overall feel and personality of your design system.",
	},
	{
		id: "color",
		title: "Color",
		description: "Set your brand color and generate a full palette.",
	},
	{
		id: "typography",
		title: "Typography",
		description: "Choose your typeface and configure the type scale.",
	},
	{
		id: "spacing",
		title: "Spacing",
		description: "Define your spacing base unit and scale.",
	},
	{
		id: "radius",
		title: "Radius",
		description: "Set the corner rounding character for your design.",
	},
	{
		id: "depth",
		title: "Depth",
		description: "How much shadow the interface has, and its hairlines.",
	},
	{
		id: "review",
		title: "Review",
		description: "Review your foundation tokens before saving.",
	},
] as const

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"]

/**
 * The full tag vocabulary the foundation library recognises — kept in lockstep
 * with `LIBRARY_TAGS` (a unit test pins the two together). This was an
 * eight-entry subset for months, which quietly made the manual door the
 * COARSER one: tags drive asset-recipe narrowing and motion derivation, and
 * the person who chose "handle everything yourself" could express less than
 * the interview could. Found during the Fold manual-lane run.
 */
export const VIBE_TAGS = [
	"agency",
	"blog",
	"bold",
	"calm",
	"clean",
	"considered",
	"consumer",
	"content",
	"craft",
	"creative",
	"crypto",
	"dark",
	"dashboard",
	"data",
	"dense",
	"developer",
	"documentation",
	"editorial",
	"enterprise",
	"expressive",
	"fintech",
	"flexible",
	"friendly",
	"geometric",
	"government",
	"healthcare",
	"human",
	"internal",
	"launch",
	"loud",
	"marketing",
	"minimal",
	"mobile",
	"modern",
	"neutral",
	"organic",
	"playful",
	"precise",
	"premium",
	"product",
	"publishing",
	"reading",
	"retro",
	"saas",
	"serious",
	"startup",
	"technical",
	"trustworthy",
	"unusual",
	"utility",
	"warm",
	"wellness",
] as const

export const NEUTRAL_CHARACTERS = ["cool", "warm", "true", "slight-tint"] as const
export type NeutralCharacter = (typeof NEUTRAL_CHARACTERS)[number]

export const RADIUS_CHARACTERS = ["sharp", "soft", "round", "pill"] as const
export type RadiusCharacter = (typeof RADIUS_CHARACTERS)[number]

export const ELEVATION_CHARACTERS = ["flat", "subtle", "pronounced"] as const
export type ElevationCharacter = (typeof ELEVATION_CHARACTERS)[number]

export const TYPE_SCALE_RATIOS = [
	{ label: "Minor Second (1.067)", value: 1.067 },
	{ label: "Major Second (1.125)", value: 1.125 },
	{ label: "Minor Third (1.2)", value: 1.2 },
	{ label: "Major Third (1.25)", value: 1.25 },
	{ label: "Perfect Fourth (1.333)", value: 1.333 },
	{ label: "Augmented Fourth (1.414)", value: 1.414 },
	{ label: "Perfect Fifth (1.5)", value: 1.5 },
] as const
