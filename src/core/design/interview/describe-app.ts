import { detectAppProfile } from "../app-profile"

/**
 * What Caret detected, as the "Use what my app already has" interview's
 * starting context. A head start for the model's reading, never a substitute
 * for it: the detector reads no values.
 */
export async function describeApp(projectPath: string): Promise<string> {
	const profile = await detectAppProfile(projectPath)
	if (!profile) return "No app code was detected in this folder. Read whatever is there."
	return [
		`Framework: ${profile.framework ?? "not named in package.json"}.`,
		`Styling: ${profile.styling.length ? profile.styling.join(", ") : "nothing recognised by name; likely plain CSS or inline styles"}.`,
		profile.styleSources.length
			? `Files that probably declare the look (start here, but they are not the whole story): ${profile.styleSources.join(", ")}.`
			: "No config or variables file was found. Read the stylesheets and components themselves.",
	].join("\n")
}
