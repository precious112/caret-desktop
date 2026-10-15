/**
 * `npm run test:interview`: every interview test, in one command.
 *
 * Runs the logic tests and then the real-app tests (with recorded model
 * answers), always both, so one failing never hides the other. Exits with a
 * failure if either fails. Needs no model and spends no tokens.
 *
 * The app must be built first; the npm script does that.
 */
import { spawnSync } from "child_process"

function run(label: string, command: string, args: string[]): boolean {
	console.log(`\n=== ${label} ===`)
	const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" })
	return result.status === 0
}

const logic = run("logic tests", "npx", ["mocha", "--config", ".mocharc.interview.json"])
const app = run("real-app tests (recorded model answers)", "npx", [
	"tsx",
	"scripts/verify-interview.ts",
	...process.argv.slice(2),
])

console.log(`\nlogic tests: ${logic ? "PASS" : "FAIL"}`)
console.log(`real-app tests: ${app ? "PASS" : "FAIL"}`)
process.exitCode = logic && app ? 0 : 1
