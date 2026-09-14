import * as fs from "fs/promises"
import * as path from "path"

import { Logger } from "@/shared/services/Logger"
import { runExclusive, writeFileAtomic } from "./file-mutation-queue"
import type { FlowDefinition } from "./types"

function flowsDirPath(workspacePath: string): string {
	return path.join(workspacePath, ".caret", "flows")
}

function isFileMissingError(err: unknown): boolean {
	return !!err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT"
}

async function readFlowFile(filePath: string): Promise<FlowDefinition | null> {
	let content: string
	try {
		content = await fs.readFile(filePath, "utf-8")
	} catch (err) {
		if (!isFileMissingError(err)) {
			Logger.warn(`[design] Failed to read flow file ${filePath}: ${err}`)
		}
		return null
	}
	try {
		return JSON.parse(content) as FlowDefinition
	} catch (err) {
		// A corrupt flow file is bad AI output or a torn write — never hide it.
		Logger.warn(`[design] Flow file ${filePath} is not valid JSON and will be ignored: ${err}`)
		return null
	}
}

async function writeFlowFile(filePath: string, flow: FlowDefinition): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await writeFileAtomic(filePath, JSON.stringify(flow, null, 2))
}

/**
 * Resolves the file that holds the flow with the given id. AI-written flows
 * sometimes have a filename that doesn't match their "id" field; the canvas
 * always sends the id, so fall back to scanning the flows dir for a file whose
 * parsed id matches instead of silently failing CRUD on those flows.
 */
export async function resolveFlowFile(workspacePath: string, flowId: string): Promise<string | null> {
	const flowsDir = flowsDirPath(workspacePath)
	const direct = path.join(flowsDir, `${flowId}.flow.json`)
	try {
		await fs.access(direct)
		return direct
	} catch {}
	let entries: string[]
	try {
		entries = (await fs.readdir(flowsDir)).filter((n) => n.endsWith(".flow.json"))
	} catch {
		return null
	}
	for (const name of entries) {
		const filePath = path.join(flowsDir, name)
		const flow = await readFlowFile(filePath)
		if (flow && flow.id === flowId) {
			Logger.warn(`[design] Flow id "${flowId}" lives in mismatched file ${name} — resolved by id scan`)
			return filePath
		}
	}
	return null
}

export async function readFlowDefinition(workspacePath: string, flowId: string): Promise<FlowDefinition | null> {
	const filePath = await resolveFlowFile(workspacePath, flowId)
	if (!filePath) return null
	return readFlowFile(filePath)
}

export async function writeFlowDefinition(workspacePath: string, flowId: string, flow: FlowDefinition): Promise<void> {
	const filePath =
		(await resolveFlowFile(workspacePath, flowId)) ?? path.join(flowsDirPath(workspacePath), `${flowId}.flow.json`)
	await writeFlowFile(filePath, flow)
}

/**
 * Serialized read-modify-write of a flow file. Concurrent mutations of the same
 * flow (e.g. rapid canvas edits) queue behind each other instead of racing —
 * unserialized concurrent writes have corrupted flow files.
 * Returns false if the flow doesn't exist (or its file is unreadable/corrupt).
 */
export async function mutateFlowDefinition(
	workspacePath: string,
	flowId: string,
	mutate: (flow: FlowDefinition) => void,
): Promise<boolean> {
	const filePath = await resolveFlowFile(workspacePath, flowId)
	if (!filePath) return false
	return runExclusive(filePath, async () => {
		const flow = await readFlowFile(filePath)
		if (!flow) {
			return false
		}
		mutate(flow)
		await writeFlowFile(filePath, flow)
		return true
	})
}

export async function listFlows(workspacePath: string): Promise<FlowDefinition[]> {
	const flowsDir = flowsDirPath(workspacePath)
	try {
		const entries = await fs.readdir(flowsDir, { withFileTypes: true })
		const flows: FlowDefinition[] = []

		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".flow.json")) continue
			const flow = await readFlowFile(path.join(flowsDir, entry.name))
			if (flow) {
				flows.push(flow)
			}
		}
		return flows
	} catch {
		return []
	}
}

export function validateFlowDefinition(obj: unknown): obj is FlowDefinition {
	if (!obj || typeof obj !== "object") return false
	const flow = obj as Record<string, unknown>
	if (typeof flow.id !== "string") return false
	if (typeof flow.name !== "string") return false
	if (!Array.isArray(flow.steps)) return false
	for (const step of flow.steps) {
		if (!step || typeof step !== "object") return false
		if (typeof step.page !== "string") return false
		if (!Array.isArray(step.next)) return false
		if (step.onError !== undefined && !Array.isArray(step.onError)) return false
	}
	return true
}
