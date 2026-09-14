/**
 * What the model says, rendered.
 *
 * The chat used to print the assistant's text with `whitespace-pre-wrap`, so
 * `**bold**`, fences and pipe tables arrived on screen as literal characters —
 * the model was writing to a reader that didn't exist.
 *
 * Three constraints shape everything below, and none of them is decoration:
 *
 * 1. **380px, fixed.** Code and tables do not fit and never will, so both scroll
 *    sideways inside their own box rather than wrapping. Wrapped code is
 *    unreadable and a wrapped table stops being a table.
 * 2. **Colour is reserved.** The shell frames the user's design work, and a
 *    second palette a few hundred pixels from the canvas makes their own colours
 *    hard to judge. Code is monospace on one quiet surface, not syntax-tinted.
 * 3. **Text arrives a token at a time**, so the markdown is *usually invalid*
 *    while it streams — see {@link closeOpenFence}.
 *
 * Raw HTML is deliberately not parsed: `react-markdown` ignores it unless
 * `rehype-raw` is added, and this text comes from a model reading a codebase.
 * Links are safe for the same reason plus `main/index.ts`'s `will-navigate`
 * guard, which sends anything non-local to the OS browser instead of navigating
 * the window that has a preload attached.
 */

import { Check, Copy } from "lucide-react"
import { memo, useMemo, useState } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"

import { cn } from "../lib/utils"
import { assetTagFromHref, remarkAssetTags } from "./asset-tags"

/**
 * Closes a fence the model hasn't finished typing.
 *
 * A turn streams in as text, which means for most of its life the markdown is
 * *invalid*: "```tsx\nexport" is an unterminated fence. Parsed as-is, the fence
 * markers show up as literal backticks until the closing fence lands, and then
 * the whole block snaps into a box — the code visibly flickers as it arrives.
 * Adding the closing fence to the string we hand the parser (never to the text
 * we keep) makes the block appear immediately and grow line by line.
 *
 * Counting fences is enough: an odd count means exactly one is open, because a
 * fence can't nest.
 */
export function closeOpenFence(text: string): string {
	let fences = 0
	for (const line of text.split("\n")) if (line.startsWith("```")) fences += 1
	return fences % 2 === 1 ? `${text}\n\`\`\`` : text
}

/**
 * A fenced block: language, copy, and a body that scrolls rather than wraps.
 *
 * Copy is always visible rather than revealed on hover — hover-only controls are
 * invisible to anyone who doesn't already know they're there, and this is the
 * one thing people actually want from a code block in a chat.
 */
function CodeBlock({ language, code }: { language: string | null; code: string }) {
	const [copied, setCopied] = useState(false)

	function copy() {
		void navigator.clipboard.writeText(code).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1400)
		})
	}

	return (
		<div className="my-2 overflow-hidden rounded-lg bg-white/[0.04]">
			<div className="flex items-center justify-between border-b border-white/[0.06] px-2.5 py-1">
				<span className="text-[10.5px] text-shell-muted">{language ?? "code"}</span>
				<button
					className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-shell-muted transition-colors hover:bg-white/[0.06] hover:text-shell-text"
					onClick={copy}
					title="Copy code"
					type="button">
					{copied ? <Check size={11} /> : <Copy size={11} />}
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
			{/* Horizontal scroll, never wrap: a wrapped line of code lies about its
			    own structure, and indentation is most of how code is read. */}
			<pre className="overflow-x-auto px-2.5 py-2">
				<code className="font-mono text-[11.5px] leading-relaxed whitespace-pre">{code}</code>
			</pre>
		</div>
	)
}

/**
 * Tables keep real columns and scroll when they overflow.
 *
 * Stacking each row into a card was the alternative and it fits without
 * scrolling, but a table exists so values can be compared down a column, and
 * stacking destroys exactly that.
 */
function Table({ children }: { children?: React.ReactNode }) {
	return (
		<div className="my-2 overflow-x-auto">
			<table className="w-full border-collapse text-[11.5px]">{children}</table>
		</div>
	)
}

