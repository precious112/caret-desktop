/**
 * shadcn-style registries the shadcn library searches, and the installer
 * fetches from. One list for both, so whatever the AI can find, Caret can
 * install.
 */
export const REGISTRIES: Record<string, string> = {
	"@shadcn": "https://ui.shadcn.com/r/styles/new-york-v4/{name}.json",
	"@magicui": "https://magicui.design/r/{name}.json",
	"@aceternity": "https://ui.aceternity.com/registry/{name}.json",
	"@smoothui": "https://smoothui.dev/r/{name}.json",
	"@kokonutui": "https://kokonutui.com/r/{name}.json",
}
