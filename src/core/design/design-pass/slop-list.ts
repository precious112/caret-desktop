/**
 * The slop list: habits people keep reporting in AI-made designs, and the
 * levels their report counts put them at.
 *
 * The data file is compiled during development by `scripts/slop-list/build.ts`
 * and ships inside Caret updates; there is no live download, so every version
 * behaves predictably.
 */
import data from "./slop-list.json"

export interface Habit {
	id: string
	name: string
	/** Independent sources that reported it. */
	sources: number
	kinds: string[]
	/** The sources' own names for it. Empty when only code can check it (exact values). */
	terms: string[]
	description: string
	/** Reported exact colours (hex). */
	colours: string[]
	/** Reported font family names. */
	fonts: string[]
	/** A corner-radius habit: an approved foundation radius exempts it. */
	radius: boolean
	/** A pattern with only a few sensible options (a centred hero): never a slop sign. */
	fewOptions: boolean
}

export const HABITS: readonly Habit[] = data.habits as Habit[]
export const ENTRY_COUNT: number = data.entries

const BY_ID = new Map(HABITS.map((habit) => [habit.id, habit]))

export function habitById(id: string): Habit | undefined {
	return BY_ID.get(id)
}

/** Reported by this many sources or more: banned on every page, no debate. */
export const BAN = 10
/** Reported by this many: banned when it shows up in two or more sections. */
export const BAN_IF_REPEATED = 7
/** Fewer than this many sources: too weak to act on, ignored entirely. */
export const FLOOR = 3

/**
 * 1 banned · 2 banned because repeated · 3 must be defended.
 * (Level 0, the user's own choice, is decided before this is asked.)
 */
export type Level = 0 | 1 | 2 | 3

export function levelOf(sources: number, sectionsSeen: number): 1 | 2 | 3 {
	if (sources >= BAN) return 1
	if (sources >= BAN_IF_REPEATED && sectionsSeen >= 2) return 2
	return 3
}

/** The habits strong enough to check at all. */
export function activeHabits(): Habit[] {
	return HABITS.filter((habit) => habit.sources >= FLOOR && !habit.fewOptions)
}

/** Banned on every page: the list every rewrite and build is told never to use. */
export function bannedHabitNames(): string[] {
	return HABITS.filter((habit) => habit.sources >= BAN).map((habit) => habit.name)
}

/**
 * The list as the checker reads it: one line per habit, in the sources' own
 * words. Habits that are only exact values are left out — code checks those.
 */
export function habitsText(): string {
	return activeHabits()
		.filter((habit) => habit.terms.length > 0)
		.map((habit) => `[${habit.id}] ${habit.terms.join(" / ")}. ${habit.description}`.trim())
		.join("\n")
}
