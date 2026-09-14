export function dedent(strings: TemplateStringsArray, ...values: unknown[]): string {
	const result = strings.reduce((acc, str, i) => acc + str + (i < values.length ? String(values[i]) : ""), "")

	const lines = result.split("\n")

	// Remove leading/trailing empty lines
	while (lines.length > 0 && lines[0].trim() === "") lines.shift()
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()

	const minIndent = lines
		.filter((line) => line.trim().length > 0)
		.reduce((min, line) => {
			const match = line.match(/^(\t| )+/)
			return match ? Math.min(min, match[0].length) : 0
		}, Number.POSITIVE_INFINITY)

	if (minIndent === Number.POSITIVE_INFINITY || minIndent === 0) {
		return `${lines.join("\n")}\n`
	}

	return `${lines.map((line) => line.slice(minIndent)).join("\n")}\n`
}
