/**
 * Where everything sits on a take board. Pure, so it can be tested on its own.
 *
 * Each branch is a column of its takes, kept together so they can be compared.
 * A branch grown from a take sits one column to the right of the branch that
 * take belongs to, as level with that take as the column allows, and lower
 * when an earlier branch is in the way. Its line starts on the right edge of
 * the exact take it grew from and ends at its first take, so it can slope but
 * never has to cross a picture: every picture in a column sits inside its
 * branch's box, and lines only run in the gaps between columns.
 */

export interface LayoutBranch {
	id: string
	parentTakeId: string | null
	takeIds: string[]
}

export interface LayoutSizes {
	/** Width and height of one take's picture. */
	takeWidth: number
	takeHeight: number
	/** Space above each take for its caption. */
	caption: number
	/** Inside padding of a branch's box, and the room for its label at the top. */
	pad: number
	label: number
	/** Gap between takes, and between boxes in one column. */
	gap: number
	/** Gap between columns, where the lines run. */
	column: number
}

export const DEFAULT_SIZES: LayoutSizes = { takeWidth: 200, takeHeight: 133, caption: 0, pad: 12, label: 24, gap: 10, column: 96 }

export interface PlacedTake {
	id: string
	x: number
	y: number
}

export interface PlacedBranch {
	id: string
	x: number
	y: number
	width: number
	height: number
	takes: PlacedTake[]
}

export interface BoardLine {
	branchId: string
	from: { x: number; y: number }
	to: { x: number; y: number }
}

export interface BoardLayout {
	branches: PlacedBranch[]
	lines: BoardLine[]
	width: number
	height: number
}

export function layoutBoard(input: LayoutBranch[], sizes: LayoutSizes = DEFAULT_SIZES, origin = { x: 20, y: 16 }): BoardLayout {
	const { takeWidth, takeHeight, caption, pad, label, gap, column } = sizes
	const slot = caption + takeHeight
	const boxWidth = takeWidth + pad * 2
	const placed: PlacedBranch[] = []
	const byId = new Map<string, PlacedBranch>()
	/** The lowest point used so far in each column, keyed by x. */
	const columnFloor = new Map<number, number>()

	const childrenOf = (takeId: string) => input.filter((branch) => branch.parentTakeId === takeId)

	const place = (branch: LayoutBranch, x: number, wantedY: number): void => {
		const y = Math.max(wantedY, columnFloor.get(x) ?? origin.y)
		const takes = branch.takeIds.map((id, index) => ({ id, x: x + pad, y: y + label + pad + index * (slot + gap) }))
		const height = label + pad + Math.max(1, takes.length) * (slot + gap) - gap + pad
		const box: PlacedBranch = { id: branch.id, x, y, width: boxWidth, height, takes }
		placed.push(box)
		byId.set(branch.id, box)
		columnFloor.set(x, y + height + gap * 2)
		const next = x + boxWidth + column
		for (const take of takes) {
			for (const child of childrenOf(take.id)) {
				// Level with the parent take: the child's first take on the same row.
				place(child, next, take.y - label - pad)
			}
		}
	}

	for (const root of input.filter((branch) => branch.parentTakeId === null)) {
		place(root, origin.x, columnFloor.get(origin.x) ?? origin.y)
	}

	const takeAt = new Map<string, PlacedTake>()
	for (const box of placed) for (const take of box.takes) takeAt.set(take.id, take)

	const lines: BoardLine[] = []
	for (const branch of input) {
		if (!branch.parentTakeId) continue
		const from = takeAt.get(branch.parentTakeId)
		const box = byId.get(branch.id)
		if (!from || !box || box.takes.length === 0) continue
		const first = box.takes[0]
		lines.push({
			branchId: branch.id,
			from: { x: from.x + takeWidth, y: from.y + caption + takeHeight / 2 },
			to: { x: first.x, y: first.y + caption + takeHeight / 2 },
		})
	}

	const width = Math.max(0, ...placed.map((box) => box.x + box.width)) + origin.x
	const height = Math.max(0, ...placed.map((box) => box.y + box.height)) + origin.y
	return { branches: placed, lines, width, height }
}

/** The branches from the first takes down to the one holding `takeId`, oldest first. */
export function pathTo(input: LayoutBranch[], takeId: string): Array<{ branch: LayoutBranch; takeId: string }> {
	const branchOf = (id: string) => input.find((branch) => branch.takeIds.includes(id))
	const path: Array<{ branch: LayoutBranch; takeId: string }> = []
	let current: string | null = takeId
	const seen = new Set<string>()
	while (current && !seen.has(current)) {
		seen.add(current)
		const branch = branchOf(current)
		if (!branch) break
		path.unshift({ branch, takeId: current })
		current = branch.parentTakeId
	}
	return path
}

/** Each branch's colour: grey for the first takes, then a fixed cycle. */
export const BRANCH_COLOURS = ["#3b82f6", "#f59e0b", "#10b981", "#ec4899", "#a78bfa", "#06b6d4"]
export function branchColour(input: LayoutBranch[], branchId: string): string {
	const branches = input.filter((branch) => branch.parentTakeId !== null)
	const index = branches.findIndex((branch) => branch.id === branchId)
	return index < 0 ? "#8b93a7" : BRANCH_COLOURS[index % BRANCH_COLOURS.length]
}
