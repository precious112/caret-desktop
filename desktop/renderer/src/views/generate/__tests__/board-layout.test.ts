import { strict as assert } from "assert"
import { describe, it } from "mocha"

import { DEFAULT_SIZES, type LayoutBranch, layoutBoard, pathTo } from "../board-layout"

const first: LayoutBranch = { id: "b1", parentTakeId: null, takeIds: ["t1", "t2", "t3", "t4"] }

/** Two boxes overlap when their rectangles intersect. */
function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
	return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/** Where a straight line between two points crosses a vertical band (a column of pictures). */
function crossesBand(line: { from: { x: number }; to: { x: number } }, left: number, right: number): boolean {
	return Math.min(line.from.x, line.to.x) < right && Math.max(line.from.x, line.to.x) > left
}

describe("the take board's layout", () => {
	it("keeps the first takes together, in one column, in order", () => {
		const layout = layoutBoard([first])
		const box = layout.branches[0]
		assert.deepEqual(
			box.takes.map((take) => take.id),
			["t1", "t2", "t3", "t4"],
		)
		const ys = box.takes.map((take) => take.y)
		assert.ok(
			ys.every((y, i) => i === 0 || y > ys[i - 1]),
			"takes go down the column",
		)
		assert.ok(
			box.takes.every((take) => take.x === box.takes[0].x),
			"takes share one column",
		)
		assert.equal(layout.lines.length, 0)
	})

	it("starts each line on the exact take it grew from, and ends it at the branch's first take", () => {
		const branches: LayoutBranch[] = [
			first,
			{ id: "b2", parentTakeId: "t1", takeIds: ["t5", "t6"] },
			{ id: "b3", parentTakeId: "t4", takeIds: ["t7", "t8"] },
			{ id: "b4", parentTakeId: "t1", takeIds: ["t9", "t10"] },
		]
		const layout = layoutBoard(branches)
		const take = (id: string) => layout.branches.flatMap((box) => box.takes).find((t) => t.id === id)!
		for (const line of layout.lines) {
			const branch = branches.find((b) => b.id === line.branchId)!
			const parent = take(branch.parentTakeId!)
			assert.equal(line.from.x, parent.x + DEFAULT_SIZES.takeWidth, `${branch.id} starts on the right edge of its parent`)
			assert.equal(
				line.from.y,
				parent.y + DEFAULT_SIZES.takeHeight / 2,
				`${branch.id} starts level with the middle of its parent`,
			)
			const firstOfBranch = take(branch.takeIds[0])
			assert.equal(line.to.x, firstOfBranch.x)
			assert.ok(line.to.x > line.from.x, "lines run left to right")
		}
		// t1's first branch sits level with t1.
		const b2 = layout.branches.find((box) => box.id === "b2")!
		assert.equal(b2.takes[0].y, take("t1").y)
	})

	it("never overlaps two boxes, however many branches grow", () => {
		const branches: LayoutBranch[] = [first]
		let n = 5
		// Every take of the first round grows two branches, and one of those grows two more.
		for (const parent of ["t1", "t2", "t3", "t4", "t1", "t3"]) {
			branches.push({ id: `b${branches.length + 1}`, parentTakeId: parent, takeIds: [`t${n++}`, `t${n++}`] })
		}
		branches.push({ id: "deep1", parentTakeId: "t5", takeIds: [`t${n++}`, `t${n++}`] })
		branches.push({ id: "deep2", parentTakeId: "t5", takeIds: [`t${n++}`, `t${n++}`] })
		const layout = layoutBoard(branches)
		assert.equal(layout.branches.length, branches.length, "every branch is placed")
		for (let i = 0; i < layout.branches.length; i++) {
			for (let j = i + 1; j < layout.branches.length; j++) {
				assert.ok(
					!overlaps(layout.branches[i], layout.branches[j]),
					`${layout.branches[i].id} overlaps ${layout.branches[j].id}`,
				)
			}
		}
		// No line crosses a column of pictures: it only runs between its own two columns.
		for (const line of layout.lines) {
			for (const box of layout.branches) {
				const inside = { left: box.x + DEFAULT_SIZES.pad, right: box.x + DEFAULT_SIZES.pad + DEFAULT_SIZES.takeWidth }
				const crosses = crossesBand(line, inside.left + 1, inside.right - 1)
				assert.ok(!crosses, `line to ${line.branchId} crosses the pictures of ${box.id}`)
			}
		}
		assert.ok(layout.width > 0 && layout.height > 0)
	})

	it("walks the path from the first takes to any take", () => {
		const branches: LayoutBranch[] = [
			first,
			{ id: "b2", parentTakeId: "t3", takeIds: ["t5", "t6"] },
			{ id: "b3", parentTakeId: "t6", takeIds: ["t7", "t8"] },
		]
		assert.deepEqual(
			pathTo(branches, "t8").map((step) => `${step.branch.id}:${step.takeId}`),
			["b1:t3", "b2:t6", "b3:t8"],
		)
		assert.deepEqual(
			pathTo(branches, "t2").map((step) => step.takeId),
			["t2"],
		)
		assert.deepEqual(pathTo(branches, "nope"), [])
	})
})