const COMPONENTS: Components = {
	/**
	 * Fenced blocks are detected here rather than on `code`.
	 *
	 * The obvious test — does the `code` element carry a `language-*` class —
	 * misses a fence written without a language, and a single-line one then falls
	 * through to the inline branch and renders as a pill. Every fence produces a
	 * `pre`, with or without a language, so the wrapper is the reliable signal and
	 * the syntax the user typed decides the treatment.
	 */
	pre({ node }) {
		const child = node?.children?.[0]
		const element = child?.type === "element" && child.tagName === "code" ? child : null
		const text = element ? collectText(element).replace(/\n$/, "") : ""
		const className = Array.isArray(element?.properties?.className) ? element.properties.className.join(" ") : ""
		return <CodeBlock code={text} language={/language-(\w+)/.exec(className)?.[1] ?? null} />
	},

	// Only inline spans reach this now; fenced blocks are consumed by `pre`.
	// `box-decoration-clone` so a span that wraps in a 380px column gets its
	// padding and rounding on *both* fragments instead of one ragged pill.
	code: ({ children, ...props }) => (
		<code className="box-decoration-clone rounded bg-white/[0.07] px-1 py-0.5 font-mono text-[11.5px]" {...props}>
			{children}
		</code>
	),

	p: ({ children }) => <p className="my-1.5 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
	strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
	em: ({ children }) => <em className="italic">{children}</em>,
	del: ({ children }) => <del className="text-shell-muted line-through">{children}</del>,

	// Headings barely step up in size. In a 380px column a real type scale reads
	// as shouting, so the weight and colour carry the hierarchy instead.
	h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-[13px] font-semibold first:mt-0">{children}</h1>,
	h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-[12.5px] font-semibold first:mt-0">{children}</h2>,
	h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-[12px] font-semibold first:mt-0">{children}</h3>,
	h4: ({ children }) => <h4 className="mt-2.5 mb-1 text-[12px] font-medium first:mt-0">{children}</h4>,

	ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-4 marker:text-shell-muted">{children}</ul>,
	ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-4 marker:text-shell-muted">{children}</ol>,

	// A task-list item drops its bullet: the box is the marker, and showing both
	// reads as two markers for one item.
	li: ({ children, className }) => (
		<li className={cn("leading-relaxed", className?.includes("task-list-item") && "list-none")}>{children}</li>
	),

	/**
	 * The only `input` markdown can produce is a task-list checkbox, and the
	 * native control is an OS widget — it ignores the theme, sits on its own
	 * baseline, and looks borrowed. Drawn instead, in the shell's own language.
	 */
	input: ({ checked, type }) =>
		type === "checkbox" ? (
			<span
				className={cn(
					"relative -ml-4 mr-1.5 inline-block size-[11px] shrink-0 translate-y-[1px] rounded-[3px] border",
					checked ? "border-caret-accent/70 bg-caret-accent/25" : "border-shell-muted/50",
				)}>
				{checked && <Check className="absolute -top-px -left-px text-caret-accent" size={11} strokeWidth={3} />}
			</span>
		) : null,

	blockquote: ({ children }) => (
		<blockquote className="my-2 border-l-2 border-shell-border pl-3 text-shell-muted">{children}</blockquote>
	),
	hr: () => <hr className="my-3 border-shell-border" />,

	a: ({ children, href }) => <Anchor href={href}>{children}</Anchor>,

	table: ({ children }) => <Table>{children}</Table>,
	thead: ({ children }) => <thead>{children}</thead>,
	th: ({ children }) => (
		<th className="border-b border-shell-border px-2 py-1 text-left font-medium whitespace-nowrap text-shell-muted">
			{children}
		</th>
	),
	td: ({ children }) => <td className="px-2 py-1 align-top whitespace-nowrap">{children}</td>,

	// Images would load remote bytes into the shell on the model's say-so, and a
	// broken-image icon is not worth that. The alt text says what was meant.
	img: ({ alt }) => <span className="text-shell-muted italic">{alt ? `[image: ${alt}]` : "[image]"}</span>,
}

function Anchor({ children, href }: { children?: React.ReactNode; href?: string }) {
	return (
		// Opened by the main process' navigation guard, in the OS browser.
		<a className="text-caret-accent underline underline-offset-2 hover:text-caret-accent-hover" href={href}>
			{children}
		</a>
	)
}

/** A hast element's text, including through nested spans. */
function collectText(node: { type?: string; value?: string; children?: unknown[] }): string {
	if (node.type === "text") return node.value ?? ""
	if (!Array.isArray(node.children)) return ""
	return node.children.map((child) => collectText(child as Parameters<typeof collectText>[0])).join("")
}

type Plugins = React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]

const PLUGINS: Plugins = [remarkGfm]

/**
 * Memoised on the text: the transcript re-renders on every streamed chunk, and
 * re-parsing every earlier message each time is what makes a chat panel judder.
 * The tag props must therefore be *stable* at the call site — a Set or handler
 * rebuilt per render silently turns the memo off.
 */
export const Markdown = memo(function Markdown({
	text,
	className,
	assetTags,
	onAssetTag,
}: {
	text: string
	className?: string
	/** Tags that exist in the library; `@tag` tokens matching one become clickable. */
	assetTags?: ReadonlySet<string>
	onAssetTag?(tag: string): void
}) {
	const plugins = useMemo(
		(): Plugins => (assetTags && assetTags.size > 0 ? [remarkGfm, [remarkAssetTags, assetTags]] : PLUGINS),
		[assetTags],
	)

	// Tag references arrive as `#asset-tag:` links; everything else keeps the
	// stock anchor and its navigation-guard behaviour.
	const components = useMemo((): Components => {
		if (!onAssetTag) return COMPONENTS
		return {
			...COMPONENTS,
			a: ({ children, href }) => {
				const tag = assetTagFromHref(href)
				if (!tag) return <Anchor href={href}>{children}</Anchor>
				return (
					<button
						className="text-caret-accent transition-colors hover:text-caret-accent-hover"
						data-testid="chat-asset-tag"
						onClick={() => onAssetTag(tag)}
						type="button">
						{children}
					</button>
				)
			},
		}
	}, [onAssetTag])

	return (
		<div className={cn("min-w-0", className)}>
			<ReactMarkdown components={components} remarkPlugins={plugins}>
				{closeOpenFence(text)}
			</ReactMarkdown>
		</div>
	)
})
